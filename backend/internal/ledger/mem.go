package ledger

import (
	"context"
	"sync"

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
	mu      sync.Mutex
	sw      map[string]singlewriter.State
	records map[recordKey]Record
}

// NewMem returns an empty in-memory Authorizer.
func NewMem() *Mem {
	return &Mem{sw: make(map[string]singlewriter.State), records: make(map[recordKey]Record)}
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
	}
	return g, nil
}

// compile-time assertion that Mem satisfies Authorizer.
var _ Authorizer = (*Mem)(nil)
