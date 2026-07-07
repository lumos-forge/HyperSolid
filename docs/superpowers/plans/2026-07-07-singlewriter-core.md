# 持久化 fenced 单写者核（切片 ①）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `backend/internal/singlewriter` 包：一个把 fence 校验 + 每日额度扣减 + nonce 高水位推进合成为**单次原子授权**的单写者核（纯逻辑 + 内存参考实现 + 可复用一致性测试套件），为后续 Postgres 落地与 endpoint 接线提供规约。

**Architecture:** 一个纯函数 `decide(State, Request) → (State, Grant, error)` 承载全部状态转移（两种后端共用、杜绝漂移）；`Mem` 用 `sync.Mutex + map` 包裹 `decide` 实现 `Writer` 接口；导出 `RunConformance(t, newWriter)` 供任意 `Writer` 实现（含下一切片的 Postgres）复用同一批场景。

**Tech Stack:** Go 1.26；标准库（`context`/`errors`/`math`/`sync`/`testing`）；仓库现有 backend 测试门 `go test ./... && go vet ./... && go test -race ./internal/singlewriter/`。

---

## File Structure

- `backend/internal/singlewriter/singlewriter.go` — 包文档 + `Request`/`Grant`/`State` 类型、`Writer` 接口、三个 sentinel error、`dayMs` 常量。（Task 1）
- `backend/internal/singlewriter/decide.go` — 纯 `decide` 状态转移函数。（Task 2）
- `backend/internal/singlewriter/decide_test.go` — `decide` 的直接单元测试。（Task 2）
- `backend/internal/singlewriter/mem.go` — `Mem` 内存参考实现。（Task 3）
- `backend/internal/singlewriter/conformance/conformance.go` — **独立子包** `package conformance`，导出 `Run(t, newWriter)`；`import "testing"` + 父包 `singlewriter`。放子包是为了让**生产 lib `singlewriter` 保持不链接 `testing`**（切片③的 `cmd/signer` 将 import `singlewriter`）。（Task 3）
- `backend/internal/singlewriter/mem_test.go` — 外部测试包 `singlewriter_test`，用 `conformance.Run` 驱动 `Mem` + `Mem` 专属并发/竞态测试。（Task 3）

> 约定参照：`backend/internal/nonce/nonce.go`（`nonce.Next` 数学、`nowMs` 注入、包头注释风格）、`backend/internal/policy/spend.go`（`SpendTracker.Charge` 额度数学、fail-closed 守卫、`dayMs`）。模块路径 `github.com/lumos-forge/hypersolid/backend`。所有提交用 `--no-verify` 并带 `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: 类型、接口与错误分类

**Files:**
- Create: `backend/internal/singlewriter/singlewriter.go`

- [ ] **Step 1: 写包骨架（类型 + 接口 + 错误 + 常量）**

创建 `backend/internal/singlewriter/singlewriter.go`：

```go
// Package singlewriter is the cross-process single-writer authority for one
// agent key: it fences stale writers and, for the current lease-holder,
// advances the per-key nonce high-water and charges the daily notional spend —
// atomically. It composes what today are two in-process allocators
// (internal/nonce.Allocator + internal/policy.SpendTracker) into one persisted,
// fence-guarded authorization (docs/BACKEND-ARCHITECTURE.md §6.2, M6 slice ①).
//
// The fencing token is minted by the lease layer (a later slice); here the store
// only enforces monotonicity: a token lower than the highest seen is rejected.
package singlewriter

import (
	"context"
	"errors"
)

// dayMs is the number of milliseconds in a UTC calendar day; the daily spend is
// bucketed by NowMs/dayMs (matches internal/policy).
const dayMs int64 = 24 * 60 * 60 * 1000

// Request is one signing authorization for an agent key.
type Request struct {
	KeyID    string  // agent private key id (per private key, not account)
	Fence    uint64  // fencing token from the caller's lease (minted in a later slice)
	Notional float64 // this action's USD notional; 0 for non-notional kinds
	DailyCap float64 // per-key daily notional cap; 0 = unlimited, <0 = misconfig (denied)
	NowMs    int64   // caller clock in ms; injectable for tests
}

// Grant is the result of an accepted authorization.
type Grant struct {
	Nonce uint64 // strictly-increasing per-key ms nonce to sign with
}

// State is the per-key persisted single-writer state.
type State struct {
	Fence      uint64  // highest fencing token accepted so far
	LastNonce  uint64  // last issued nonce (high-water)
	SpendDay   int64   // UTC day number of SpendTotal (NowMs/dayMs)
	SpendTotal float64 // notional spent within SpendDay
}

// Writer is the cross-process single-writer authority. Authorize atomically
// fences stale writers and, for the current lease-holder, advances the per-key
// nonce high-water and charges the daily spend — all or nothing.
type Writer interface {
	Authorize(ctx context.Context, r Request) (Grant, error)
}

// Typed rejections; callers/endpoints map these to HTTP status codes.
var (
	ErrFenced          = errors.New("fenced: stale fencing token") // stale lease token → future 409
	ErrDailyCap        = errors.New("daily cap exceeded")          // over/under (misconfig) daily cap → 403
	ErrInvalidNotional = errors.New("invalid notional")           // NaN/Inf/negative notional → 403
)
```

- [ ] **Step 2: 编译验证**

Run: `cd backend && go build ./internal/singlewriter/ && go vet ./internal/singlewriter/`
Expected: 编译通过、vet 无输出（暂无测试，仅类型/接口声明；`Writer` 尚无实现是允许的）。

- [ ] **Step 3: 提交**

```bash
git add backend/internal/singlewriter/singlewriter.go
git commit --no-verify -m "feat(backend): singlewriter types, Writer interface, error taxonomy

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 纯 `decide` 状态转移

**Files:**
- Create: `backend/internal/singlewriter/decide.go`
- Test: `backend/internal/singlewriter/decide_test.go`

- [ ] **Step 1: 写失败测试**

创建 `backend/internal/singlewriter/decide_test.go`：

```go
package singlewriter

import (
	"math"
	"testing"
)

const fixedNow int64 = 1_700_000_000_000

func TestDecideFreshKeyNonceIsNow(t *testing.T) {
	next, g, err := decide(State{}, Request{KeyID: "k1", Fence: 1, NowMs: fixedNow})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if g.Nonce != uint64(fixedNow) {
		t.Fatalf("nonce = %d, want %d", g.Nonce, fixedNow)
	}
	if next.LastNonce != uint64(fixedNow) || next.Fence != 1 {
		t.Fatalf("next = %+v, want LastNonce=%d Fence=1", next, fixedNow)
	}
}

func TestDecideNonceStrictlyIncreasesOnClockRegress(t *testing.T) {
	s := State{Fence: 1, LastNonce: uint64(fixedNow)}
	// NowMs regresses below LastNonce → must still be last+1.
	next, g, err := decide(s, Request{KeyID: "k1", Fence: 1, NowMs: fixedNow - 5000})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if g.Nonce != uint64(fixedNow)+1 {
		t.Fatalf("nonce = %d, want %d", g.Nonce, uint64(fixedNow)+1)
	}
	if next.LastNonce != uint64(fixedNow)+1 {
		t.Fatalf("LastNonce = %d, want %d", next.LastNonce, uint64(fixedNow)+1)
	}
}

func TestDecideFenceRejectsStaleToken(t *testing.T) {
	s := State{Fence: 5, LastNonce: uint64(fixedNow)}
	next, _, err := decide(s, Request{KeyID: "k1", Fence: 4, NowMs: fixedNow})
	if err != ErrFenced {
		t.Fatalf("err = %v, want ErrFenced", err)
	}
	if next != s {
		t.Fatalf("state mutated on fenced reject: got %+v want %+v", next, s)
	}
}

func TestDecideFenceEqualAndHigherAccepted(t *testing.T) {
	s := State{Fence: 5, LastNonce: uint64(fixedNow)}
	// equal token accepted, fence unchanged.
	n1, _, err := decide(s, Request{KeyID: "k1", Fence: 5, NowMs: fixedNow + 1})
	if err != nil || n1.Fence != 5 {
		t.Fatalf("equal token: err=%v fence=%d, want nil/5", err, n1.Fence)
	}
	// higher token accepted, fence raised.
	n2, _, err := decide(s, Request{KeyID: "k1", Fence: 9, NowMs: fixedNow + 1})
	if err != nil || n2.Fence != 9 {
		t.Fatalf("higher token: err=%v fence=%d, want nil/9", err, n2.Fence)
	}
}

func TestDecideDailyCapStrictBoundary(t *testing.T) {
	s := State{Fence: 1, SpendDay: fixedNow / dayMs, SpendTotal: 300}
	// 300+700 == cap 1000 → accepted (strict >).
	at, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 700, DailyCap: 1000, NowMs: fixedNow})
	if err != nil {
		t.Fatalf("at-cap err = %v, want nil", err)
	}
	if at.SpendTotal != 1000 {
		t.Fatalf("SpendTotal = %v, want 1000", at.SpendTotal)
	}
	// 300+701 > cap → ErrDailyCap, state unchanged, nonce NOT advanced.
	over, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 701, DailyCap: 1000, NowMs: fixedNow})
	if err != ErrDailyCap {
		t.Fatalf("over-cap err = %v, want ErrDailyCap", err)
	}
	if over != s {
		t.Fatalf("state mutated on cap reject: got %+v want %+v", over, s)
	}
}

func TestDecideZeroCapUnlimited(t *testing.T) {
	next, _, err := decide(State{Fence: 1}, Request{KeyID: "k1", Fence: 1, Notional: 1e15, DailyCap: 0, NowMs: fixedNow})
	if err != nil {
		t.Fatalf("err = %v, want nil (0 cap = unlimited)", err)
	}
	if next.SpendTotal != 1e15 {
		t.Fatalf("SpendTotal = %v, want 1e15", next.SpendTotal)
	}
}

func TestDecideDayRollResetsSpend(t *testing.T) {
	day0 := fixedNow / dayMs
	s := State{Fence: 1, LastNonce: uint64(fixedNow), SpendDay: day0, SpendTotal: 900}
	nextDay := fixedNow + dayMs
	// New day: prior 900 is wiped, so 900 more fits under cap 1000.
	next, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 900, DailyCap: 1000, NowMs: nextDay})
	if err != nil {
		t.Fatalf("err = %v, want nil (new day resets)", err)
	}
	if next.SpendTotal != 900 || next.SpendDay != nextDay/dayMs {
		t.Fatalf("next = %+v, want SpendTotal=900 day=%d", next, nextDay/dayMs)
	}
}

func TestDecideInvalidNotionalFailsClosed(t *testing.T) {
	s := State{Fence: 1, LastNonce: uint64(fixedNow)}
	for _, n := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
		next, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: n, DailyCap: 1000, NowMs: fixedNow})
		if err != ErrInvalidNotional {
			t.Fatalf("notional %v: err = %v, want ErrInvalidNotional", n, err)
		}
		if next != s {
			t.Fatalf("notional %v: state mutated on reject", n)
		}
	}
}

func TestDecideNegativeCapFailsClosed(t *testing.T) {
	s := State{Fence: 1, LastNonce: uint64(fixedNow)}
	next, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 1, DailyCap: -5, NowMs: fixedNow})
	if err != ErrDailyCap {
		t.Fatalf("err = %v, want ErrDailyCap (negative cap misconfig)", err)
	}
	if next != s {
		t.Fatalf("state mutated on negative-cap reject")
	}
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && go test ./internal/singlewriter/ -run TestDecide`
Expected: FAIL —— `decide` 未定义（编译错误 `undefined: decide`）。

- [ ] **Step 3: 实现 `decide`**

创建 `backend/internal/singlewriter/decide.go`：

```go
package singlewriter

import "math"

// decide is the pure single-writer transition. Given the current persisted
// state and a request it returns the next state and grant, or a typed error
// (leaving state UNCHANGED on every reject). Both the in-memory and Postgres
// writers apply this identical logic so their behavior cannot drift.
//
// Order: fence → invalid notional → daily cap → nonce. A fenced, invalid, or
// cap-denied request never advances the nonce (matches the M5 sign pipeline).
func decide(s State, r Request) (State, Grant, error) {
	// 1. fence: a stale writer (lower token) is rejected without touching state.
	if r.Fence < s.Fence {
		return s, Grant{}, ErrFenced
	}
	// 2. invalid notional fails closed (mirrors policy.SpendTracker.Charge).
	if math.IsNaN(r.Notional) || math.IsInf(r.Notional, 0) || r.Notional < 0 {
		return s, Grant{}, ErrInvalidNotional
	}
	// 3. daily cap check+reserve, UTC-day bucketed; rollover resets the total.
	day := r.NowMs / dayMs
	total := s.SpendTotal
	if s.SpendDay != day {
		total = 0
	}
	if r.DailyCap < 0 { // misconfigured cap → fail closed
		return s, Grant{}, ErrDailyCap
	}
	if r.DailyCap > 0 && total+r.Notional > r.DailyCap { // strict >, exactly-at-cap allowed
		return s, Grant{}, ErrDailyCap // deny does NOT advance nonce
	}
	// 4. nonce high-water advance: n = max(now, last+1), strictly increasing.
	n := uint64(r.NowMs)
	if n <= s.LastNonce {
		n = s.LastNonce + 1
	}
	return State{
		Fence:      r.Fence, // monotonic: r.Fence >= s.Fence here
		LastNonce:  n,
		SpendDay:   day,
		SpendTotal: total + r.Notional,
	}, Grant{Nonce: n}, nil
}
```

- [ ] **Step 4: 运行验证通过 + vet**

Run: `cd backend && go test ./internal/singlewriter/ -run TestDecide && go vet ./internal/singlewriter/`
Expected: PASS（9 个 decide 测试全过）；vet 无输出。

- [ ] **Step 5: 提交**

```bash
git add backend/internal/singlewriter/decide.go backend/internal/singlewriter/decide_test.go
git commit --no-verify -m "feat(backend): pure decide state transition (fence+cap+nonce)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `Mem` 参考实现 + 可复用一致性套件

**Files:**
- Create: `backend/internal/singlewriter/mem.go`
- Create: `backend/internal/singlewriter/conformance/conformance.go`
- Test: `backend/internal/singlewriter/mem_test.go`

- [ ] **Step 1: 写失败测试（外部测试包：Mem 直测并发 + 通过 conformance.Run 驱动）**

创建 `backend/internal/singlewriter/mem_test.go`（**外部测试包** `singlewriter_test`，故通过导出符号访问；`memNow` 为本文件局部常量，与内部 `decide_test.go` 的 `fixedNow` 不冲突）：

```go
package singlewriter_test

import (
	"context"
	"sync"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter/conformance"
)

const memNow int64 = 1_700_000_000_000

func TestMemConformance(t *testing.T) {
	conformance.Run(t, func() singlewriter.Writer { return singlewriter.NewMem() })
}

func TestMemConcurrentNoNonceReuseNoOverspend(t *testing.T) {
	m := singlewriter.NewMem()
	ctx := context.Background()
	const per = 100.0
	const cap = 1000.0
	const goroutines = 100
	var wg sync.WaitGroup
	var mu sync.Mutex
	nonces := make(map[uint64]int)
	accepted := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g, err := m.Authorize(ctx, singlewriter.Request{KeyID: "k1", Fence: 1, Notional: per, DailyCap: cap, NowMs: memNow})
			if err != nil {
				return
			}
			mu.Lock()
			nonces[g.Nonce]++
			accepted++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if accepted != int(cap/per) {
		t.Fatalf("accepted = %d, want %d (cap/per, no overspend)", accepted, int(cap/per))
	}
	for n, c := range nonces {
		if c != 1 {
			t.Fatalf("nonce %d issued %d times (reuse)", n, c)
		}
	}
	if len(nonces) != accepted {
		t.Fatalf("unique nonces = %d, want %d", len(nonces), accepted)
	}
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && go test ./internal/singlewriter/...`
Expected: FAIL —— `singlewriter.NewMem` 与 `conformance` 包未定义（编译错误：no required module / undefined）。

- [ ] **Step 3: 实现 `Mem`**

创建 `backend/internal/singlewriter/mem.go`：

```go
package singlewriter

import (
	"context"
	"sync"
)

// Mem is an in-process Writer: a mutex-guarded map of per-key State applying the
// pure decide transition. It is the single-instance reference implementation and
// the fast unit-test fixture; the cross-host authority is a Postgres-backed
// Writer (a later slice) that applies the SAME decide inside a transaction.
type Mem struct {
	mu    sync.Mutex
	state map[string]State
}

// NewMem returns an empty in-memory Writer.
func NewMem() *Mem { return &Mem{state: make(map[string]State)} }

// Authorize applies decide under a single lock: atomic check-and-reserve. On an
// accepted grant the new State is persisted; every reject leaves State untouched.
func (m *Mem) Authorize(_ context.Context, r Request) (Grant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, g, err := decide(m.state[r.KeyID], r)
	if err != nil {
		return Grant{}, err
	}
	m.state[r.KeyID] = next
	return g, nil
}
```

- [ ] **Step 4: 实现 `conformance.Run`（独立子包，保持父 lib 不链接 `testing`）**

创建 `backend/internal/singlewriter/conformance/conformance.go`：

```go
// Package conformance holds the reusable single-writer contract test suite. It
// lives in its own package (importing testing) so the production singlewriter
// library stays testing-free; any Writer implementation — the in-memory Mem
// here, the Postgres-backed writer in a later slice — must pass Run.
package conformance

import (
	"context"
	"math"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// cfNow is the fixed clock (ms) used by the scenarios.
const cfNow int64 = 1_700_000_000_000

// dayMs mirrors the single-writer's UTC-day bucket size (a fixed real-world
// constant); defined locally so the suite needs nothing unexported.
const dayMs int64 = 24 * 60 * 60 * 1000

// Run exercises a Writer implementation against the single-writer contract.
// newWriter must return a fresh, empty Writer on each call so scenarios do not
// share state.
func Run(t *testing.T, newWriter func() singlewriter.Writer) {
	t.Helper()
	ctx := context.Background()
	type Request = singlewriter.Request // local alias to keep scenarios terse

	t.Run("fresh key nonce is now, then strictly increases", func(t *testing.T) {
		w := newWriter()
		g1, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow})
		if err != nil || g1.Nonce != uint64(cfNow) {
			t.Fatalf("g1 = %+v err = %v, want nonce %d", g1, err, cfNow)
		}
		g2, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow})
		if err != nil || g2.Nonce != uint64(cfNow)+1 {
			t.Fatalf("g2 = %+v err = %v, want nonce %d (last+1)", g2, err, uint64(cfNow)+1)
		}
	})

	t.Run("clock regress still strictly increases", func(t *testing.T) {
		w := newWriter()
		_, _ = w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow})
		g, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow - 10_000})
		if err != nil || g.Nonce != uint64(cfNow)+1 {
			t.Fatalf("g = %+v err = %v, want nonce %d", g, err, uint64(cfNow)+1)
		}
	})

	t.Run("stale fence rejected without consuming state", func(t *testing.T) {
		w := newWriter()
		_, _ = w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow})
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 4, NowMs: cfNow + 1}); err != singlewriter.ErrFenced {
			t.Fatalf("stale fence err = %v, want ErrFenced", err)
		}
		// A subsequent valid call continues from the prior nonce high-water.
		g, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow + 1})
		if err != nil || g.Nonce != uint64(cfNow)+1 {
			t.Fatalf("post-fence g = %+v err = %v, want nonce %d", g, err, uint64(cfNow)+1)
		}
	})

	t.Run("higher fence accepted then old fence rejected", func(t *testing.T) {
		w := newWriter()
		_, _ = w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow})
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 9, NowMs: cfNow + 1}); err != nil {
			t.Fatalf("higher fence err = %v, want nil", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow + 2}); err != singlewriter.ErrFenced {
			t.Fatalf("old fence after raise err = %v, want ErrFenced", err)
		}
	})

	t.Run("daily cap strict boundary and deny does not burn nonce", func(t *testing.T) {
		w := newWriter()
		// spend exactly to cap (300 + 700 == 1000) → accepted.
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 300, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("first err = %v", err)
		}
		gAt, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 700, DailyCap: 1000, NowMs: cfNow})
		if err != nil {
			t.Fatalf("at-cap err = %v, want nil", err)
		}
		// next over-cap request is denied and must NOT advance the nonce.
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 1, DailyCap: 1000, NowMs: cfNow}); err != singlewriter.ErrDailyCap {
			t.Fatalf("over-cap err = %v, want ErrDailyCap", err)
		}
		// a non-notional (0) request now succeeds with nonce == gAt.Nonce+1 (no gap from the deny).
		gAfter, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 0, DailyCap: 1000, NowMs: cfNow})
		if err != nil || gAfter.Nonce != gAt.Nonce+1 {
			t.Fatalf("post-deny g = %+v err = %v, want nonce %d (no gap)", gAfter, err, gAt.Nonce+1)
		}
	})

	t.Run("zero cap unlimited", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 1e15, DailyCap: 0, NowMs: cfNow}); err != nil {
			t.Fatalf("err = %v, want nil (0 cap unlimited)", err)
		}
	})

	t.Run("day roll resets spend", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 900, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("day0 err = %v", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 900, DailyCap: 1000, NowMs: cfNow + dayMs}); err != nil {
			t.Fatalf("day1 err = %v, want nil (reset)", err)
		}
	})

	t.Run("invalid notional fails closed", func(t *testing.T) {
		w := newWriter()
		for _, n := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
			if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: n, DailyCap: 1000, NowMs: cfNow}); err != singlewriter.ErrInvalidNotional {
				t.Fatalf("notional %v err = %v, want ErrInvalidNotional", n, err)
			}
		}
	})

	t.Run("negative cap fails closed", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 1, DailyCap: -5, NowMs: cfNow}); err != singlewriter.ErrDailyCap {
			t.Fatalf("err = %v, want ErrDailyCap (negative cap)", err)
		}
	})

	t.Run("per-key isolation", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "a", Fence: 1, Notional: 1000, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("key a err = %v", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "a", Fence: 1, Notional: 1, DailyCap: 1000, NowMs: cfNow}); err != singlewriter.ErrDailyCap {
			t.Fatalf("key a should be full, err = %v", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "b", Fence: 1, Notional: 1000, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("key b independent, err = %v", err)
		}
	})
}
```

- [ ] **Step 5: 运行验证通过 + race + 全量 + vet + build**

Run: `cd backend && go test ./internal/singlewriter/... && go test -race ./internal/singlewriter/...`
Expected: PASS —— `TestMemConformance`（10 个子测试）、`TestMemConcurrentNoNonceReuseNoOverspend`、Task 2 的 `TestDecide*` 全过；`-race` 洁净。
Run: `cd backend && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Expected: 全部 PASS；vet 无输出；build 成功（二进制已删）。

- [ ] **Step 6: 提交**

```bash
git add backend/internal/singlewriter/mem.go backend/internal/singlewriter/conformance/conformance.go backend/internal/singlewriter/mem_test.go
git commit --no-verify -m "feat(backend): Mem reference Writer + reusable conformance suite

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd backend && go test ./... && go vet ./...` 全绿。
- `go test -race ./internal/singlewriter/` 通过。
- `go build ./cmd/signer && rm -f signer` 成功（不提交二进制）。
- `git diff --stat main...HEAD` —— 仅新增 `backend/internal/singlewriter/{singlewriter.go,decide.go,decide_test.go,mem.go,mem_test.go}` + `backend/internal/singlewriter/conformance/conformance.go` + 一份 spec doc。无其它改动（本切片**不**改 `nonce`/`policy`/`cmd/signer`）。

## 备注

- `conformance` 独立子包（`import "testing"`）：让生产 lib `singlewriter` 保持**不链接 `testing`**，这样切片③的 `cmd/signer` import `singlewriter` 时不会把测试框架带入生产二进制。子包只被测试引用；`Run` 仅依赖 `singlewriter` 的**导出**符号（`Request`/`Grant`/`Writer`/三个 `Err*`），`dayMs` 在子包内本地重定义（固定的自然日毫秒数）。
- `mem_test.go` 用**外部测试包** `singlewriter_test`：既能 import `conformance` 子包，又能与 `decide_test.go`（内部包 `singlewriter`，直测未导出的 `decide`）在同目录共存（Go 允许同目录 `foo` 与 `foo_test` 两个测试包）。
- 本切片为纯逻辑核，**不接线** `/v1/sign/l1`、**不**引入 Postgres 依赖、**不**改动现有 `nonce.Allocator` / `policy.SpendTracker`。
