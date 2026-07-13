package keystore

import (
	"context"
	"sync"
)

// Record is a persisted, encrypted agent key: EncPriv = Seal(kek, priv).
type Record struct {
	KeyID        string
	AgentAddress string
	EncPriv      []byte
}

// Vault is durable, encrypted-at-rest persistence for agent keys.
type Vault interface {
	Put(ctx context.Context, r Record) error        // upsert by KeyID
	List(ctx context.Context) ([]Record, error)     // all records
	Delete(ctx context.Context, keyID string) error // idempotent
}

// MemVault is an in-memory Vault for tests and the no-DB path.
type MemVault struct {
	mu   sync.Mutex
	byID map[string]Record
}

func NewMemVault() *MemVault { return &MemVault{byID: make(map[string]Record)} }

func (m *MemVault) Put(_ context.Context, r Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byID[r.KeyID] = r
	return nil
}

func (m *MemVault) List(_ context.Context) ([]Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Record, 0, len(m.byID))
	for _, r := range m.byID {
		out = append(out, r)
	}
	return out, nil
}

func (m *MemVault) Delete(_ context.Context, keyID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byID, keyID)
	return nil
}
