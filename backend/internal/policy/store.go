package policy

import (
	"strings"
	"sync"
)

type ownerIPBudget struct {
	ratePerSec float64
	burst      float64
}

func ownerKey(addr string) string { return strings.ToLower(strings.TrimSpace(addr)) }

func limitAtMost(cur, other float64) bool {
	switch {
	case cur == other:
		return true
	case cur == 0:
		return false
	case other == 0:
		return true
	default:
		return cur <= other
	}
}

func ipBudgetAtMost(cur, other ownerIPBudget) bool {
	return limitAtMost(cur.ratePerSec, other.ratePerSec) && limitAtMost(cur.burst, other.burst)
}

func addressCapAtMost(cur, other float64) bool {
	return limitAtMost(cur, other)
}

// Store is a concurrency-safe registry of per-key policy Config bound at the
// signing boundary. A keyID with no Config returns the zero-value Config, which
// Evaluate denies (default-deny / fail-closed).
type Store struct {
	mu                   sync.RWMutex
	byKey                map[string]Config
	ownerIPConflict      map[string]bool
	ownerAddressConflict map[string]bool
	keyOwnerIPConflict   map[string]bool
	keyOwnerAddrConflict map[string]bool
}

// NewStore returns an empty policy store.
func NewStore() *Store {
	return &Store{
		byKey:                make(map[string]Config),
		ownerIPConflict:      make(map[string]bool),
		ownerAddressConflict: make(map[string]bool),
		keyOwnerIPConflict:   make(map[string]bool),
		keyOwnerAddrConflict: make(map[string]bool),
	}
}

func (s *Store) recomputeOwnerConflictsLocked(owner string) {
	if owner == "" {
		return
	}
	type ownerEntry struct {
		keyID string
		cfg   Config
	}
	seen := false
	entries := make([]ownerEntry, 0)
	var ip ownerIPBudget
	var addrCap float64
	ipConflict, addrConflict := false, false
	for keyID, cfg := range s.byKey {
		if ownerKey(cfg.OwnerAddress) != owner {
			continue
		}
		entries = append(entries, ownerEntry{keyID: keyID, cfg: cfg})
		curIP := ownerIPBudget{ratePerSec: cfg.IPRatePerSec, burst: cfg.IPRateBurst}
		if !seen {
			seen = true
			ip = curIP
			addrCap = cfg.AddressDailyMaxNotionalUsdc
			continue
		}
		if curIP != ip {
			ipConflict = true
		}
		if cfg.AddressDailyMaxNotionalUsdc != addrCap {
			addrConflict = true
		}
	}
	if !seen {
		delete(s.ownerIPConflict, owner)
		delete(s.ownerAddressConflict, owner)
		return
	}
	if ipConflict {
		s.ownerIPConflict[owner] = true
	} else {
		delete(s.ownerIPConflict, owner)
	}
	if addrConflict {
		s.ownerAddressConflict[owner] = true
	} else {
		delete(s.ownerAddressConflict, owner)
	}
	for _, entry := range entries {
		curIP := ownerIPBudget{ratePerSec: entry.cfg.IPRatePerSec, burst: entry.cfg.IPRateBurst}
		keyIPConflict, keyAddrConflict := false, false
		for _, other := range entries {
			otherIP := ownerIPBudget{ratePerSec: other.cfg.IPRatePerSec, burst: other.cfg.IPRateBurst}
			if !ipBudgetAtMost(curIP, otherIP) {
				keyIPConflict = true
			}
			if !addressCapAtMost(entry.cfg.AddressDailyMaxNotionalUsdc, other.cfg.AddressDailyMaxNotionalUsdc) {
				keyAddrConflict = true
			}
			if keyIPConflict && keyAddrConflict {
				break
			}
		}
		if keyIPConflict {
			s.keyOwnerIPConflict[entry.keyID] = true
		} else {
			delete(s.keyOwnerIPConflict, entry.keyID)
		}
		if keyAddrConflict {
			s.keyOwnerAddrConflict[entry.keyID] = true
		} else {
			delete(s.keyOwnerAddrConflict, entry.keyID)
		}
	}
}

// Set binds (or replaces) the policy Config for keyID.
func (s *Store) Set(keyID string, cfg Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	oldOwner := ownerKey(s.byKey[keyID].OwnerAddress)
	s.byKey[keyID] = cfg
	newOwner := ownerKey(cfg.OwnerAddress)
	delete(s.keyOwnerIPConflict, keyID)
	delete(s.keyOwnerAddrConflict, keyID)
	s.recomputeOwnerConflictsLocked(oldOwner)
	if newOwner != oldOwner {
		s.recomputeOwnerConflictsLocked(newOwner)
	}
}

// Get returns the Config for keyID, or the zero-value Config (default-deny) if unset.
func (s *Store) Get(keyID string) Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byKey[keyID]
}

func (s *Store) OwnerIPBudgetConflict(owner string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ownerIPConflict[ownerKey(owner)]
}

func (s *Store) OwnerAddressBudgetConflict(owner string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ownerAddressConflict[ownerKey(owner)]
}

func (s *Store) KeyOwnerIPBudgetConflict(keyID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.keyOwnerIPConflict[keyID]
}

func (s *Store) KeyOwnerAddressBudgetConflict(keyID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.keyOwnerAddrConflict[keyID]
}
