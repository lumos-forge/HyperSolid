// Package ledger is the M6 cloid-keyed intent ledger: it makes signing
// authorization idempotent per (agent key, client order id). The first request
// for a cloid allocates a nonce via the single-writer authority (fence + daily
// cap + strictly-increasing nonce); a retry with the SAME cloid and SAME intent
// digest replays the ORIGINAL nonce (no new nonce, no double cap charge) so
// re-submitting is a true no-op at Hyperliquid (which dedups by cloid). A retry
// with the same cloid but a DIFFERENT digest fails closed (ErrCloidReuse), and
// an empty cloid is rejected (ErrMissingCloid). This closes the duplicate/orphan
// order gap (docs/BACKEND-ARCHITECTURE.md §6.2, M6). Reconciliation of terminal
// order status (submitted/open/filled/rejected) and signer wiring are later slices.
package ledger

import (
	"context"
	"errors"
)

// Request is one cloid-idempotent signing authorization for an agent key.
type Request struct {
	KeyID    string   // agent private key id (per private key, not account)
	Cloid    string   // client order id; half of the ledger key; MUST be non-empty
	Digest   [32]byte // opaque intent digest (caller supplies; typically the HL action hash)
	Fence    uint64   // fencing token from the caller's lease (passed to singlewriter)
	Notional float64  // this action's USD notional; 0 for non-notional kinds
	DailyCap float64  // per-key daily notional cap; 0 = unlimited, <0 = misconfig (denied)
	NowMs    int64    // caller clock in ms; injectable for tests
}

// Grant is the result of an accepted (or idempotently replayed) authorization.
type Grant struct {
	Nonce     uint64 // nonce to sign with (freshly allocated or the original record's)
	Duplicate bool   // true = idempotent replay (original nonce; no cap charge, no nonce bump)
}

// Record is one persisted (keyID, cloid) intent. Status is "signed" in this slice;
// the reconciliation slice extends it (submitted/open/filled/rejected).
type Record struct {
	Nonce  uint64
	Digest [32]byte
	Status string
}

// Authorizer is the cloid-idempotent ledger authority.
type Authorizer interface {
	Authorize(ctx context.Context, r Request) (Grant, error)
}

// Typed rejections; the signer wiring (later slice) maps these to HTTP codes.
var (
	ErrMissingCloid = errors.New("missing cloid")        // empty cloid → reject
	ErrCloidReuse   = errors.New("cloid reuse mismatch") // same cloid, different digest → reject
)
