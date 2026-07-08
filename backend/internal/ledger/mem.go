package ledger

import (
	"context"
	"sync"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// recordKey identifies one ledger record by (agent key, client order id).
type recordKey struct{ keyID, cloid string }

// Mem is an in-process Authorizer: mutex-guarded per-key single-writer state plus
// a (keyID,cloid)→Record map applying the pure Decide transition. It is the
// single-instance reference implementation and the fast unit-test fixture; the
// cross-host authority is the Postgres Store (which applies the SAME Decide in a
// transaction).
type Mem struct {
	mu        sync.Mutex
	sw        map[string]singlewriter.State
	records   map[recordKey]Record
	updatedAt map[recordKey]int64
}

// NewMem returns an empty in-memory Authorizer.
func NewMem() *Mem {
	return &Mem{
		sw:        make(map[string]singlewriter.State),
		records:   make(map[recordKey]Record),
		updatedAt: make(map[recordKey]int64),
	}
}

// Authorize applies Decide under a single lock: atomic check-and-reserve. On a
// fresh cloid it persists the new single-writer state and record; a replay and
// every reject leave state untouched.
func (m *Mem) Authorize(_ context.Context, r Request) (Grant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rk := recordKey{keyID: r.KeyID, cloid: r.Cloid}
	var existing *Record
	if rec, ok := m.records[rk]; ok {
		existing = &rec
	}
	nextSW, rec, g, err := Decide(m.sw[r.KeyID], existing, r)
	if err != nil {
		return Grant{}, err
	}
	if !g.Duplicate {
		m.sw[r.KeyID] = nextSW
		m.records[rk] = rec
		m.updatedAt[rk] = time.Now().UnixMilli()
	}
	return g, nil
}

// Reconcile validates the lifecycle transition for (keyID, cloid) and persists it.
func (m *Mem) Reconcile(_ context.Context, keyID, cloid string, target Status) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rk := recordKey{keyID: keyID, cloid: cloid}
	rec, ok := m.records[rk]
	if !ok {
		return "", ErrUnknownIntent
	}
	next, err := Transition(rec.Status, target)
	if err != nil {
		return rec.Status, err
	}
	rec.Status = next
	m.records[rk] = rec
	m.updatedAt[rk] = time.Now().UnixMilli()
	return next, nil
}

// Orphans returns every non-terminal record whose updatedAt < olderThanMs.
func (m *Mem) Orphans(_ context.Context, olderThanMs int64) ([]Orphan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Orphan
	for rk, rec := range m.records {
		if isTerminal(rec.Status) {
			continue
		}
		if ua := m.updatedAt[rk]; ua < olderThanMs {
			out = append(out, Orphan{KeyID: rk.keyID, Cloid: rk.cloid, Nonce: rec.Nonce, Status: rec.Status, UpdatedAtMs: ua})
		}
	}
	return out, nil
}

// compile-time assertion that Mem satisfies Ledger.
var _ Ledger = (*Mem)(nil)
