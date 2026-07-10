// Package wsshard assigns offline agentic users to a fixed pool of WebSocket
// shards under Hyperliquid's「≤N unique users per IP」hard limit. It is a pure
// accounting library: it holds no WS connections and performs no IO (that is the
// M3 privatefeed transport layer). Allocation is least-loaded; admission is
// idempotent; release is explicit; a full pool denies admission so the caller
// can fall back to polling. It is fail-closed (invalid config or address denies)
// and safe for concurrent use.
package wsshard

import (
	"fmt"
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

// Admit stub — replaced in Task 2.
func (a *Allocator) Admit(user string) (int, bool) { return -1, false }

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
