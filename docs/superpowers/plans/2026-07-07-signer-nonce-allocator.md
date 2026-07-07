# `internal/nonce` 单调 nonce 分配器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增自包含的进程内每-key 单调递增 ms nonce 分配器 `internal/nonce.Allocator`（`Next`）+ HL 窗口校验器 `WithinWindow`；可注入时钟、并发安全、不接线。

**Architecture:** 单个纯 Go 包，标准库 `sync`/`time`。`Next` = `max(now, last+1)` 保证严格递增、绝不复用（时钟停滞/回拨也如此）；互斥锁 = 进程内单写者。用 table/并发测试覆盖递增、隔离、窗口边界。

**Tech Stack:** Go（`backend/internal/nonce`，标准库，`go test`）。

---

## File Structure

- `backend/internal/nonce/nonce.go`（新）—— `Allocator`（New/Next）+ `WithinWindow`。
- `backend/internal/nonce/nonce_test.go`（新）—— 递增/回拨/隔离/并发/窗口/默认时钟测试。

## 现有约定（供无上下文的实现者参考）

- 参照 `docs/BACKEND-ARCHITECTURE.md §5`：ms 时间戳 nonce、窗口 (T-2d, T+1d)、每-key 严格递增不复用。目前 nonce 由客户端传入 `cmd/signer` `/v1/sign/l1`；本包不接线。
- Go module `github.com/lumos-forge/hypersolid/backend`。验证 `go test ./...`、`go vet ./...`、`go test -race ./internal/nonce/`。
- 提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: `internal/nonce` 分配器 + 窗口校验

**Files:**
- Create: `backend/internal/nonce/nonce.go`
- Create: `backend/internal/nonce/nonce_test.go`

- [ ] **Step 1: Write the failing tests**

创建 `backend/internal/nonce/nonce_test.go`：

```go
package nonce

import (
	"sync"
	"testing"
	"time"
)

func TestNextStrictlyIncreasesOnStalledClock(t *testing.T) {
	a := New(func() int64 { return 1000 }) // fixed clock
	n1 := a.Next("k1")
	n2 := a.Next("k1")
	if n1 != 1000 {
		t.Fatalf("n1 = %d, want 1000", n1)
	}
	if n2 != n1+1 {
		t.Fatalf("n2 = %d, want %d (strictly increasing)", n2, n1+1)
	}
}

func TestNextStrictlyIncreasesOnRegressingClock(t *testing.T) {
	now := int64(5000)
	a := New(func() int64 { return now })
	n1 := a.Next("k1")
	now = 4000 // clock goes backward
	n2 := a.Next("k1")
	if n2 <= n1 {
		t.Fatalf("n2 = %d must be > n1 = %d despite clock regression", n2, n1)
	}
}

func TestNextFollowsAdvancingClock(t *testing.T) {
	now := int64(1000)
	a := New(func() int64 { return now })
	_ = a.Next("k1") // 1000
	now = 2000
	if n := a.Next("k1"); n != 2000 {
		t.Fatalf("n = %d, want 2000 (follows the clock)", n)
	}
}

func TestNextPerKeyIsolation(t *testing.T) {
	a := New(func() int64 { return 1000 })
	na := a.Next("a") // 1000
	nb := a.Next("b") // 1000 (independent key)
	if na != 1000 || nb != 1000 {
		t.Fatalf("na = %d, nb = %d, want both 1000 (per-key isolation)", na, nb)
	}
}

func TestNextConcurrentUnique(t *testing.T) {
	a := New(func() int64 { return 1000 })
	const n = 500
	var wg sync.WaitGroup
	results := make([]uint64, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			results[idx] = a.Next("k1")
		}(i)
	}
	wg.Wait()
	seen := make(map[uint64]bool, n)
	for _, v := range results {
		if seen[v] {
			t.Fatalf("duplicate nonce %d under concurrency", v)
		}
		seen[v] = true
	}
	if len(seen) != n {
		t.Fatalf("got %d unique nonces, want %d", len(seen), n)
	}
}

func TestWithinWindow(t *testing.T) {
	now := int64(1_700_000_000_000)
	cases := []struct {
		name  string
		nonce uint64
		want  bool
	}{
		{"exactly now", uint64(now), true},
		{"just inside past bound", uint64(now - windowPastMs + 1), true},
		{"at past bound is excluded", uint64(now - windowPastMs), false},
		{"just inside future bound", uint64(now + windowFutureMs - 1), true},
		{"at future bound is excluded", uint64(now + windowFutureMs), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := WithinWindow(c.nonce, now); got != c.want {
				t.Fatalf("WithinWindow(%d, %d) = %v, want %v", c.nonce, now, got, c.want)
			}
		})
	}
}

func TestNewNilClockUsesRealTime(t *testing.T) {
	a := New(nil)
	n := a.Next("k1")
	if !WithinWindow(n, time.Now().UnixMilli()) {
		t.Fatalf("nonce %d from real clock should be within the current window", n)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/nonce/`
Expected: FAIL —— package has no non-test files / `New`/`Allocator.Next`/`WithinWindow`/`windowPastMs`/`windowFutureMs` undefined (compile error).

- [ ] **Step 3: Create nonce.go**

创建 `backend/internal/nonce/nonce.go`：

```go
// Package nonce hands out strictly-increasing millisecond-timestamp nonces per
// key (the single writer WITHIN a process; the cross-process lease/fencing
// single-writer is a separate concern — see docs/BACKEND-ARCHITECTURE.md §5).
package nonce

import (
	"sync"
	"time"
)

// Allocator issues per-key monotonic ms nonces. Safe for concurrent use.
type Allocator struct {
	nowMs func() int64
	mu    sync.Mutex
	last  map[string]uint64
}

// New returns an Allocator. If nowMs is nil, it uses the real clock
// (time.Now().UnixMilli()); tests inject a fake clock for determinism.
func New(nowMs func() int64) *Allocator {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &Allocator{nowMs: nowMs, last: make(map[string]uint64)}
}

// Next returns a strictly-increasing ms nonce for keyID: n = max(now, last+1).
// A stalled or regressing clock still yields a strictly higher nonce than the
// previous one for that key, so a nonce is never reused. Per-key isolated.
func (a *Allocator) Next(keyID string) uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := uint64(a.nowMs())
	if last := a.last[keyID]; n <= last {
		n = last + 1
	}
	a.last[keyID] = n
	return n
}

// HL accepts a nonce only within (T-2days, T+1day) of the current time.
const (
	windowPastMs   int64 = 2 * 24 * 60 * 60 * 1000 // 2 days
	windowFutureMs int64 = 1 * 24 * 60 * 60 * 1000 // 1 day
)

// WithinWindow reports whether a nonce (ms) is inside HL's accepted open
// interval (nowMs - 2d, nowMs + 1d).
func WithinWindow(nonce uint64, nowMs int64) bool {
	n := int64(nonce)
	return n > nowMs-windowPastMs && n < nowMs+windowFutureMs
}
```

- [ ] **Step 4: Run tests + race + vet**

Run: `cd backend && go test -race ./internal/nonce/ && go vet ./internal/nonce/`
Expected: PASS (all 7 tests); race clean; vet clean.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/nonce/nonce.go backend/internal/nonce/nonce_test.go
git commit --no-verify -m "feat(backend): internal/nonce in-process monotonic allocator + window (not wired)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（任务完成后）

- `cd backend && go test ./... && go vet ./...` 全绿；`go test -race ./internal/nonce/` 通过。
- `git diff --stat main...HEAD` —— 仅触及：`backend/internal/nonce/{nonce.go,nonce_test.go}` + 两份 docs。无其它改动。
