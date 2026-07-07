// Package lease is a name-keyed persistent lease store with a monotonic fencing
// epoch. A process acquires/renews a lease to become the single writer for a
// name; each (re)acquire mints a strictly higher Epoch that callers pass to
// singlewriter as Request.Fence, so a deposed holder is fenced out
// (docs/BACKEND-ARCHITECTURE.md §6.2, M6). Expiry uses the DB clock (skew-free).
package lease

import (
	"context"
	"errors"
	"time"
)

// Lease is a claim on a named resource. Epoch is the fencing token: it strictly
// increases on every (re)acquire and is passed to singlewriter as Request.Fence.
type Lease struct {
	Name        string
	Holder      string
	Epoch       uint64
	ExpiresAtMs int64 // absolute expiry on the DB clock (epoch ms)
}

// Store is a persistent lease authority. Implementations evaluate expiry against
// a single shared clock (the DB) so instances cannot disagree about liveness.
type Store interface {
	// Acquire claims the lease for holder if it is free or expired, minting a
	// bumped Epoch. If a different holder still holds a valid lease it returns
	// ErrHeld (a valid self-hold also returns ErrHeld: use Renew instead).
	Acquire(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
	// Renew extends the caller's still-valid lease, keeping the same Epoch. If the
	// caller's lease already lapsed it returns ErrExpired (must re-Acquire); if
	// someone else holds it, ErrNotHolder.
	Renew(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
	// Release voluntarily gives up the lease held by holder (marks it expired now,
	// preserving Epoch). A non-holder / absent lease is an idempotent no-op.
	Release(ctx context.Context, name, holder string) error
}

// Typed rejections; callers/endpoints map these to backoff / HTTP status.
var (
	ErrHeld      = errors.New("lease held by another holder")
	ErrNotHolder = errors.New("not the lease holder")
	ErrExpired   = errors.New("lease expired; re-acquire")
)
