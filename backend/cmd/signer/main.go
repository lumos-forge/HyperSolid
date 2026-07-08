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
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/leader"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	ledgerpg "github.com/lumos-forge/hypersolid/backend/internal/ledger/pg"
	leasepg "github.com/lumos-forge/hypersolid/backend/internal/lease/pg"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
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
			Asset int64  `json:"asset"`
			Px    string `json:"px"`
			Sz    string `json:"sz"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return policy.Intent{Kind: kind, NotionalUsdc: math.NaN()}
		}
		return policy.Intent{Kind: kind, Coin: strconv.FormatInt(p.Asset, 10), NotionalUsdc: orderNotional(p.Px, p.Sz)}
	case "modify":
		var p struct {
			Order struct {
				Asset int64  `json:"asset"`
				Px    string `json:"px"`
				Sz    string `json:"sz"`
			} `json:"order"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return policy.Intent{Kind: kind, NotionalUsdc: math.NaN()}
		}
		return policy.Intent{Kind: kind, Coin: strconv.FormatInt(p.Order.Asset, 10), NotionalUsdc: orderNotional(p.Order.Px, p.Order.Sz)}
	case "batchModify":
		var p struct {
			Modifies []struct {
				Order struct {
					Px string `json:"px"`
					Sz string `json:"sz"`
				} `json:"order"`
			} `json:"modifies"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return policy.Intent{Kind: kind, NotionalUsdc: math.NaN()}
		}
		total := 0.0
		for _, m := range p.Modifies {
			total += orderNotional(m.Order.Px, m.Order.Sz)
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

// handleSignL1 signs an L1 action with the keystore signer named by keyId. The
// reject-first policy (Evaluate) runs first; then, if this instance is the leader,
// the single-writer atomically enforces the fencing token + daily notional cap and
// allocates a strictly-increasing per-key nonce, which is returned. Fail-closed: an
// unknown keyId → 404; a non-leader → 503; a stale fence → 409. Never logs key material.
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64) http.HandlerFunc {
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
		intent := intentFor(req.Kind, req.Params)
		cfg := policies.Get(req.KeyID)
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
		grant, err := auth.Authorize(r.Context(), ledger.Request{
			KeyID:    req.KeyID,
			Cloid:    req.Cloid,
			Digest:   digest,
			Fence:    fence,
			Notional: intent.NotionalUsdc,
			DailyCap: cfg.DailyMaxNotionalUsdc,
			NowMs:    nowMs(),
		})
		if err != nil {
			switch {
			case errors.Is(err, ledger.ErrMissingCloid):
				writeErr(w, http.StatusBadRequest, "missing cloid")
			case errors.Is(err, ledger.ErrCloidReuse):
				writeErr(w, http.StatusConflict, "cloid reuse mismatch")
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

// newMux builds the service router (no side effects; testable). The digest
// endpoints are keyless; /v1/sign/l1 uses the injected keystore, policy,
// single-writer, fencer, and clock.
func newMux(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, auth, fencer, nowMs))
	return mux
}

// Fencer is satisfied by leader.Leader (compile-time check).
var _ Fencer = (*leader.Leader)(nil)

// config is the signer's runtime configuration.
type config struct {
	addr        string
	databaseURL string
	leaseName   string
	holderID    string
	leaseTTL    time.Duration
	renewEvery  time.Duration
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
// started in the background. The returned cleanup cancels the leader (releasing
// the lease) and closes the pool; on any setup error the pool is closed and the
// error returned.
func buildHandler(ctx context.Context, cfg config, ks *keystore.Keystore, policies *policy.Store) (http.Handler, func(), error) {
	nowMs := func() int64 { return time.Now().UnixMilli() }

	if cfg.databaseURL == "" {
		h := newMux(ks, policies, ledger.NewMem(), staticFencer{epoch: 1}, nowMs)
		return h, func() {}, nil
	}

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

	auth := ledgerpg.New(pool)
	store := leasepg.New(pool)
	ld := leader.New(store, cfg.leaseName, cfg.holderID, cfg.leaseTTL)

	leaderCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		ld.Run(leaderCtx, cfg.renewEvery)
		close(done)
	}()
	cleanup := func() {
		cancel() // leader.Run releases the lease on ctx cancel
		<-done   // wait for Run to finish releasing before closing the pool
		pool.Close()
	}

	h := newMux(ks, policies, auth, ld, nowMs)
	return h, cleanup, nil
}

func main() { os.Exit(run()) }

// run wires and serves the signer, returning a process exit code. It is separate
// from main so that deferred cleanup (which releases the lease and closes the
// pool) always runs — even on a ListenAndServe error — instead of being skipped
// by os.Exit inside a log.Fatal.
func run() int {
	cfg := configFromEnv()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ks := keystore.New()
	policies := policy.NewStore()
	h, cleanup, err := buildHandler(ctx, cfg, ks, policies)
	if err != nil {
		log.Print(err)
		return 1
	}
	defer cleanup()

	srv := &http.Server{Addr: cfg.addr, Handler: h}
	go func() {
		<-ctx.Done()
		sc, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = srv.Shutdown(sc)
	}()
	log.Printf("signer service listening on %s (db=%t)", cfg.addr, cfg.databaseURL != "")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print(err)
		return 1 // deferred cleanup() releases the lease + closes the pool
	}
	return 0
}
