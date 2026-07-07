// Command signer is the M5/M6 signing service. It exposes keyless digest endpoints
// (/healthz, /v1/digest/l1) plus a keystore-backed L1 signing endpoint (/v1/sign/l1)
// gated by the reject-first policy (Evaluate) then the single-writer authority
// (fence + daily notional cap + monotonic nonce, atomically). The shipped binary
// starts with an EMPTY keystore (fail-closed) and, by default, an in-memory
// single-writer + an always-leader fencer (single instance); wiring a leased
// cross-host single-writer is a later slice (docs/BACKEND-ARCHITECTURE.md §5.1a/§6.2).
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
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
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	IsTestnet bool            `json:"isTestnet"`
}

type signL1Response struct {
	R     string `json:"r"`
	S     string `json:"s"`
	V     int    `json:"v"`
	Nonce uint64 `json:"nonce"`
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
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, writer singlewriter.Writer, fencer Fencer, nowMs func() int64) http.HandlerFunc {
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
		fence, isLeader := fencer.Fence()
		if !isLeader {
			writeErr(w, http.StatusServiceUnavailable, "not leader")
			return
		}
		grant, err := writer.Authorize(r.Context(), singlewriter.Request{
			KeyID:    req.KeyID,
			Fence:    fence,
			Notional: intent.NotionalUsdc,
			DailyCap: cfg.DailyMaxNotionalUsdc,
			NowMs:    nowMs(),
		})
		if err != nil {
			switch {
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
			R:     "0x" + hex.EncodeToString(sig.R[:]),
			S:     "0x" + hex.EncodeToString(sig.S[:]),
			V:     int(sig.V),
			Nonce: grant.Nonce,
		})
	}
}

// newMux builds the service router (no side effects; testable). The digest
// endpoints are keyless; /v1/sign/l1 uses the injected keystore, policy,
// single-writer, fencer, and clock.
func newMux(ks *keystore.Keystore, policies *policy.Store, writer singlewriter.Writer, fencer Fencer, nowMs func() int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, writer, fencer, nowMs))
	return mux
}

func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	ks := keystore.New()
	policies := policy.NewStore()
	writer := singlewriter.NewMem()
	fencer := staticFencer{epoch: 1}
	nowMs := func() int64 { return time.Now().UnixMilli() }
	log.Printf("signer service listening on %s (empty keystore + policy; in-memory single-writer, single instance)", addr)
	if err := http.ListenAndServe(addr, newMux(ks, policies, writer, fencer, nowMs)); err != nil {
		log.Fatal(err)
	}
}
