# 租约持有者心跳（Leader）+ 内存 lease.Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `backend/internal/lease/mem.go`（内存 `lease.Store`，注入时钟）与 `backend/internal/leader`（后台持有并续约一个具名租约、暴露实时 `Fence(epoch, isLeader)` 的心跳循环组件）。

**Architecture:** `lease.Mem` 用 `mutex + map[string]lease.Row` 套用已导出的纯 `lease.Decide`；`leader.Leader` 把「一次获取或续约」拆为确定性 `step(ctx)`（单测直接驱动）+ 薄 `Run(ctx, every)` ticker 循环（退出时 Release）。均纯 Go、无 Docker。

**Tech Stack:** Go 1.26 标准库（`context`/`sync`/`time`/`testing`）+ 现有 `internal/lease` 包。

---

## File Structure

- `backend/internal/lease/mem.go` — `Mem` 内存 `lease.Store` + `NewMem`。（Task 1）
- `backend/internal/lease/mem_test.go` — `Mem` 单元测试（假时钟 + 并发）。（Task 1）
- `backend/internal/leader/leader.go` — `Leader` + `New`/`Fence`/`step`/`Run`。（Task 2）
- `backend/internal/leader/leader_test.go` — `step` 确定性单测 + 一个 `Run` 集成式单测。（Task 2）

> 约定参照：`internal/singlewriter/mem.go`（Mem 风格：注入时钟、mutex+map、套用导出的纯 Decide）。现有 `internal/lease` 已导出 `Lease{Name,Holder,Epoch uint64,ExpiresAtMs int64}`、`Store`、`Row{Holder,Epoch uint64,ExpiresAtMs int64}`、`Op`+`OpAcquire/OpRenew/OpRelease`、`Req{Op,Holder,NowMs,TtlMs int64}`、`Decide`、`ErrHeld/ErrNotHolder/ErrExpired`。模块路径 `github.com/lumos-forge/hypersolid/backend`。提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: 内存 `lease.Store`（`lease.Mem`）

**Files:**
- Create: `backend/internal/lease/mem.go`
- Test: `backend/internal/lease/mem_test.go`

- [ ] **Step 1: 写失败测试**

创建 `backend/internal/lease/mem_test.go`：
```go
package lease

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestMemAcquireRenewStealMonotonic(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()

	l, err := m.Acquire(ctx, "k", "a", time.Second)
	if err != nil || l.Epoch != 1 || l.Holder != "a" || l.Name != "k" {
		t.Fatalf("acquire: l=%+v err=%v, want epoch 1 holder a name k", l, err)
	}
	if _, err := m.Acquire(ctx, "k", "b", time.Second); err != ErrHeld {
		t.Fatalf("acquire b: err=%v, want ErrHeld", err)
	}
	r, err := m.Renew(ctx, "k", "a", time.Second)
	if err != nil || r.Epoch != 1 {
		t.Fatalf("renew: r=%+v err=%v, want epoch 1", r, err)
	}
	now += 2000 // past the 1s TTL
	l2, err := m.Acquire(ctx, "k", "b", time.Second)
	if err != nil || l2.Epoch != 2 || l2.Holder != "b" {
		t.Fatalf("steal expired: l2=%+v err=%v, want epoch 2 holder b", l2, err)
	}
}

func TestMemReleaseKeepsEpochMonotonic(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()
	if _, err := m.Acquire(ctx, "k", "a", time.Second); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := m.Release(ctx, "k", "a"); err != nil {
		t.Fatalf("release: %v", err)
	}
	// after release the lease is expired; b acquires with a HIGHER epoch (not reset)
	l, err := m.Acquire(ctx, "k", "b", time.Second)
	if err != nil || l.Epoch != 2 {
		t.Fatalf("acquire after release: l=%+v err=%v, want epoch 2", l, err)
	}
}

func TestMemReleaseNonHolderNoop(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()
	if _, err := m.Acquire(ctx, "k", "a", time.Second); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := m.Release(ctx, "k", "b"); err != nil { // non-holder → no-op nil
		t.Fatalf("release by non-holder: err=%v, want nil", err)
	}
	// a still holds it (valid)
	if _, err := m.Acquire(ctx, "k", "b", time.Second); err != ErrHeld {
		t.Fatalf("acquire b: err=%v, want ErrHeld (a still holds)", err)
	}
}

func TestMemConcurrentAcquireSingleWinner(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()
	const holders = 50
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, held := 0, 0
	for i := 0; i < holders; i++ {
		h := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.Acquire(ctx, "k", string(rune('A'+h)), time.Minute)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				wins++
			} else if err == ErrHeld {
				held++
			}
		}()
	}
	wg.Wait()
	if wins != 1 || held != holders-1 {
		t.Fatalf("wins=%d held=%d, want 1 and %d", wins, held, holders-1)
	}
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && go test ./internal/lease/ -run TestMem`
Expected: FAIL —— 编译错误 `undefined: NewMem`。

- [ ] **Step 3: 实现 `Mem`**

创建 `backend/internal/lease/mem.go`：
```go
package lease

import (
	"context"
	"sync"
	"time"
)

// Mem is an in-process lease.Store: a mutex-guarded map of per-name Row applying
// the pure Decide transition with an injectable clock. It is the deterministic
// test fixture for the leader loop and a usable single-instance Store; the
// cross-host authority is the Postgres-backed Store (internal/lease/pg).
type Mem struct {
	nowMs func() int64
	mu    sync.Mutex
	rows  map[string]Row
}

// NewMem returns an empty in-memory Store. A nil nowMs uses the real clock
// (time.Now().UnixMilli()); tests inject a fake clock.
func NewMem(nowMs func() int64) *Mem {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &Mem{nowMs: nowMs, rows: make(map[string]Row)}
}

// Acquire implements lease.Store.
func (m *Mem) Acquire(_ context.Context, name, holder string, ttl time.Duration) (Lease, error) {
	return m.op(name, OpAcquire, holder, ttl)
}

// Renew implements lease.Store.
func (m *Mem) Renew(_ context.Context, name, holder string, ttl time.Duration) (Lease, error) {
	return m.op(name, OpRenew, holder, ttl)
}

// Release implements lease.Store.
func (m *Mem) Release(_ context.Context, name, holder string) error {
	_, err := m.op(name, OpRelease, holder, 0)
	return err
}

// op applies Decide under a single lock: an absent name is the zero Row (expired
// seed). On a mutation the next Row is persisted; a typed rejection leaves state
// unchanged; an idempotent no-op (Release by a non-holder) returns nil.
func (m *Mem) op(name string, op Op, holder string, ttl time.Duration) (Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, write, out, err := Decide(
		m.rows[name],
		Req{Op: op, Holder: holder, NowMs: m.nowMs(), TtlMs: ttl.Milliseconds()},
	)
	if err != nil {
		return Lease{}, err
	}
	if write {
		m.rows[name] = next
	}
	out.Name = name
	return out, nil
}

// compile-time assertion that Mem satisfies the Store interface.
var _ Store = (*Mem)(nil)
```

- [ ] **Step 4: 运行验证通过 + vet**

Run: `cd backend && go test ./internal/lease/ && go vet ./internal/lease/`
Expected: PASS（新 4 个 TestMem* + 既有 Decide 测试全过）；vet 无输出。

- [ ] **Step 5: 提交**

```bash
git add backend/internal/lease/mem.go backend/internal/lease/mem_test.go
git commit --no-verify -m "feat(backend): in-memory lease.Store (Mem) with injectable clock

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 心跳/续约循环 `leader.Leader`

**Files:**
- Create: `backend/internal/leader/leader.go`
- Test: `backend/internal/leader/leader_test.go`

- [ ] **Step 1: 写失败测试**

创建 `backend/internal/leader/leader_test.go`：
```go
package leader

import (
	"context"
	"testing"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
)

func TestStepAcquiresThenRenews(t *testing.T) {
	now := int64(1_700_000_000_000)
	store := lease.NewMem(func() int64 { return now })
	ctx := context.Background()
	l := New(store, "signer-leader", "a", time.Second)

	l.step(ctx)
	if e, ok := l.Fence(); !ok || e != 1 {
		t.Fatalf("after first step Fence=(%d,%v), want (1,true)", e, ok)
	}
	// within TTL: step renews, epoch unchanged, still leader.
	now += 300
	l.step(ctx)
	if e, ok := l.Fence(); !ok || e != 1 {
		t.Fatalf("after renew Fence=(%d,%v), want (1,true)", e, ok)
	}
}

func TestStepHeldByOtherNotLeader(t *testing.T) {
	now := int64(1_700_000_000_000)
	store := lease.NewMem(func() int64 { return now })
	ctx := context.Background()
	// a holds it first.
	a := New(store, "signer-leader", "a", time.Second)
	a.step(ctx)
	// b cannot acquire → not leader.
	b := New(store, "signer-leader", "b", time.Second)
	b.step(ctx)
	if e, ok := b.Fence(); ok || e != 0 {
		t.Fatalf("b Fence=(%d,%v), want (0,false)", e, ok)
	}
}

func TestStepFailoverBumpsEpoch(t *testing.T) {
	now := int64(1_700_000_000_000)
	store := lease.NewMem(func() int64 { return now })
	ctx := context.Background()
	a := New(store, "signer-leader", "a", time.Second)
	b := New(store, "signer-leader", "b", time.Second)
	a.step(ctx) // a leader, epoch 1
	now += 2000 // a's lease expires

	b.step(ctx) // b steals → epoch 2, leader
	if e, ok := b.Fence(); !ok || e != 2 {
		t.Fatalf("b Fence=(%d,%v), want (2,true)", e, ok)
	}
	a.step(ctx) // a was leader; renew fails (b holds) → tries acquire → ErrHeld → not leader
	if _, ok := a.Fence(); ok {
		t.Fatalf("a still leader after losing lease, want not leader")
	}
}

func TestRunAcquiresAndReleasesOnCancel(t *testing.T) {
	store := lease.NewMem(nil) // real clock
	l := New(store, "signer-leader", "a", time.Second)
	ctx, cancel := context.WithCancel(context.Background())

	go l.Run(ctx, 5*time.Millisecond)

	// wait until leader (generous timeout).
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := l.Fence(); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Run did not become leader within timeout")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	// after Run exits it Releases; another holder can then acquire.
	deadline = time.Now().Add(2 * time.Second)
	for {
		if _, err := store.Acquire(context.Background(), "signer-leader", "b", time.Second); err == nil {
			return // released as expected
		}
		if time.Now().After(deadline) {
			t.Fatal("lease not released after Run cancelled")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && go test ./internal/leader/`
Expected: FAIL —— 编译错误 `undefined: New`（包尚无实现）。

- [ ] **Step 3: 实现 `Leader`**

创建 `backend/internal/leader/leader.go`：
```go
// Package leader holds a single named lease on behalf of one holder and keeps it
// renewed in the background, exposing the current fencing epoch and leadership
// status. The signing endpoint passes the epoch to singlewriter as Request.Fence
// (a later slice); on a lost/stolen lease the epoch bumps, fencing the old holder
// out at the single-writer layer (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package leader

import (
	"context"
	"sync"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
)

// Leader keeps a named lease renewed and exposes the current fencing epoch.
type Leader struct {
	store  lease.Store
	name   string
	holder string
	ttl    time.Duration

	mu       sync.Mutex
	epoch    uint64
	isLeader bool
}

// New returns a Leader for (name, holder) over store with lease TTL ttl.
func New(store lease.Store, name, holder string, ttl time.Duration) *Leader {
	return &Leader{store: store, name: name, holder: holder, ttl: ttl}
}

// Fence returns the current fencing epoch and whether this instance currently
// holds the lease. Safe for concurrent use.
func (l *Leader) Fence() (epoch uint64, isLeader bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.epoch, l.isLeader
}

// step performs exactly one acquire-or-renew cycle and updates state. If leading,
// it renews; a renew failure drops leadership and it immediately attempts to
// (re)acquire. If not leading, it attempts to acquire. It has no timing of its
// own; Run calls it on a ticker and tests call it directly.
func (l *Leader) step(ctx context.Context) {
	l.mu.Lock()
	leading := l.isLeader
	l.mu.Unlock()

	if leading {
		if ls, err := l.store.Renew(ctx, l.name, l.holder, l.ttl); err == nil {
			l.set(ls.Epoch, true)
			return
		}
		l.set(0, false) // lost the lease; fall through to a (re)acquire attempt
	}

	if ls, err := l.store.Acquire(ctx, l.name, l.holder, l.ttl); err == nil {
		l.set(ls.Epoch, true)
		return
	}
	l.set(0, false)
}

func (l *Leader) set(epoch uint64, isLeader bool) {
	l.mu.Lock()
	l.epoch = epoch
	l.isLeader = isLeader
	l.mu.Unlock()
}

// Run drives step on an `every` ticker until ctx is cancelled, then best-effort
// releases the lease. It performs one immediate step before ticking.
func (l *Leader) Run(ctx context.Context, every time.Duration) {
	l.step(ctx)
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			// best-effort release with a fresh context (ctx is already done).
			releaseCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = l.store.Release(releaseCtx, l.name, l.holder)
			cancel()
			l.set(0, false)
			return
		case <-ticker.C:
			l.step(ctx)
		}
	}
}
```

- [ ] **Step 4: 运行验证通过 + race + vet**

Run: `cd backend && go test ./internal/leader/ && go test -race ./internal/leader/ && go vet ./internal/leader/`
Expected: PASS（3 个 step 测试 + `TestRunAcquiresAndReleasesOnCancel`）；`-race` 洁净；vet 无输出。

- [ ] **Step 5: 全量 + 构建 + 提交**

Run: `cd backend && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Expected: 全绿；signer 构建成功（二进制已删）。
```bash
git add backend/internal/leader/leader.go backend/internal/leader/leader_test.go
git commit --no-verify -m "feat(backend): leader heartbeat loop over lease.Store (Fence epoch + failover)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd backend && go test ./... && go vet ./... && go build ./...` 全绿。
- `go test -race ./internal/lease/ ./internal/leader/` 通过。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅新增 `internal/lease/{mem.go,mem_test.go}` + `internal/leader/{leader.go,leader_test.go}` + 两份 docs。未改 `singlewriter`/`cmd/signer`/`lease/{decide.go,lease.go,pg/*}`。

## 备注

- `lease.Mem` 与 `singlewriter.Mem` 对称；单实例部署可直接用 `lease.Mem`。
- `Leader.step` 续约失败即尝试抢占 → 快速故障切换；失去租约的实例要么以更高 epoch 夺回（自我 fence 掉旧 in-flight）要么退位（`Fence()` 返回 `isLeader=false`，端点接线切片据此回 503）。
- 本切片不接线端点、不改 `main()`、不引入 Postgres——均为后续切片。
