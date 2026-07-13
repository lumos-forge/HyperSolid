package keystore

import (
	"context"
	"fmt"
	"sync"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
)

// Manager is the signer's key-custody API: it generates/holds agent keys inside the process,
// persists them encrypted (Vault), and reloads them at startup. Private key material never
// leaves the process.
type Manager struct {
	registry *Keystore
	vault    Vault
	kek      []byte
	mu       sync.RWMutex
	addrs    map[string]string // keyID -> agent address
}

func NewManager(registry *Keystore, vault Vault, kek []byte) *Manager {
	return &Manager{registry: registry, vault: vault, kek: kek, addrs: make(map[string]string)}
}

// Provision generates a fresh secp256k1 key, seals+persists it, registers it for signing, and
// returns the agent address.
func (m *Manager) Provision(ctx context.Context, keyID string) (string, error) {
	pk, err := secp.GeneratePrivateKey()
	if err != nil {
		return "", err
	}
	priv := pk.Serialize()
	addr, err := hl.AddressFromPriv(priv)
	if err != nil {
		return "", err
	}
	enc, err := Seal(m.kek, priv)
	if err != nil {
		return "", err
	}
	if err := m.vault.Put(ctx, Record{KeyID: keyID, AgentAddress: addr, EncPriv: enc}); err != nil {
		return "", err
	}
	if err := m.registry.Add(keyID, priv); err != nil {
		_ = m.vault.Delete(ctx, keyID) // no orphaned encrypted key
		return "", err
	}
	m.setAddr(keyID, addr)
	return addr, nil
}

// Load decrypts every persisted key into the in-memory registry + address map.
func (m *Manager) Load(ctx context.Context) error {
	recs, err := m.vault.List(ctx)
	if err != nil {
		return err
	}
	for _, r := range recs {
		priv, err := Open(m.kek, r.EncPriv)
		if err != nil {
			return fmt.Errorf("keystore: decrypt %s: %w", r.KeyID, err)
		}
		if err := m.registry.Add(r.KeyID, priv); err != nil {
			return fmt.Errorf("keystore: register %s: %w", r.KeyID, err)
		}
		m.setAddr(r.KeyID, r.AgentAddress)
	}
	return nil
}

// Remove zeroizes (registry) + deletes (vault) the key.
func (m *Manager) Remove(ctx context.Context, keyID string) error {
	m.registry.Remove(keyID)
	m.mu.Lock()
	delete(m.addrs, keyID)
	m.mu.Unlock()
	return m.vault.Delete(ctx, keyID)
}

// AgentAddress returns the agent address bound to a keyID.
func (m *Manager) AgentAddress(keyID string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.addrs[keyID]
	return a, ok
}

func (m *Manager) setAddr(keyID, addr string) {
	m.mu.Lock()
	m.addrs[keyID] = addr
	m.mu.Unlock()
}
