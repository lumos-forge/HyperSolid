package policy

import "sync"

// Store is a concurrency-safe registry of per-key policy Config bound at the
// signing boundary. A keyID with no Config returns the zero-value Config, which
// Evaluate denies (default-deny / fail-closed).
type Store struct {
	mu    sync.RWMutex
	byKey map[string]Config
}

// NewStore returns an empty policy store.
func NewStore() *Store {
	return &Store{byKey: make(map[string]Config)}
}

// Set binds (or replaces) the policy Config for keyID.
func (s *Store) Set(keyID string, cfg Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byKey[keyID] = cfg
}

// Get returns the Config for keyID, or the zero-value Config (default-deny) if unset.
func (s *Store) Get(keyID string) Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byKey[keyID]
}
