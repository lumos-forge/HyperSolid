// Package leader holds a single named lease on behalf of one holder and keeps it
// renewed in the background, exposing the current fencing epoch and leadership
// status. The signing endpoint passes the epoch to singlewriter as Request.Fence
// (a later slice); on a lost/stolen lease the epoch bumps, fencing the old holder
// out at the single-writer layer (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package leader

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
)

// Leader keeps a named lease renewed and exposes the current fencing epoch.
type Leader struct {
	store  lease.Store
	name   string
	holder string
	ttl    time.Duration

	mu       sync.Mutex
	epoch    uint64
	isLeader bool
}

// New returns a Leader for (name, holder) over store with lease TTL ttl.
func New(store lease.Store, name, holder string, ttl time.Duration) *Leader {
	return &Leader{store: store, name: name, holder: holder, ttl: ttl}
}

// Fence returns the current fencing epoch and whether this instance currently
// holds the lease. Safe for concurrent use.
func (l *Leader) Fence() (epoch uint64, isLeader bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.epoch, l.isLeader
}

// step performs exactly one acquire-or-renew cycle and updates state. If leading,
// it renews; a renew failure drops leadership and it immediately attempts to
// (re)acquire. If not leading, it attempts to acquire. It has no timing of its
// own; Run calls it on a ticker and tests call it directly.
func (l *Leader) step(ctx context.Context) {
	l.mu.Lock()
	leading := l.isLeader
	l.mu.Unlock()

	if leading {
		ls, err := l.store.Renew(ctx, l.name, l.holder, l.ttl)
		switch {
		case err == nil:
			l.set(ls.Epoch, true)
			return
		case errors.Is(err, lease.ErrNotHolder), errors.Is(err, lease.ErrExpired):
			// Genuine loss of the lease: drop leadership and try to (re)acquire below.
			l.set(0, false)
		default:
			// Transient infra error (e.g. a DB blip): the lease is still validly held
			// until its TTL, so keep the current (epoch, isLeader) and retry Renew next
			// tick rather than flapping into a leaderless gap + spurious epoch bump. A
			// truly lost lease is caught on a later tick; the singlewriter fence is the
			// safety backstop against a stale leader.
			return
		}
	}

	if ls, err := l.store.Acquire(ctx, l.name, l.holder, l.ttl); err == nil {
		l.set(ls.Epoch, true)
		return
	}
	l.set(0, false)
}

func (l *Leader) set(epoch uint64, isLeader bool) {
	l.mu.Lock()
	l.epoch = epoch
	l.isLeader = isLeader
	l.mu.Unlock()
}

// Run drives step on an `every` ticker until ctx is cancelled, then best-effort
// releases the lease. It performs one immediate step before ticking.
func (l *Leader) Run(ctx context.Context, every time.Duration) {
	l.step(ctx)
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			releaseCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = l.store.Release(releaseCtx, l.name, l.holder)
			cancel()
			l.set(0, false)
			return
		case <-ticker.C:
			l.step(ctx)
		}
	}
}
