// Command signer is the M5/M6 signing service. It exposes keyless digest endpoints
// (/healthz, /v1/digest/l1) plus a keystore-backed L1 signing endpoint (/v1/sign/l1)
// gated by the reject-first policy (Evaluate) then the single-writer authority
// (fence + daily notional cap + monotonic nonce, atomically). The shipped binary
// starts with an EMPTY keystore (fail-closed) and, by default, an in-memory
// single-writer + an always-leader fencer (single instance); wiring a leased
// cross-host single-writer is a later slice (docs/BACKEND-ARCHITECTURE.md §5.1a/§6.2).
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/hlinfo"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/leader"
	leasepg "github.com/lumos-forge/hypersolid/backend/internal/lease/pg"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	ledgerpg "github.com/lumos-forge/hypersolid/backend/internal/ledger/pg"
	"github.com/lumos-forge/hypersolid/backend/internal/logging"
	"github.com/lumos-forge/hypersolid/backend/internal/metrics"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
	"github.com/lumos-forge/hypersolid/backend/internal/ratelimit"
	"github.com/lumos-forge/hypersolid/backend/internal/reconciler"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
	"github.com/lumos-forge/hypersolid/backend/internal/tracing"
)

type digestL1Request struct {
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Nonce     uint64          `json:"nonce"`
	IsTestnet bool            `json:"isTestnet"`
}

type digestL1Response struct {
	ActionHash  string `json:"actionHash"`
	AgentDigest string `json:"agentDigest"`
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func handleDigestL1(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req digestL1Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	ah, ad, err := hl.DigestL1(req.Kind, req.Params, req.Nonce, req.IsTestnet)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(digestL1Response{
		ActionHash:  "0x" + hex.EncodeToString(ah[:]),
		AgentDigest: "0x" + hex.EncodeToString(ad[:]),
	})
}

type signL1Request struct {
	KeyID     string          `json:"keyId"`
	Cloid     string          `json:"cloid"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	IsTestnet bool            `json:"isTestnet"`
}

type signL1Response struct {
	R         string `json:"r"`
	S         string `json:"s"`
	V         int    `json:"v"`
	Nonce     uint64 `json:"nonce"`
	Duplicate bool   `json:"duplicate"`
}

// orderNotional computes px*sz from an order tuple's string fields; any parse
// failure yields NaN so the policy fails closed.
// orderNotional computes px*sz from an order tuple's string fields. It fails
// closed (NaN) if either field is unparseable, NaN, or negative — so a negative
// px/sz can neither slip past the cap nor (via two negatives / a masking batch
// leg) produce a bogus positive notional.
func orderNotional(px, sz string) float64 {
	pxF, errP := strconv.ParseFloat(px, 64)
	szF, errS := strconv.ParseFloat(sz, 64)
	if errP != nil || errS != nil || math.IsNaN(pxF) || math.IsNaN(szF) || pxF < 0 || szF < 0 {
		return math.NaN()
	}
	return pxF * szF
}

// intentFor derives the policy Intent from a sign request's kind + params. All
// order-carrying kinds (order, modify, batchModify) contribute their px*sz
// notional so the cap covers them; a malformed px/sz yields NaN (fail-closed).
// Non-order-carrying kinds are non-notional.
func intentFor(kind string, params json.RawMessage) policy.Intent {
	switch kind {
	case "order":
		var p struct {
			Asset   int64  `json:"asset"`
			Px      string `json:"px"`
			LimitPx string `json:"limitPx"`
			Sz      string `json:"sz"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return policy.Intent{Kind: kind, NotionalUsdc: math.NaN()}
		}
		if p.Px == "" {
			p.Px = p.LimitPx
		}
		return policy.Intent{Kind: kind, Coin: strconv.FormatInt(p.Asset, 10), NotionalUsdc: orderNotional(p.Px, p.Sz)}
	case "modify":
		var p struct {
			Order struct {
				Asset   int64  `json:"asset"`
				Px      string `json:"px"`
				LimitPx string `json:"limitPx"`
				Sz      string `json:"sz"`
			} `json:"order"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return policy.Intent{Kind: kind, NotionalUsdc: math.NaN()}
		}
		if p.Order.Px == "" {
			p.Order.Px = p.Order.LimitPx
		}
		return policy.Intent{Kind: kind, Coin: strconv.FormatInt(p.Order.Asset, 10), NotionalUsdc: orderNotional(p.Order.Px, p.Order.Sz)}
	case "batchModify":
		var p struct {
			Modifies []struct {
				Order struct {
					Px      string `json:"px"`
					LimitPx string `json:"limitPx"`
					Sz      string `json:"sz"`
				} `json:"order"`
			} `json:"modifies"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return policy.Intent{Kind: kind, NotionalUsdc: math.NaN()}
		}
		total := 0.0
		for _, m := range p.Modifies {
			px := m.Order.Px
			if px == "" {
				px = m.Order.LimitPx
			}
			total += orderNotional(px, m.Order.Sz)
		}
		// Multiple assets possible → leave Coin "" so only the global cap applies.
		return policy.Intent{Kind: kind, NotionalUsdc: total}
	case "twapOrder":
		// A TWAP order carries size but no request price (it executes at market
		// over `minutes`), so its USD notional cannot be computed here. Fail
		// closed: NaN notional makes Evaluate deny it ("invalid notional") rather
		// than let a size-bearing order bypass the per-order and daily caps.
		return policy.Intent{Kind: kind, NotionalUsdc: math.NaN()}
	default:
		return policy.Intent{Kind: kind}
	}
}

// Fencer supplies the current fencing token (a lease epoch) and whether this
// instance currently holds leadership. A non-leader must not sign. leader.Leader
// satisfies this; main() uses a static always-leader fencer for the in-memory
// single-instance default.
type Fencer interface {
	Fence() (epoch uint64, isLeader bool)
}

// staticFencer is an always-leader fencer with a fixed epoch (single instance).
type staticFencer struct{ epoch uint64 }

func (s staticFencer) Fence() (uint64, bool) { return s.epoch, true }

// metricsObserver adapts reconciler telemetry onto the metrics package, keeping
// the reconciler free of any Prometheus dependency.
type metricsObserver struct{}

func (metricsObserver) ReconcileStep(outcome string)     { metrics.ObserveReconcileStep(outcome) }
func (metricsObserver) Reap(target ledger.Status)        { metrics.ObserveReap(string(target)) }
func (metricsObserver) LeaderState(isLeader bool)        { metrics.SetReconcileLeader(isLeader) }
func (metricsObserver) StepDuration(s float64)           { metrics.ObserveReconcileStepDuration(s) }
func (metricsObserver) HLRequest(call string, s float64) { metrics.ObserveReconcileHL(call, s) }

// Compile-time check that metricsObserver satisfies reconciler.Observer.
var _ reconciler.Observer = metricsObserver{}
var _ reconciler.Tracer = tracing.StepTracer{}

// handleSignL1 signs an L1 action with the keystore signer named by keyId. The
// reject-first policy (Evaluate) runs first; then, if this instance is the leader,
// the single-writer atomically enforces the fencing token + daily notional cap and
// allocates a strictly-increasing per-key nonce, which is returned. Fail-closed: an
// unknown keyId → 404; a non-leader → 503; a stale fence → 409. Never logs key material.
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64, keyLimiter, ipLimiter *ratelimit.Limiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req signL1Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
			return
		}
		signer, ok := ks.Signer(req.KeyID)
		if !ok {
			writeErr(w, http.StatusNotFound, "unknown keyId")
			return
		}
		cfg := policies.Get(req.KeyID)
		ownerAddr, ownerOK := normalizeOwnerAddress(cfg.OwnerAddress)
		if cfg.IPRatePerSec > 0 {
			if !ownerOK {
				writeErr(w, http.StatusTooManyRequests, "ip rate limit exceeded")
				return
			}
			ip, ok := canonicalRemoteIP(r.RemoteAddr)
			if !ok || !ipLimiter.Allow(ownerIPKey(ownerAddr, ip), cfg.IPRatePerSec, cfg.IPRateBurst) {
				writeErr(w, http.StatusTooManyRequests, "ip rate limit exceeded")
				return
			}
		}
		if !keyLimiter.Allow(req.KeyID, cfg.RatePerSec, cfg.RateBurst) {
			writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		intent := intentFor(req.Kind, req.Params)
		if d := policy.Evaluate(intent, cfg); !d.Allow {
			writeErr(w, http.StatusForbidden, d.Reason)
			return
		}
		action, err := hl.ActionFromKind(req.Kind, req.Params)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		enc, err := hl.Encode(action)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "encode action: "+err.Error())
			return
		}
		hsh := sha256.New()
		hsh.Write(enc)
		if req.IsTestnet {
			hsh.Write([]byte{1})
		} else {
			hsh.Write([]byte{0})
		}
		var digest [32]byte
		copy(digest[:], hsh.Sum(nil))

		fence, isLeader := fencer.Fence()
		if !isLeader {
			writeErr(w, http.StatusServiceUnavailable, "not leader")
			return
		}
		if cfg.AddressDailyMaxNotionalUsdc > 0 && !ownerOK {
			writeErr(w, http.StatusForbidden, "address daily cap exceeded")
			return
		}
		grant, err := auth.Authorize(r.Context(), ledger.Request{
			KeyID:           req.KeyID,
			Cloid:           req.Cloid,
			Digest:          digest,
			Fence:           fence,
			Notional:        intent.NotionalUsdc,
			DailyCap:        cfg.DailyMaxNotionalUsdc,
			AddressSpendKey: ownerAddr,
			AddressDailyCap: cfg.AddressDailyMaxNotionalUsdc,
			NowMs:           nowMs(),
		})
		if err != nil {
			switch {
			case errors.Is(err, ledger.ErrMissingCloid):
				writeErr(w, http.StatusBadRequest, "missing cloid")
			case errors.Is(err, ledger.ErrCloidReuse):
				writeErr(w, http.StatusConflict, "cloid reuse mismatch")
			case errors.Is(err, ledger.ErrAddressDailyCap):
				writeErr(w, http.StatusForbidden, "address daily cap exceeded")
			case errors.Is(err, singlewriter.ErrFenced):
				writeErr(w, http.StatusConflict, "fenced")
			case errors.Is(err, singlewriter.ErrDailyCap):
				writeErr(w, http.StatusForbidden, "daily cap exceeded")
			case errors.Is(err, singlewriter.ErrInvalidNotional):
				writeErr(w, http.StatusForbidden, "invalid notional")
			case errors.Is(err, singlewriter.ErrInvalidClock):
				writeErr(w, http.StatusInternalServerError, "invalid clock")
			default:
				writeErr(w, http.StatusInternalServerError, "authorize failed")
			}
			return
		}
		sig, err := signer.SignL1Action(action, grant.Nonce, req.IsTestnet)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "sign failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(signL1Response{
			R:         "0x" + hex.EncodeToString(sig.R[:]),
			S:         "0x" + hex.EncodeToString(sig.S[:]),
			V:         int(sig.V),
			Nonce:     grant.Nonce,
			Duplicate: grant.Duplicate,
		})
	}
}

type reconcileRequest struct {
	KeyID  string `json:"keyId"`
	Cloid  string `json:"cloid"`
	Status string `json:"status"`
}

type reconcileResponse struct {
	Status string `json:"status"`
}

type orphanDTO struct {
	KeyID       string `json:"keyId"`
	Cloid       string `json:"cloid"`
	Nonce       uint64 `json:"nonce"`
	Status      string `json:"status"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

type orphansResponse struct {
	Orphans []orphanDTO `json:"orphans"`
}

// validStatus reports whether s is one of the six known lifecycle states.
func validStatus(s string) bool {
	switch ledger.Status(s) {
	case ledger.StatusSigned, ledger.StatusSubmitted, ledger.StatusOpen,
		ledger.StatusFilled, ledger.StatusRejected, ledger.StatusCanceled:
		return true
	default:
		return false
	}
}

// handleReconcile advances the lifecycle status of an existing (keyId, cloid)
// intent via the ledger reconciliation state machine. It signs nothing and holds
// no fence gate: transitions are serialized in the store and a stale report is
// rejected as an invalid transition. Unknown intent → 404; invalid edge → 409;
// unknown status string → 400.
func handleReconcile(led ledger.Reconciler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req reconcileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
			return
		}
		if !validStatus(req.Status) {
			writeErr(w, http.StatusBadRequest, "invalid status")
			return
		}
		st, err := led.Reconcile(r.Context(), req.KeyID, req.Cloid, ledger.Status(req.Status))
		if err != nil {
			switch {
			case errors.Is(err, ledger.ErrUnknownIntent):
				writeErr(w, http.StatusNotFound, "unknown intent")
			case errors.Is(err, ledger.ErrInvalidTransition):
				writeErr(w, http.StatusConflict, "invalid transition")
			default:
				writeErr(w, http.StatusInternalServerError, "reconcile failed")
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reconcileResponse{Status: string(st)})
	}
}

// handleOrphans returns non-terminal intents whose last update predates the
// olderThanMs (unix ms) cutoff — signed/submitted/open orders never confirmed to
// a terminal state. Read-only; no fence gate. Missing/invalid cutoff → 400.
func handleOrphans(led ledger.Reconciler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		n, err := strconv.ParseInt(r.URL.Query().Get("olderThanMs"), 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid olderThanMs")
			return
		}
		orphs, err := led.Orphans(r.Context(), n)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "orphans failed")
			return
		}
		out := orphansResponse{Orphans: []orphanDTO{}}
		for _, o := range orphs {
			out.Orphans = append(out.Orphans, orphanDTO{
				KeyID:       o.KeyID,
				Cloid:       o.Cloid,
				Nonce:       o.Nonce,
				Status:      string(o.Status),
				UpdatedAtMs: o.UpdatedAtMs,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}

// newMux builds the service router (no side effects; testable). The digest
// endpoints are keyless; /v1/sign/l1 uses the injected keystore, policy,
// single-writer, fencer, and clock.
func newMux(ks *keystore.Keystore, policies *policy.Store, led ledger.Ledger, fencer Fencer, nowMs func() int64) http.Handler {
	mux := http.NewServeMux()
	route := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, metrics.Middleware(name, h))
	}
	loggedRoute := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, logging.Middleware(name, metrics.Middleware(name, h)))
	}
	mux.HandleFunc("/healthz", route("healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	mux.HandleFunc("/v1/digest/l1", loggedRoute("digest_l1", handleDigestL1))
	keyLimiter := ratelimit.New(nowMs)
	ipLimiter := ratelimit.New(nowMs)
	mux.HandleFunc("/v1/sign/l1", loggedRoute("sign_l1", handleSignL1(ks, policies, led, fencer, nowMs, keyLimiter, ipLimiter)))
	mux.HandleFunc("/v1/reconcile", loggedRoute("reconcile", handleReconcile(led)))
	mux.HandleFunc("/v1/orphans", loggedRoute("orphans", handleOrphans(led)))
	mux.Handle("/metrics", metrics.Handler())
	return mux
}

// Fencer is satisfied by leader.Leader (compile-time check).
var _ Fencer = (*leader.Leader)(nil)

// config is the signer's runtime configuration.
type config struct {
	addr              string
	databaseURL       string
	leaseName         string
	holderID          string
	leaseTTL          time.Duration
	renewEvery        time.Duration
	hlInfoURL         string
	reconcileAccounts []reconciler.Account
	reconcileInterval time.Duration
	hlTimeout         time.Duration
}

// normalizeOwnerAddress lowercases and validates a 20-byte hex EVM address.
func normalizeOwnerAddress(addr string) (string, bool) {
	addr = strings.ToLower(strings.TrimSpace(addr))
	if len(addr) != 42 || !strings.HasPrefix(addr, "0x") {
		return "", false
	}
	for _, c := range addr[2:] {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f':
		default:
			return "", false
		}
	}
	return addr, true
}

// canonicalRemoteIP extracts and canonicalizes the direct peer IP from RemoteAddr.
func canonicalRemoteIP(remoteAddr string) (string, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return "", false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return "", false
	}
	return ip.String(), true
}

func ownerIPKey(ownerAddr, ip string) string { return ownerAddr + "|" + ip }

// parseAccounts parses a comma-separated "keyID=address" list into reconcile
// accounts, trimming whitespace and skipping malformed (missing/empty half) pairs.
func parseAccounts(s string) []reconciler.Account {
	var out []reconciler.Account
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		keyID, addr := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
		if keyID == "" || addr == "" {
			continue
		}
		out = append(out, reconciler.Account{KeyID: keyID, Address: addr})
	}
	return out
}

// configFromEnv reads SIGNER_ADDR / DATABASE_URL / SIGNER_LEASE_NAME /
// SIGNER_HOLDER_ID and fills sensible defaults. A non-empty DATABASE_URL selects
// the Postgres cross-host backend; otherwise the signer runs single-instance.
// If SIGNER_HOLDER_ID is set it MUST be unique per instance — two instances
// sharing a holder id would each renew the other's lease (split-brain); the
// default (hostname-pid-random) is unique.
func configFromEnv() config {
	cfg := config{
		addr:        os.Getenv("SIGNER_ADDR"),
		databaseURL: os.Getenv("DATABASE_URL"),
		leaseName:   os.Getenv("SIGNER_LEASE_NAME"),
		holderID:    os.Getenv("SIGNER_HOLDER_ID"),
		leaseTTL:    15 * time.Second,
		renewEvery:  5 * time.Second,
	}
	if cfg.addr == "" {
		cfg.addr = "127.0.0.1:8087"
	}
	if cfg.leaseName == "" {
		cfg.leaseName = "signer-leader"
	}
	if cfg.holderID == "" {
		cfg.holderID = defaultHolderID()
	}
	cfg.hlInfoURL = os.Getenv("SIGNER_HL_INFO_URL")
	cfg.reconcileAccounts = parseAccounts(os.Getenv("SIGNER_RECONCILE_ACCOUNTS"))
	cfg.reconcileInterval = 15 * time.Second
	if d, err := time.ParseDuration(os.Getenv("SIGNER_RECONCILE_INTERVAL")); err == nil && d > 0 {
		cfg.reconcileInterval = d
	}
	cfg.hlTimeout = 10 * time.Second
	if d, err := time.ParseDuration(os.Getenv("SIGNER_HL_TIMEOUT")); err == nil && d > 0 {
		cfg.hlTimeout = d
	}
	return cfg
}

// defaultHolderID returns hostname-pid-<random hex>, a per-process lease identity.
func defaultHolderID() string {
	host, _ := os.Hostname()
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s-%d-%s", host, os.Getpid(), hex.EncodeToString(b[:]))
}

// buildHandler assembles the signing router for cfg using the given keystore and
// policy store. With an empty DATABASE_URL it wires a single-instance in-memory
// single-writer + an always-leader fencer. Otherwise it opens a pgxpool, ensures
// both schemas, and wires the Postgres single-writer + a lease-backed leader
// started in the background. When configured (HL URL + accounts), it starts a
// leader-gated auto-reconciler. The returned cleanup cancels the leader + reconciler
// (releasing the lease) and closes the pool; on any setup error the pool is closed
// and the error returned.
func buildHandler(ctx context.Context, cfg config, ks *keystore.Keystore, policies *policy.Store) (http.Handler, func(), error) {
	nowMs := func() int64 { return time.Now().UnixMilli() }

	var led ledger.Ledger
	var fencer Fencer
	cleanup := func() {}

	if cfg.databaseURL == "" {
		led = ledger.NewMem()
		fencer = staticFencer{epoch: 1}
	} else {
		pool, err := pgxpool.New(ctx, cfg.databaseURL)
		if err != nil {
			return nil, nil, fmt.Errorf("signer: pgxpool: %w", err)
		}
		if err := ledgerpg.EnsureSchema(ctx, pool); err != nil {
			pool.Close()
			return nil, nil, fmt.Errorf("signer: ledger schema: %w", err)
		}
		if err := leasepg.EnsureSchema(ctx, pool); err != nil {
			pool.Close()
			return nil, nil, fmt.Errorf("signer: lease schema: %w", err)
		}
		ld := leader.New(leasepg.New(pool), cfg.leaseName, cfg.holderID, cfg.leaseTTL)
		leaderCtx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			ld.Run(leaderCtx, cfg.renewEvery)
			close(done)
		}()
		led = ledgerpg.New(pool)
		fencer = ld
		cleanup = func() {
			cancel() // leader.Run releases the lease on ctx cancel
			<-done   // wait for Run to finish releasing before closing the pool
			pool.Close()
		}
	}

	// Optionally start the leader-gated auto-reconciler when configured.
	if cfg.hlInfoURL != "" && len(cfg.reconcileAccounts) > 0 {
		client := hlinfo.New(cfg.hlInfoURL, &http.Client{
			Timeout:   cfg.hlTimeout,
			Transport: tracing.HLTransport(http.DefaultTransport),
		})
		isLeader := func() bool { _, l := fencer.Fence(); return l }
		rec := reconciler.New(client, led, cfg.reconcileAccounts,
			reconciler.WithLeaderGate(isLeader),
			reconciler.WithObserver(metricsObserver{}),
			reconciler.WithTracer(tracing.NewStepTracer()))
		recCtx, recCancel := context.WithCancel(context.Background())
		recDone := make(chan struct{})
		go func() {
			rec.Run(recCtx, cfg.reconcileInterval)
			close(recDone)
		}()
		base := cleanup
		cleanup = func() {
			recCancel()
			<-recDone
			base()
		}
	}

	h := newMux(ks, policies, led, fencer, nowMs)
	return h, cleanup, nil
}

func main() { os.Exit(run()) }

// serve runs srv on ln until ctx is canceled, then gracefully shuts it down and
// blocks until in-flight requests finish draining (bounded by drainTimeout) before
// returning. Waiting for the drain to complete is what makes the caller's deferred
// teardown safe: srv.Serve returns ErrServerClosed the instant Shutdown closes the
// listener — well before in-flight handlers finish — so without this barrier the
// deferred cleanup (lease release, pool close) and tracing flush could run while a
// handler is still executing, dropping its DB pool or its span mid-request. It
// returns a non-nil error only on an unexpected Serve failure. The caller must
// ensure ctx is eventually canceled (e.g. via a deferred signal-context stop) so
// the internal shutdown goroutine is reaped even when Serve fails with a
// non-ErrServerClosed error and serve returns without awaiting the drain.
func serve(ctx context.Context, srv *http.Server, ln net.Listener, drainTimeout time.Duration) error {
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		sc, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		_ = srv.Shutdown(sc)
		close(shutdownDone)
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	<-shutdownDone
	return nil
}

// run wires and serves the signer, returning a process exit code. It is separate
// from main so that deferred cleanup (which releases the lease and closes the
// pool) always runs — even on a serve error — instead of being skipped by os.Exit
// inside a log.Fatal.
func run() int {
	cfg := configFromEnv()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logging.Setup()

	// Setup must precede buildHandler: otelhttp captures the propagator at
	// construction time, so the mux + HL transport built in buildHandler need the
	// propagator already installed.
	shutdownTracing, _ := tracing.Setup(ctx)
	defer func() {
		sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTracing(sc)
	}()

	ks := keystore.New()
	policies := policy.NewStore()
	h, cleanup, err := buildHandler(ctx, cfg, ks, policies)
	if err != nil {
		slog.Error("build handler", "error", err)
		return 1
	}
	defer cleanup()

	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		slog.Error("listen", "error", err)
		return 1 // deferred cleanup() releases the lease + closes the pool
	}
	srv := &http.Server{Handler: h}
	slog.Info("signer listening", "addr", cfg.addr, "db", cfg.databaseURL != "")
	if err := serve(ctx, srv, ln, 5*time.Second); err != nil {
		slog.Error("serve", "error", err)
		return 1 // deferred cleanup() releases the lease + closes the pool
	}
	return 0
}
