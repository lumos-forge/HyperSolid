package lease

import (
	"context"
	"sync"
	"time"
)

// Mem is an in-process lease.Store: a mutex-guarded map of per-name Row applying
// the pure Decide transition with an injectable clock. It is the deterministic
// test fixture for the leader loop and a usable single-instance Store; the
// cross-host authority is the Postgres-backed Store (internal/lease/pg).
type Mem struct {
	nowMs func() int64
	mu    sync.Mutex
	rows  map[string]Row
}

// NewMem returns an empty in-memory Store. A nil nowMs uses the real clock
// (time.Now().UnixMilli()); tests inject a fake clock.
func NewMem(nowMs func() int64) *Mem {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &Mem{nowMs: nowMs, rows: make(map[string]Row)}
}

// Acquire implements lease.Store.
func (m *Mem) Acquire(_ context.Context, name, holder string, ttl time.Duration) (Lease, error) {
	return m.op(name, OpAcquire, holder, ttl)
}

// Renew implements lease.Store.
func (m *Mem) Renew(_ context.Context, name, holder string, ttl time.Duration) (Lease, error) {
	return m.op(name, OpRenew, holder, ttl)
}

// Release implements lease.Store.
func (m *Mem) Release(_ context.Context, name, holder string) error {
	_, err := m.op(name, OpRelease, holder, 0)
	return err
}

// op applies Decide under a single lock: an absent name is the zero Row (expired
// seed). On a mutation the next Row is persisted; a typed rejection leaves state
// unchanged; an idempotent no-op (Release by a non-holder) returns nil.
func (m *Mem) op(name string, op Op, holder string, ttl time.Duration) (Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, write, out, err := Decide(
		m.rows[name],
		Req{Op: op, Holder: holder, NowMs: m.nowMs(), TtlMs: ttl.Milliseconds()},
	)
	if err != nil {
		return Lease{}, err
	}
	if write {
		m.rows[name] = next
	}
	out.Name = name
	return out, nil
}

// compile-time assertion that Mem satisfies the Store interface.
var _ Store = (*Mem)(nil)
