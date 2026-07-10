# WS 分片配额 (`internal/wsshard`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `backend/internal/wsshard`, a pure accounting library that assigns offline agentic users to a fixed pool of WS shards under HL's「≤N unique users/IP」hard limit, with least-loaded allocation, idempotent admit, explicit release, full→deny (fallback-to-polling signal), fail-closed config/address handling, and concurrency safety.

**Architecture:** One package, one file (`wsshard.go`) + one test file (`wsshard_test.go`). A single `Allocator` holds a `sync.Mutex`, a `[]int` per-shard load, a `map[string]int` user→shard assignment, a `deniedFull` counter, and a `failClosed` flag. All exported methods lock the mutex. No IO, no WS transport (that is M3 `privatefeed`). Mirrors the shape of `internal/ratelimit` (pure, fail-closed, concurrent-safe).

**Tech Stack:** Go (stdlib only: `encoding/hex`, `fmt`, `strings`, `sync`). Backend is its own Go module under `backend/`.

**Reference spec:** `docs/superpowers/specs/2026-07-10-ws-shard-quota-design.md`

**Branch:** create `feat/ws-shard-quota` off `main` before Task 1.

---

## File Structure

- Create: `backend/internal/wsshard/wsshard.go` — `Allocator`, `Stats`, `New`, `Admit`, `Release`, `Assignment`, `Stats()`, unexported `normalizeAddr`.
- Create: `backend/internal/wsshard/wsshard_test.go` — all unit + race tests.

All work lands in these two files. No other package changes (M3 will consume later).

---

## Preliminary: create feature branch

- [ ] **Step 0: Branch from a clean main**

Run:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git checkout main && git pull --ff-only && git checkout -b feat/ws-shard-quota
```
Expected: switched to a new branch `feat/ws-shard-quota`.

---

## Task 1: Package skeleton — `New` + `Stats`

**Files:**
- Create: `backend/internal/wsshard/wsshard.go`
- Test: `backend/internal/wsshard/wsshard_test.go`

- [ ] **Step 1: Write the failing test**

Create `backend/internal/wsshard/wsshard_test.go`:

```go
package wsshard

import (
	"sync"
	"testing"
)

func TestNewValidConfigStats(t *testing.T) {
	a, err := New(3, 10)
	if err != nil {
		t.Fatalf("New(3,10) err = %v, want nil", err)
	}
	s := a.Stats()
	if s.NumShards != 3 || s.MaxPerShard != 10 {
		t.Fatalf("dims = (%d,%d), want (3,10)", s.NumShards, s.MaxPerShard)
	}
	if s.Capacity != 30 || s.Admitted != 0 || s.Free != 30 {
		t.Fatalf("cap/admitted/free = (%d,%d,%d), want (30,0,30)", s.Capacity, s.Admitted, s.Free)
	}
	if len(s.ShardLoad) != 3 {
		t.Fatalf("len(ShardLoad) = %d, want 3", len(s.ShardLoad))
	}
	for i, l := range s.ShardLoad {
		if l != 0 {
			t.Fatalf("ShardLoad[%d] = %d, want 0", i, l)
		}
	}
	if s.DeniedFull != 0 {
		t.Fatalf("DeniedFull = %d, want 0", s.DeniedFull)
	}
}

func TestNewInvalidConfigFailClosed(t *testing.T) {
	for _, tc := range []struct{ n, m int }{{0, 10}, {3, 0}, {-1, 10}, {3, -1}, {0, 0}} {
		a, err := New(tc.n, tc.m)
		if err == nil {
			t.Fatalf("New(%d,%d) err = nil, want non-nil", tc.n, tc.m)
		}
		if a == nil {
			t.Fatalf("New(%d,%d) returned nil *Allocator; must be non-nil fail-closed", tc.n, tc.m)
		}
		if sid, ok := a.Admit("0x000000000000000000000000000000000000dEaD"); ok || sid != -1 {
			t.Fatalf("fail-closed Admit = (%d,%v), want (-1,false)", sid, ok)
		}
		s := a.Stats()
		if s.Capacity != 0 || s.Admitted != 0 || s.Free != 0 {
			t.Fatalf("fail-closed Stats cap/admitted/free = (%d,%d,%d), want (0,0,0)", s.Capacity, s.Admitted, s.Free)
		}
	}
}

var _ = sync.Mutex{} // keep sync imported for later tasks
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/wsshard/`
Expected: FAIL — compile error, `undefined: New` (package `wsshard` has no non-test file yet).

- [ ] **Step 3: Write minimal implementation**

Create `backend/internal/wsshard/wsshard.go`:

```go
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

// Admit is defined in Task 2.

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
```

Note: the test references `Admit`, which does not exist yet, so the package will not compile until Task 2. To let Task 1 pass on its own, add a temporary stub at the end of `wsshard.go`:

```go
// Admit stub — replaced in Task 2.
func (a *Allocator) Admit(user string) (int, bool) { return -1, false }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/wsshard/`
Expected: PASS (`TestNewValidConfigStats`, `TestNewInvalidConfigFailClosed`). The fail-closed Admit test passes against the stub.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/wsshard/wsshard.go backend/internal/wsshard/wsshard_test.go && \
  git commit -m "feat(wsshard): allocator skeleton with New + Stats (fail-closed config)"
```

---

## Task 2: `normalizeAddr` + idempotent `Admit` (single shard)

**Files:**
- Modify: `backend/internal/wsshard/wsshard.go`
- Test: `backend/internal/wsshard/wsshard_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/wsshard/wsshard_test.go`:

```go
func TestAdmitIdempotentAndNormalized(t *testing.T) {
	a, _ := New(1, 10)
	const mixed = "0xAbC0000000000000000000000000000000000001"
	sid, ok := a.Admit(mixed)
	if !ok || sid != 0 {
		t.Fatalf("first Admit = (%d,%v), want (0,true)", sid, ok)
	}
	// Same address in different case / with whitespace = same user, same shard, no new slot.
	sid2, ok2 := a.Admit("  0xabc0000000000000000000000000000000000001  ")
	if !ok2 || sid2 != 0 {
		t.Fatalf("idempotent Admit = (%d,%v), want (0,true)", sid2, ok2)
	}
	if got := a.Stats().Admitted; got != 1 {
		t.Fatalf("Admitted = %d, want 1 (idempotent must not consume a new slot)", got)
	}
}

func TestAdmitRejectsInvalidAddress(t *testing.T) {
	a, _ := New(1, 10)
	for _, bad := range []string{"", "0x", "not-an-address", "0x123", "0xZZ00000000000000000000000000000000000001", "000000000000000000000000000000000000dEaD"} {
		if sid, ok := a.Admit(bad); ok || sid != -1 {
			t.Fatalf("Admit(%q) = (%d,%v), want (-1,false)", bad, sid, ok)
		}
	}
	if got := a.Stats().Admitted; got != 0 {
		t.Fatalf("Admitted = %d, want 0 after only invalid admits", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/wsshard/ -run 'TestAdmit'`
Expected: FAIL — the stub `Admit` returns `(-1,false)` for everything, so `TestAdmitIdempotentAndNormalized` fails at the first Admit.

- [ ] **Step 3: Write minimal implementation**

In `backend/internal/wsshard/wsshard.go`: (a) add `encoding/hex` and `strings` to the import block so it reads:

```go
import (
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
)
```

(b) Replace the `// Admit stub — replaced in Task 2.` block with the real method plus the helper:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/wsshard/`
Expected: PASS (all Task 1 + Task 2 tests). The fail-closed test from Task 1 still passes: `failClosed` short-circuits after address validation.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/wsshard/wsshard.go backend/internal/wsshard/wsshard_test.go && \
  git commit -m "feat(wsshard): idempotent Admit with address normalization + fail-closed"
```

---

## Task 3: least-loaded allocation + tie-break

**Files:**
- Test only: `backend/internal/wsshard/wsshard_test.go` (behavior already implemented in Task 2; this task locks it with dedicated tests)

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/wsshard/wsshard_test.go`:

```go
// admitN admits n distinct valid addresses and returns the shard each landed on.
func admitN(t *testing.T, a *Allocator, n int) []int {
	t.Helper()
	got := make([]int, 0, n)
	for i := 1; i <= n; i++ {
		addr := fmt.Sprintf("0x%040x", i)
		sid, ok := a.Admit(addr)
		if !ok {
			t.Fatalf("Admit #%d unexpectedly denied", i)
		}
		got = append(got, sid)
	}
	return got
}

func TestAdmitLeastLoadedRoundRobinsTies(t *testing.T) {
	a, _ := New(3, 10)
	// With all shards equal, least-loaded + lowest-index tie-break lays users out
	// 0,1,2,0,1,2,... so load stays balanced.
	got := admitN(t, a, 6)
	want := []int{0, 1, 2, 0, 1, 2}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("assignment[%d] = %d, want %d (seq=%v)", i, got[i], want[i], got)
		}
	}
	load := a.Stats().ShardLoad
	for i, l := range load {
		if l != 2 {
			t.Fatalf("ShardLoad[%d] = %d, want 2 (balanced), load=%v", i, l, load)
		}
	}
}

func TestAdmitPrefersEmptierShardAfterRelease(t *testing.T) {
	a, _ := New(2, 10)
	// Fill shard 0 and shard 1 to load 2 each (users u1..u4 -> 0,1,0,1).
	admitN(t, a, 4)
	// Release both users on shard 0 (u1 and u3 landed on shard 0).
	if !a.Release("0x" + fmt.Sprintf("%040x", 1)) {
		t.Fatal("release u1 failed")
	}
	if !a.Release("0x" + fmt.Sprintf("%040x", 3)) {
		t.Fatal("release u3 failed")
	}
	// Now shard 0 load=0, shard 1 load=2. Next admit must pick shard 0.
	sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", 99))
	if !ok || sid != 0 {
		t.Fatalf("Admit after release = (%d,%v), want (0,true) — least-loaded must pick emptier shard", sid, ok)
	}
}
```

Add `"fmt"` to the test file's import block:

```go
import (
	"fmt"
	"sync"
	"testing"
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/wsshard/ -run 'TestAdmitLeastLoaded|TestAdmitPrefersEmptier'`
Expected: FAIL to compile — `TestAdmitPrefersEmptierShardAfterRelease` calls `a.Release`, which is not implemented until Task 4. (`undefined: (*Allocator).Release`).

- [ ] **Step 3: Write minimal implementation**

No production change needed for least-loaded (done in Task 2), but `Release` is required to compile. Add it now to `backend/internal/wsshard/wsshard.go`, immediately after `Admit`:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/wsshard/`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/wsshard/wsshard.go backend/internal/wsshard/wsshard_test.go && \
  git commit -m "feat(wsshard): Release + lock least-loaded allocation with tests"
```

---

## Task 4: full pool denies + `DeniedFull` counter

**Files:**
- Test only: `backend/internal/wsshard/wsshard_test.go` (behavior implemented in Task 2; lock it here)

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/wsshard/wsshard_test.go`:

```go
func TestAdmitFullPoolDeniesAndCounts(t *testing.T) {
	a, _ := New(2, 2) // capacity 4
	admitN(t, a, 4)   // fill to capacity
	if got := a.Stats().Free; got != 0 {
		t.Fatalf("Free = %d, want 0 after filling capacity", got)
	}
	// Next two distinct users are denied and increment DeniedFull.
	for i := 5; i <= 6; i++ {
		if sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", i)); ok || sid != -1 {
			t.Fatalf("Admit over capacity = (%d,%v), want (-1,false)", sid, ok)
		}
	}
	if got := a.Stats().DeniedFull; got != 2 {
		t.Fatalf("DeniedFull = %d, want 2", got)
	}
	// An already-admitted user is still served (idempotent), not counted as denial.
	if sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", 1)); !ok || sid < 0 {
		t.Fatalf("idempotent Admit at capacity = (%d,%v), want (>=0,true)", sid, ok)
	}
	if got := a.Stats().DeniedFull; got != 2 {
		t.Fatalf("DeniedFull = %d after idempotent hit, want 2 (unchanged)", got)
	}
	// Releasing one slot lets a new user in again.
	if !a.Release("0x" + fmt.Sprintf("%040x", 2)) {
		t.Fatal("release failed")
	}
	if sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", 7)); !ok || sid < 0 {
		t.Fatalf("Admit after freeing a slot = (%d,%v), want (>=0,true)", sid, ok)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/wsshard/ -run TestAdmitFullPoolDeniesAndCounts`
Expected: PASS immediately (behavior already implemented). If it PASSES, that is acceptable — this task is a characterization test locking existing behavior; proceed to commit. If it FAILS, fix `Admit`'s `deniedFull++` / full-detection path until it passes.

- [ ] **Step 3: (no production change expected)**

The full-pool path was implemented in Task 2. Only add code if Step 2 revealed a defect.

- [ ] **Step 4: Run full package test**

Run: `cd backend && go test ./internal/wsshard/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/wsshard/wsshard_test.go && \
  git commit -m "test(wsshard): lock full-pool denial + DeniedFull counter"
```

---

## Task 5: `Assignment` lookup

**Files:**
- Modify: `backend/internal/wsshard/wsshard.go`
- Test: `backend/internal/wsshard/wsshard_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/wsshard/wsshard_test.go`:

```go
func TestAssignmentLookup(t *testing.T) {
	a, _ := New(2, 10)
	const u = "0x00000000000000000000000000000000000000AA"
	if sid, ok := a.Assignment(u); ok || sid != -1 {
		t.Fatalf("Assignment before admit = (%d,%v), want (-1,false)", sid, ok)
	}
	want, _ := a.Admit(u)
	// Lookup is case-insensitive and does not change state.
	sid, ok := a.Assignment("0x00000000000000000000000000000000000000aa")
	if !ok || sid != want {
		t.Fatalf("Assignment after admit = (%d,%v), want (%d,true)", sid, ok, want)
	}
	if got := a.Stats().Admitted; got != 1 {
		t.Fatalf("Assignment must not admit: Admitted = %d, want 1", got)
	}
	if sid, ok := a.Assignment("garbage"); ok || sid != -1 {
		t.Fatalf("Assignment(invalid) = (%d,%v), want (-1,false)", sid, ok)
	}
	a.Release(u)
	if sid, ok := a.Assignment(u); ok || sid != -1 {
		t.Fatalf("Assignment after release = (%d,%v), want (-1,false)", sid, ok)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/wsshard/ -run TestAssignmentLookup`
Expected: FAIL to compile — `undefined: (*Allocator).Assignment`.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/internal/wsshard/wsshard.go`, after `Release`:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/wsshard/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/wsshard/wsshard.go backend/internal/wsshard/wsshard_test.go && \
  git commit -m "feat(wsshard): Assignment lookup (read-only, fail-closed)"
```

---

## Task 6: invariants, Stats-copy isolation, and concurrency (`-race`)

**Files:**
- Test only: `backend/internal/wsshard/wsshard_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/wsshard/wsshard_test.go`:

```go
func TestStatsShardLoadIsCopy(t *testing.T) {
	a, _ := New(2, 10)
	a.Admit("0x" + fmt.Sprintf("%040x", 1))
	s := a.Stats()
	s.ShardLoad[0] = 999 // mutate the returned slice
	if got := a.Stats().ShardLoad[0]; got == 999 {
		t.Fatal("Stats().ShardLoad must be a copy; caller mutation leaked into allocator")
	}
}

func TestInvariantsUnderMixedOps(t *testing.T) {
	a, _ := New(4, 5) // capacity 20
	// Admit 20, release every other, admit 10 more; invariants must always hold.
	for i := 1; i <= 20; i++ {
		a.Admit("0x" + fmt.Sprintf("%040x", i))
	}
	for i := 1; i <= 20; i += 2 {
		a.Release("0x" + fmt.Sprintf("%040x", i))
	}
	for i := 100; i < 110; i++ {
		a.Admit("0x" + fmt.Sprintf("%040x", i))
	}
	s := a.Stats()
	sum := 0
	for i, l := range s.ShardLoad {
		if l < 0 || l > s.MaxPerShard {
			t.Fatalf("ShardLoad[%d] = %d out of [0,%d]", i, l, s.MaxPerShard)
		}
		sum += l
	}
	if sum != s.Admitted {
		t.Fatalf("sum(ShardLoad)=%d != Admitted=%d", sum, s.Admitted)
	}
	if s.Free != s.Capacity-s.Admitted {
		t.Fatalf("Free=%d != Capacity-Admitted=%d", s.Free, s.Capacity-s.Admitted)
	}
}

func TestConcurrentAdmitReleaseStats(t *testing.T) {
	a, _ := New(8, 10) // capacity 80
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				addr := "0x" + fmt.Sprintf("%040x", g*1000+i%50)
				switch i % 3 {
				case 0:
					a.Admit(addr)
				case 1:
					a.Release(addr)
				default:
					_ = a.Stats()
					_, _ = a.Assignment(addr)
				}
			}
		}(g)
	}
	wg.Wait()
	// Final invariant: sum of shard loads equals Admitted, none over cap.
	s := a.Stats()
	sum := 0
	for i, l := range s.ShardLoad {
		if l < 0 || l > s.MaxPerShard {
			t.Fatalf("post-race ShardLoad[%d]=%d out of [0,%d]", i, l, s.MaxPerShard)
		}
		sum += l
	}
	if sum != s.Admitted {
		t.Fatalf("post-race sum(ShardLoad)=%d != Admitted=%d", sum, s.Admitted)
	}
}
```

Remove the now-unnecessary `var _ = sync.Mutex{}` line added in Task 1 (this test file now uses `sync.WaitGroup`, so `sync` is a real import).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/wsshard/ -run 'TestStatsShardLoadIsCopy|TestInvariants|TestConcurrent'`
Expected: PASS for invariants/concurrency (behavior already correct) and `TestStatsShardLoadIsCopy` also PASS because `Stats()` already copies. This task characterizes concurrency safety; the value is running it under `-race` in Step 4.

- [ ] **Step 3: (no production change expected)**

If `TestStatsShardLoadIsCopy` fails, ensure `Stats()` builds `loadCopy` via `make`+`copy` (already in Task 1). If the race detector reports a data race, ensure every method takes `a.mu` — no lock-free reads.

- [ ] **Step 4: Run tests under the race detector**

Run: `cd backend && go test -race ./internal/wsshard/`
Expected: PASS with no `DATA RACE` reports.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/wsshard/wsshard_test.go && \
  git commit -m "test(wsshard): invariants, Stats-copy isolation, and -race concurrency"
```

---

## Task 7: final validation + PR

**Files:** none (validation + PR only)

- [ ] **Step 1: Format, vet, full build, and race test**

Run:
```bash
cd backend && gofmt -w internal/wsshard/wsshard.go internal/wsshard/wsshard_test.go && \
  go test ./internal/wsshard/ && \
  go test -race ./internal/wsshard/ && \
  go vet ./internal/wsshard/ && \
  go build ./...
```
Expected: all pass; `gofmt` produces no further diff; `go vet` and `go build ./...` clean.

- [ ] **Step 2: Commit any gofmt changes (if any)**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add -A backend/internal/wsshard/ && \
  git commit -m "chore(wsshard): gofmt" || echo "nothing to format"
```

- [ ] **Step 3: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/ws-shard-quota && \
  gh pr create --fill --title "feat(backend): WS 分片配额 internal/wsshard 分配/准入治理库（M10）" \
    --body "M10 收尾项：私有 WS 分片分配/准入治理库。建模 HL「≤N 唯一用户/IP」硬限，least-loaded 分配、幂等 Admit、显式 Release、全满拒绝→回退轮询、fail-closed、并发安全。纯记账库，不含 WS 传输（M3 privatefeed 消费）。Spec: docs/superpowers/specs/2026-07-10-ws-shard-quota-design.md"
```
Expected: PR created on `lumos-forge/HyperSolid`.

- [ ] **Step 4: After review + green CI, merge**

Per repository workflow, once spec/quality/holistic reviews pass and CI is green, merge directly:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §4 API (New/Admit/Release/Assignment/Stats) → Tasks 1,2,3,5; §5.2 least-loaded + tie-break → Task 3; §5.3 fail-closed (config/address/full) → Tasks 1,2,4; §5.4 invariants → Task 6; §6 concurrency + Stats copy → Task 6; §7 test plan items 1–9 → Tasks 1–6; §8 validation commands → Task 7. All covered.
- **No placeholders:** every code step contains complete, compilable Go.
- **Type consistency:** `Allocator`, `Stats` fields (`NumShards`, `MaxPerShard`, `Capacity`, `Admitted`, `Free`, `ShardLoad`, `DeniedFull`), and method signatures (`Admit(string)(int,bool)`, `Release(string)bool`, `Assignment(string)(int,bool)`, `Stats()Stats`, `normalizeAddr(string)(string,bool)`) are identical across all tasks and match the spec.
- **Import hygiene:** production imports `encoding/hex`, `fmt`, `strings`, `sync`; test imports `fmt`, `sync`, `testing`. The temporary `var _ = sync.Mutex{}` in Task 1 is removed in Task 6 when `sync.WaitGroup` becomes a real use.
