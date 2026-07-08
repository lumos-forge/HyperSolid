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

// Status is the reconciliation lifecycle state of a (keyID, cloid) intent.
type Status string

const (
	StatusSigned    Status = "signed"
	StatusSubmitted Status = "submitted"
	StatusOpen      Status = "open"
	StatusFilled    Status = "filled"
	StatusRejected  Status = "rejected"
	StatusCanceled  Status = "canceled"
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

// Record is one persisted (keyID, cloid) intent.
type Record struct {
	Nonce  uint64
	Digest [32]byte
	Status Status
}

// Authorizer is the cloid-idempotent ledger authority.
type Authorizer interface {
	Authorize(ctx context.Context, r Request) (Grant, error)
}

// Orphan is a non-terminal intent whose last update predates a cutoff — signed
// (and maybe submitted/open) but never confirmed to a terminal state.
type Orphan struct {
	KeyID       string
	Cloid       string
	Nonce       uint64
	Status      Status
	UpdatedAtMs int64
}

// Reconciler advances an intent's lifecycle and surfaces stale non-terminal ones.
type Reconciler interface {
	// Reconcile validates current→target and persists it, refreshing updatedAt on
	// any success (including an idempotent same-status re-report = proof of life).
	// Unknown (keyID,cloid) → ErrUnknownIntent; a disallowed edge → ErrInvalidTransition.
	Reconcile(ctx context.Context, keyID, cloid string, target Status) (Status, error)
	// Orphans returns every non-terminal record whose updatedAt < olderThanMs.
	Orphans(ctx context.Context, olderThanMs int64) ([]Orphan, error)
}

// Ledger combines idempotent authorization and reconciliation (both Mem and the
// Postgres Store satisfy it); the conformance suite and future wiring use it.
type Ledger interface {
	Authorizer
	Reconciler
}

// Typed rejections; the signer wiring (later slice) maps these to HTTP codes.
var (
	ErrMissingCloid      = errors.New("missing cloid")        // empty cloid → reject
	ErrCloidReuse        = errors.New("cloid reuse mismatch") // same cloid, different digest → reject
	ErrInvalidTransition = errors.New("invalid status transition") // disallowed lifecycle edge
	ErrUnknownIntent     = errors.New("unknown intent")            // reconcile a (keyID,cloid) never signed
)
