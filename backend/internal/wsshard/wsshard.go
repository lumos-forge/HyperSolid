// Package wsshard assigns offline agentic users to a fixed pool of WebSocket
// shards under Hyperliquid's「≤N unique users per IP」hard limit. It is a pure
// accounting library: it holds no WS connections and performs no IO (that is the
// M3 privatefeed transport layer). Allocation is least-loaded; admission is
// idempotent; release is explicit; a full pool denies admission so the caller
// can fall back to polling. It is fail-closed (invalid config or address denies)
// and safe for concurrent use.
package wsshard

import (
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
)

// Allocator is a fixed-pool user→shard assigner.
type Allocator struct {
	mu          sync.Mutex
	numShards   int
	maxPerShard int
	load        []int          // per-shard user count, len == numShards
	assign      map[string]int // normalized user address -> shardID
	deniedFull  uint64         // cumulative admits denied because the pool was full
	failClosed  bool           // true when config is invalid: all Admit deny
}

// Stats is an observability snapshot.
type Stats struct {
	NumShards   int
	MaxPerShard int
	Capacity    int   // NumShards * MaxPerShard
	Admitted    int   // users currently on the books
	Free        int   // Capacity - Admitted
	ShardLoad   []int // per-shard user count, len == NumShards (copy)
	DeniedFull  uint64
}

// New builds a fixed-pool allocator. numShards and maxPerShard must both be > 0;
// otherwise it returns a non-nil fail-closed allocator (every Admit denies, Stats
// reports zero capacity) together with a non-nil error. The allocator is always
// non-nil so callers can use it safely without a nil check.
func New(numShards, maxPerShard int) (*Allocator, error) {
	if numShards <= 0 || maxPerShard <= 0 {
		return &Allocator{failClosed: true, assign: map[string]int{}},
			fmt.Errorf("wsshard: invalid config numShards=%d maxPerShard=%d (both must be > 0)", numShards, maxPerShard)
	}
	return &Allocator{
		numShards:   numShards,
		maxPerShard: maxPerShard,
		load:        make([]int, numShards),
		assign:      make(map[string]int, numShards*maxPerShard),
	}, nil
}

// normalizeAddr lowercases/trims addr and validates it as a 20-byte hex EVM
// address (0x + 40 hex chars). It returns ("", false) for anything else.
func normalizeAddr(addr string) (string, bool) {
	a := strings.ToLower(strings.TrimSpace(addr))
	if len(a) != 42 || !strings.HasPrefix(a, "0x") {
		return "", false
	}
	if _, err := hex.DecodeString(a[2:]); err != nil {
		return "", false
	}
	return a, true
}

// Admit idempotently admits user. Fail-closed semantics:
//   - fail-closed allocator (invalid config) or invalid/empty address → (-1, false).
//   - already admitted → its existing (shardID, true), no new slot.
//   - not admitted and a shard has room → least-loaded shard (most free slots;
//     ties broken by lowest index), recorded, returning (shardID, true).
//   - pool full → (-1, false) and DeniedFull++ (caller falls back to polling).
func (a *Allocator) Admit(user string) (int, bool) {
	key, ok := normalizeAddr(user)
	if !ok {
		return -1, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failClosed {
		return -1, false
	}
	if sid, exists := a.assign[key]; exists {
		return sid, true
	}
	best := -1
	for i := 0; i < a.numShards; i++ {
		if a.load[i] >= a.maxPerShard {
			continue
		}
		if best == -1 || a.load[i] < a.load[best] {
			best = i
		}
	}
	if best == -1 {
		a.deniedFull++
		return -1, false
	}
	a.load[best]++
	a.assign[key] = best
	return best, true
}

// Release explicitly releases user (called when the user comes online and the
// client takes over the direct subscription, or when a strategy deactivates),
// freeing the slot. It returns whether the user was on the books. The address is
// normalized; an invalid address returns false.
func (a *Allocator) Release(user string) bool {
	key, ok := normalizeAddr(user)
	if !ok {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	sid, exists := a.assign[key]
	if !exists {
		return false
	}
	delete(a.assign, key)
	a.load[sid]--
	return true
}

// Assignment returns user's current shard without changing state. It returns
// (-1, false) when the user is not on the books or the address is invalid.
func (a *Allocator) Assignment(user string) (int, bool) {
	key, ok := normalizeAddr(user)
	if !ok {
		return -1, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	sid, exists := a.assign[key]
	if !exists {
		return -1, false
	}
	return sid, true
}

// Stats returns the current snapshot. ShardLoad is a copy the caller may retain.
func (a *Allocator) Stats() Stats {
	a.mu.Lock()
	defer a.mu.Unlock()
	loadCopy := make([]int, len(a.load))
	copy(loadCopy, a.load)
	capacity := a.numShards * a.maxPerShard
	admitted := len(a.assign)
	return Stats{
		NumShards:   a.numShards,
		MaxPerShard: a.maxPerShard,
		Capacity:    capacity,
		Admitted:    admitted,
		Free:        capacity - admitted,
		ShardLoad:   loadCopy,
		DeniedFull:  a.deniedFull,
	}
}
