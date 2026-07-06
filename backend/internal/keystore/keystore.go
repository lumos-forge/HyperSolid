// Package keystore holds tier-① in-process HL signers keyed by an opaque keyID.
// Removing or closing a key zeroizes the underlying secp256k1 material (hl.Signer.Close).
// It performs NO policy checks — a reject-first policy layer must wrap it before any
// production use (see docs/BACKEND-ARCHITECTURE.md §5.1a).
package keystore

import (
	"sync"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
)

// Keystore is a concurrency-safe registry of keyID -> *hl.Signer.
type Keystore struct {
	mu   sync.RWMutex
	byID map[string]*hl.Signer
}

// New returns an empty keystore.
func New() *Keystore {
	return &Keystore{byID: make(map[string]*hl.Signer)}
}

// Add registers a signer for keyID from a 32-byte private key. If keyID already exists,
// the old signer is closed (zeroized) and replaced. Returns an error on an invalid key
// (nothing is stored in that case).
func (k *Keystore) Add(keyID string, priv []byte) error {
	s, err := hl.NewSigner(priv)
	if err != nil {
		return err
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if old, ok := k.byID[keyID]; ok {
		old.Close()
	}
	k.byID[keyID] = s
	return nil
}

// Signer returns the signer for keyID, or (nil, false) if absent.
func (k *Keystore) Signer(keyID string) (*hl.Signer, bool) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	s, ok := k.byID[keyID]
	return s, ok
}

// Remove closes (zeroizes) and deletes the signer for keyID, if present.
func (k *Keystore) Remove(keyID string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if s, ok := k.byID[keyID]; ok {
		s.Close()
		delete(k.byID, keyID)
	}
}

// Close closes (zeroizes) all signers and empties the store.
func (k *Keystore) Close() {
	k.mu.Lock()
	defer k.mu.Unlock()
	for id, s := range k.byID {
		s.Close()
		delete(k.byID, id)
	}
}
