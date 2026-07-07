package singlewriter

import (
	"context"
	"sync"
)

// Mem is an in-process Writer: a mutex-guarded map of per-key State applying the
// pure decide transition. It is the single-instance reference implementation and
// the fast unit-test fixture; the cross-host authority is a Postgres-backed
// Writer (a later slice) that applies the SAME decide inside a transaction.
type Mem struct {
	mu    sync.Mutex
	state map[string]State
}

// NewMem returns an empty in-memory Writer.
func NewMem() *Mem { return &Mem{state: make(map[string]State)} }

// Authorize applies decide under a single lock: atomic check-and-reserve. On an
// accepted grant the new State is persisted; every reject leaves State untouched.
func (m *Mem) Authorize(_ context.Context, r Request) (Grant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, g, err := decide(m.state[r.KeyID], r)
	if err != nil {
		return Grant{}, err
	}
	m.state[r.KeyID] = next
	return g, nil
}
