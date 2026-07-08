# M6 意图账本对账状态机 + 孤儿单侦测（`internal/ledger`）实现计划 — 子项目 B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `internal/ledger` 补齐 (keyID, cloid) 记录的对账状态机（signed→submitted→open→filled/rejected/canceled，校验合法转移、拒绝非法转移）与孤儿单侦测（非终态且陈旧记录）。

**Architecture:** 扩展已合并的 `internal/ledger`：`type Status` + 纯 `Transition` + `Reconciler`/`Ledger` 接口；`Mem` 与 Postgres `Store` 各实现 `Reconcile`/`Orphans`，共用同一 `Transition`。孤儿计时用记录的 `updatedAt`（Mem wall clock / pg DB `now()`），conformance 以极端 cutoff 保持时钟无关一致。先不接线。

**Tech Stack:** Go 1.26；`github.com/jackc/pgx/v5`；testcontainers（集成，build-tag `integration`）。

参考 spec：`docs/superpowers/specs/2026-07-08-m6-ledger-reconciliation-design.md`
镜像现有：`backend/internal/ledger/{ledger.go,decide.go,mem.go}`、`backend/internal/ledger/conformance/conformance.go`、`backend/internal/ledger/pg/{schema.go,pg.go,pg_integration_test.go}`。

## 文件结构
- `backend/internal/ledger/ledger.go` — +Status 类型/常量、Orphan、错误、Reconciler/Ledger 接口；Record.Status: string→Status。
- `backend/internal/ledger/decide.go` — "signed" → StatusSigned（1 处）。
- `backend/internal/ledger/reconcile.go` — NEW：纯 Transition + isTerminal + allowedTransitions。
- `backend/internal/ledger/mem.go` — +updatedAt；实现 Reconcile/Orphans。
- `backend/internal/ledger/reconcile_test.go` — NEW：Transition 直接单测。
- `backend/internal/ledger/conformance/conformance.go` — +RunReconcile。
- `backend/internal/ledger/mem_test.go` — +RunReconcile(Mem)。
- `backend/internal/ledger/pg/schema.go` — +updated_at ALTER。
- `backend/internal/ledger/pg/pg.go` — +Reconcile/Orphans；status 扫描为 Status。
- `backend/internal/ledger/pg/pg_integration_test.go` — +RunReconcile + 并发用例。

---

### Task 1: Status 类型 + 纯 Transition + Mem Reconcile/Orphans

**Files:**
- Modify: `backend/internal/ledger/ledger.go`
- Modify: `backend/internal/ledger/decide.go`
- Create: `backend/internal/ledger/reconcile.go`
- Modify: `backend/internal/ledger/mem.go`
- Test: `backend/internal/ledger/reconcile_test.go`

- [ ] **Step 1: 写失败测试 `reconcile_test.go`**

```go
package ledger

import (
	"context"
	"errors"
	"testing"
)

func TestTransitionForwardChain(t *testing.T) {
	for _, tc := range []struct{ cur, tgt, want Status }{
		{StatusSigned, StatusSubmitted, StatusSubmitted},
		{StatusSubmitted, StatusOpen, StatusOpen},
		{StatusOpen, StatusFilled, StatusFilled},
		{StatusSubmitted, StatusFilled, StatusFilled},
		{StatusOpen, StatusCanceled, StatusCanceled},
		{StatusSigned, StatusRejected, StatusRejected},
	} {
		got, err := Transition(tc.cur, tc.tgt)
		if err != nil || got != tc.want {
			t.Fatalf("Transition(%s,%s) = %s,%v; want %s,nil", tc.cur, tc.tgt, got, err, tc.want)
		}
	}
}

func TestTransitionIdempotent(t *testing.T) {
	for _, s := range []Status{StatusSigned, StatusOpen, StatusFilled, StatusRejected, StatusCanceled} {
		if got, err := Transition(s, s); err != nil || got != s {
			t.Fatalf("Transition(%s,%s) = %s,%v; want idempotent %s,nil", s, s, got, err, s)
		}
	}
}

func TestTransitionInvalid(t *testing.T) {
	for _, tc := range []struct{ cur, tgt Status }{
		{StatusFilled, StatusOpen},     // terminal backward
		{StatusOpen, StatusSigned},     // backward
		{StatusFilled, StatusRejected}, // cross-terminal
		{StatusRejected, StatusFilled}, // cross-terminal
		{StatusSigned, StatusOpen},     // skip (signed can't jump to open directly)
	} {
		if _, err := Transition(tc.cur, tc.tgt); !errors.Is(err, ErrInvalidTransition) {
			t.Fatalf("Transition(%s,%s) err = %v; want ErrInvalidTransition", tc.cur, tc.tgt, err)
		}
	}
}

func TestMemReconcileAndOrphans(t *testing.T) {
	ctx := context.Background()
	m := NewMem()
	// unknown intent → ErrUnknownIntent
	if _, err := m.Reconcile(ctx, "k", "c1", StatusSubmitted); !errors.Is(err, ErrUnknownIntent) {
		t.Fatalf("reconcile unknown = %v, want ErrUnknownIntent", err)
	}
	// seed a signed record via Authorize
	if _, err := m.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1_700_000_000_000}); err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if s, err := m.Reconcile(ctx, "k", "c1", StatusSubmitted); err != nil || s != StatusSubmitted {
		t.Fatalf("reconcile submitted = %s,%v", s, err)
	}
	// invalid transition leaves state intact (indirect: a valid one still works)
	if _, err := m.Reconcile(ctx, "k", "c1", StatusSigned); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("reconcile backward = %v, want ErrInvalidTransition", err)
	}
	if s, err := m.Reconcile(ctx, "k", "c1", StatusOpen); err != nil || s != StatusOpen {
		t.Fatalf("reconcile open after invalid = %s,%v (state must be intact)", s, err)
	}
	// orphan: c1 is open (non-terminal) → far-future cutoff returns it; far-past returns none
	orph, err := m.Orphans(ctx, 4_000_000_000_000)
	if err != nil || len(orph) != 1 || orph[0].Cloid != "c1" || orph[0].Status != StatusOpen {
		t.Fatalf("orphans(future) = %+v,%v; want [c1 open]", orph, err)
	}
	if orph, _ := m.Orphans(ctx, 1_000_000_000); len(orph) != 0 {
		t.Fatalf("orphans(past) = %+v; want empty", orph)
	}
	// terminal record excluded from orphans
	if _, err := m.Reconcile(ctx, "k", "c1", StatusFilled); err != nil {
		t.Fatalf("reconcile filled: %v", err)
	}
	if orph, _ := m.Orphans(ctx, 4_000_000_000_000); len(orph) != 0 {
		t.Fatalf("orphans after filled = %+v; want empty (terminal excluded)", orph)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/ledger/`
Expected: 编译失败（Status/常量/Transition/ErrInvalidTransition/ErrUnknownIntent/Reconcile/Orphans 未定义）。

- [ ] **Step 3: 改 `ledger.go` — 加 Status/Orphan/错误/接口，改 Record.Status**

在 `ledger.go` 中：把 `Record` 的 `Status string` 改为 `Status Status`；追加类型与接口。改后 Record 与新增内容：

```go
// Status is the reconciliation lifecycle state of a (keyID, cloid) intent.
type Status string

const (
	StatusSigned    Status = "signed"
	StatusSubmitted Status = "submitted"
	StatusOpen      Status = "open"
	StatusFilled    Status = "filled"
	StatusRejected  Status = "rejected"
	StatusCanceled  Status = "canceled"
)

// Record is one persisted (keyID, cloid) intent.
type Record struct {
	Nonce  uint64
	Digest [32]byte
	Status Status
}

// Orphan is a non-terminal intent whose last update predates a cutoff — signed
// (and maybe submitted/open) but never confirmed to a terminal state.
type Orphan struct {
	KeyID       string
	Cloid       string
	Nonce       uint64
	Status      Status
	UpdatedAtMs int64
}

// Reconciler advances an intent's lifecycle and surfaces stale non-terminal ones.
type Reconciler interface {
	// Reconcile validates current→target and persists it, refreshing updatedAt on
	// any success (including an idempotent same-status re-report = proof of life).
	// Unknown (keyID,cloid) → ErrUnknownIntent; a disallowed edge → ErrInvalidTransition.
	Reconcile(ctx context.Context, keyID, cloid string, target Status) (Status, error)
	// Orphans returns every non-terminal record whose updatedAt < olderThanMs.
	Orphans(ctx context.Context, olderThanMs int64) ([]Orphan, error)
}

// Ledger combines idempotent authorization and reconciliation (both Mem and the
// Postgres Store satisfy it); the conformance suite and future wiring use it.
type Ledger interface {
	Authorizer
	Reconciler
}
```

并在错误块追加：

```go
	ErrInvalidTransition = errors.New("invalid status transition") // disallowed lifecycle edge
	ErrUnknownIntent     = errors.New("unknown intent")            // reconcile a (keyID,cloid) never signed
```

- [ ] **Step 4: 改 `decide.go` — "signed" → StatusSigned**

把 `rec := Record{Nonce: swg.Nonce, Digest: r.Digest, Status: "signed"}` 改为
`rec := Record{Nonce: swg.Nonce, Digest: r.Digest, Status: StatusSigned}`。

- [ ] **Step 5: 写 `reconcile.go`**

```go
package ledger

// isTerminal reports whether s is a terminal lifecycle state (no further edges
// except the idempotent self-report).
func isTerminal(s Status) bool {
	return s == StatusFilled || s == StatusRejected || s == StatusCanceled
}

// allowedTransitions maps each source state to its permitted forward targets
// (excluding the always-allowed idempotent self-transition). Terminal states have
// no entry, so only their self-report is accepted.
var allowedTransitions = map[Status]map[Status]bool{
	StatusSigned:    {StatusSubmitted: true, StatusRejected: true},
	StatusSubmitted: {StatusOpen: true, StatusFilled: true, StatusRejected: true},
	StatusOpen:      {StatusFilled: true, StatusCanceled: true, StatusRejected: true},
}

// Transition validates a reconciliation step. An identical target is an idempotent
// no-op (returns current, nil); a permitted forward edge returns target; anything
// else — a backward, skipping, or cross-terminal edge — returns ErrInvalidTransition
// leaving the caller to keep the current state.
func Transition(current, target Status) (Status, error) {
	if current == target {
		return current, nil
	}
	if allowedTransitions[current][target] {
		return target, nil
	}
	return current, ErrInvalidTransition
}
```

- [ ] **Step 6: 改 `mem.go` — updatedAt + Reconcile + Orphans**

在 `Mem` 结构加 `updatedAt map[recordKey]int64`；`NewMem` 初始化它；`Authorize` 在写入新记录时打时间；追加 Reconcile/Orphans 与断言。改动点：

`import` 追加 `"time"`。结构与构造：

```go
type Mem struct {
	mu        sync.Mutex
	sw        map[string]singlewriter.State
	records   map[recordKey]Record
	updatedAt map[recordKey]int64
}

func NewMem() *Mem {
	return &Mem{
		sw:        make(map[string]singlewriter.State),
		records:   make(map[recordKey]Record),
		updatedAt: make(map[recordKey]int64),
	}
}
```

在 `Authorize` 的 `if !g.Duplicate { ... }` 块内，写入记录后补一行 updatedAt：

```go
	if !g.Duplicate {
		m.sw[r.KeyID] = nextSW
		m.records[rk] = rec
		m.updatedAt[rk] = time.Now().UnixMilli()
	}
```

追加方法（放在 `var _ Authorizer` 断言之前）：

```go
// Reconcile validates the lifecycle transition for (keyID, cloid) and persists it.
func (m *Mem) Reconcile(_ context.Context, keyID, cloid string, target Status) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rk := recordKey{keyID: keyID, cloid: cloid}
	rec, ok := m.records[rk]
	if !ok {
		return "", ErrUnknownIntent
	}
	next, err := Transition(rec.Status, target)
	if err != nil {
		return rec.Status, err
	}
	rec.Status = next
	m.records[rk] = rec
	m.updatedAt[rk] = time.Now().UnixMilli()
	return next, nil
}

// Orphans returns every non-terminal record whose updatedAt < olderThanMs.
func (m *Mem) Orphans(_ context.Context, olderThanMs int64) ([]Orphan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Orphan
	for rk, rec := range m.records {
		if isTerminal(rec.Status) {
			continue
		}
		if ua := m.updatedAt[rk]; ua < olderThanMs {
			out = append(out, Orphan{KeyID: rk.keyID, Cloid: rk.cloid, Nonce: rec.Nonce, Status: rec.Status, UpdatedAtMs: ua})
		}
	}
	return out, nil
}
```

并把断言扩为：`var _ Ledger = (*Mem)(nil)`（替换原 `var _ Authorizer = (*Mem)(nil)`）。

- [ ] **Step 7: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/ledger/ && go vet ./internal/ledger/ && go test -race ./internal/ledger/`
Expected: PASS；vet 静默；race 无告警。

- [ ] **Step 8: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/ledger.go backend/internal/ledger/decide.go backend/internal/ledger/reconcile.go backend/internal/ledger/mem.go backend/internal/ledger/reconcile_test.go
git commit --no-verify -m "feat(backend): ledger reconciliation state machine + orphan detection (Mem)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: conformance `RunReconcile` + Mem 契约测试

**Files:**
- Modify: `backend/internal/ledger/conformance/conformance.go`
- Modify: `backend/internal/ledger/mem_test.go`

- [ ] **Step 1: 改 `mem_test.go` 追加 RunReconcile（会失败：函数未定义）**

在 `mem_test.go` 追加：

```go
func TestMemReconcileConformance(t *testing.T) {
	conformance.RunReconcile(t, func() ledger.Ledger { return ledger.NewMem() })
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/ledger/`
Expected: 编译失败（`conformance.RunReconcile` 未定义）。

- [ ] **Step 3: 追加 `RunReconcile` 到 `conformance/conformance.go`**

在文件末尾追加（复用现有 `dig` 助手与 import；若 `errors` 未 import 则补）：

```go
// RunReconcile exercises a Ledger implementation against the reconciliation +
// orphan-detection contract. newLedger must return a fresh, empty Ledger each call.
func RunReconcile(t *testing.T, newLedger func() ledger.Ledger) {
	t.Helper()
	ctx := context.Background()
	// seed authorizes a signed record for (key, cloid).
	seed := func(l ledger.Ledger, key, cloid string, b byte) {
		if _, err := l.Authorize(ctx, ledger.Request{KeyID: key, Cloid: cloid, Digest: dig(b), Fence: 1, NowMs: cfNow}); err != nil {
			t.Fatalf("seed authorize(%s,%s): %v", key, cloid, err)
		}
	}

	t.Run("forward chain signed->submitted->open->filled", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "c1", 1)
		for _, tgt := range []ledger.Status{ledger.StatusSubmitted, ledger.StatusOpen, ledger.StatusFilled} {
			got, err := l.Reconcile(ctx, "k", "c1", tgt)
			if err != nil || got != tgt {
				t.Fatalf("reconcile %s = %s,%v", tgt, got, err)
			}
		}
	})

	t.Run("idempotent re-report of terminal", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "c1", 1)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusSubmitted)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusFilled)
		if got, err := l.Reconcile(ctx, "k", "c1", ledger.StatusFilled); err != nil || got != ledger.StatusFilled {
			t.Fatalf("idempotent filled = %s,%v, want filled,nil", got, err)
		}
	})

	t.Run("invalid transition leaves state intact", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "c1", 1)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusSubmitted)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusOpen)
		if _, err := l.Reconcile(ctx, "k", "c1", ledger.StatusSigned); !errors.Is(err, ledger.ErrInvalidTransition) {
			t.Fatalf("backward err = %v, want ErrInvalidTransition", err)
		}
		// state intact → a valid forward edge still works.
		if got, err := l.Reconcile(ctx, "k", "c1", ledger.StatusFilled); err != nil || got != ledger.StatusFilled {
			t.Fatalf("valid after invalid = %s,%v (state must be intact)", got, err)
		}
		// cross-terminal rejected.
		if _, err := l.Reconcile(ctx, "k", "c1", ledger.StatusRejected); !errors.Is(err, ledger.ErrInvalidTransition) {
			t.Fatalf("cross-terminal err = %v, want ErrInvalidTransition", err)
		}
	})

	t.Run("unknown intent", func(t *testing.T) {
		l := newLedger()
		if _, err := l.Reconcile(ctx, "k", "nope", ledger.StatusSubmitted); !errors.Is(err, ledger.ErrUnknownIntent) {
			t.Fatalf("unknown = %v, want ErrUnknownIntent", err)
		}
	})

	t.Run("orphans: non-terminal within cutoff, terminal excluded", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "term", 1)
		seed(l, "k", "open", 2)
		seed(l, "k", "sign", 3)
		if _, err := l.Reconcile(ctx, "k", "term", ledger.StatusFilled); err != nil {
			t.Fatalf("term->filled: %v", err)
		}
		if _, err := l.Reconcile(ctx, "k", "open", ledger.StatusOpen); err != nil {
			t.Fatalf("open->open: %v", err)
		}
		orph, err := l.Orphans(ctx, 4_000_000_000_000) // far future: catch all non-terminal
		if err != nil {
			t.Fatalf("orphans: %v", err)
		}
		got := map[string]ledger.Status{}
		for _, o := range orph {
			got[o.Cloid] = o.Status
		}
		if len(got) != 2 || got["open"] != ledger.StatusOpen || got["sign"] != ledger.StatusSigned {
			t.Fatalf("orphans = %+v; want {open:open, sign:signed} (term excluded)", got)
		}
		if past, _ := l.Orphans(ctx, 1_000_000_000); len(past) != 0 { // far past: none
			t.Fatalf("orphans(past) = %+v; want empty", past)
		}
	})

	t.Run("orphans across keys", func(t *testing.T) {
		l := newLedger()
		seed(l, "a", "c", 1)
		seed(l, "b", "c", 2)
		orph, err := l.Orphans(ctx, 4_000_000_000_000)
		if err != nil {
			t.Fatalf("orphans: %v", err)
		}
		keys := map[string]bool{}
		for _, o := range orph {
			keys[o.KeyID] = true
		}
		if !keys["a"] || !keys["b"] {
			t.Fatalf("orphans keys = %+v; want both a and b", keys)
		}
	})
}
```

> 注：`conformance.go` 现有 import 已含 `context`、`testing`、`ledger`；若 `errors` 未 import，在 import 块补 `"errors"`。`dig`/`cfNow` 已存在。

- [ ] **Step 4: 运行确认通过 + race**

Run: `cd backend && go test ./internal/ledger/... && go test -race ./internal/ledger/...`
Expected: PASS；race 无告警。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/conformance/conformance.go backend/internal/ledger/mem_test.go
git commit --no-verify -m "test(backend): reconciliation conformance suite + Mem

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Postgres Reconcile/Orphans + schema + 集成测试

**Files:**
- Modify: `backend/internal/ledger/pg/schema.go`
- Modify: `backend/internal/ledger/pg/pg.go`
- Modify: `backend/internal/ledger/pg/pg_integration_test.go`

- [ ] **Step 1: 改 `schema.go` — 加 updated_at 列**

把 `EnsureSchema` 改为在建表后追加 ALTER（兼容 A 已建的旧表）：

```go
// EnsureSchema idempotently creates both the single-writer state table (reused
// for the fence/cap/nonce authority) and the ledger_intents table, and ensures
// the reconciliation updated_at column exists. A dedicated migration tool
// (goose/migrate) is deferred to later M6 work.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	if err := swpg.EnsureSchema(ctx, pool); err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, createSchemaSQL); err != nil {
		return err
	}
	_, err := pool.Exec(ctx, `ALTER TABLE ledger_intents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`)
	return err
}
```

- [ ] **Step 2: 改 `pg.go` — Reconcile + Orphans + status 扫描为 Status**

先把 `Authorize` 里读取 existing record 的 `recStatus string` 扫描改为构造 `ledger.Record{... Status: ledger.Status(recStatus)}`（现有代码扫描到 `var recStatus string`，装配 Record 时用 `ledger.Status(recStatus)`）。然后追加 SQL 常量与两个方法。

在 const 块追加：

```go
	recStatusSelectSQL = `SELECT status FROM ledger_intents WHERE key_id = $1 AND cloid = $2 FOR UPDATE`
	recStatusUpdateSQL = `UPDATE ledger_intents SET status = $3, updated_at = now() WHERE key_id = $1 AND cloid = $2`
	orphansSQL         = `SELECT key_id, cloid, nonce, status, (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint FROM ledger_intents WHERE status NOT IN ('filled','rejected','canceled') AND updated_at < to_timestamp($1 / 1000.0)`
```

追加方法（放在 `var _ ledger.Authorizer` 断言之前）：

```go
// Reconcile validates and persists the lifecycle transition for (keyID, cloid)
// inside one row-locked transaction. Unknown intent → ErrUnknownIntent; a
// disallowed edge → ErrInvalidTransition (rolled back); success updates status +
// updated_at. Infra errors are wrapped (5xx) vs typed rejections (4xx).
func (s *Store) Reconcile(ctx context.Context, keyID, cloid string, target ledger.Status) (ledger.Status, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return "", fmt.Errorf("pg ledger: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var cur string
	switch err := tx.QueryRow(ctx, recStatusSelectSQL, keyID, cloid).Scan(&cur); {
	case errors.Is(err, pgx.ErrNoRows):
		return "", ledger.ErrUnknownIntent
	case err != nil:
		return "", fmt.Errorf("pg ledger: reconcile select: %w", err)
	}

	next, derr := ledger.Transition(ledger.Status(cur), target)
	if derr != nil {
		return ledger.Status(cur), derr // typed rejection; deferred Rollback
	}
	if _, err := tx.Exec(ctx, recStatusUpdateSQL, keyID, cloid, string(next)); err != nil {
		return "", fmt.Errorf("pg ledger: reconcile update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("pg ledger: reconcile commit: %w", err)
	}
	return next, nil
}

// Orphans returns every non-terminal record whose updated_at is older than the
// olderThanMs cutoff (unix ms).
func (s *Store) Orphans(ctx context.Context, olderThanMs int64) ([]ledger.Orphan, error) {
	rows, err := s.pool.Query(ctx, orphansSQL, olderThanMs)
	if err != nil {
		return nil, fmt.Errorf("pg ledger: orphans query: %w", err)
	}
	defer rows.Close()
	var out []ledger.Orphan
	for rows.Next() {
		var keyID, cloid, status string
		var nonce, updatedAtMs int64
		if err := rows.Scan(&keyID, &cloid, &nonce, &status, &updatedAtMs); err != nil {
			return nil, fmt.Errorf("pg ledger: orphans scan: %w", err)
		}
		out = append(out, ledger.Orphan{KeyID: keyID, Cloid: cloid, Nonce: uint64(nonce), Status: ledger.Status(status), UpdatedAtMs: updatedAtMs})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pg ledger: orphans rows: %w", err)
	}
	return out, nil
}
```

并把 `var _ ledger.Authorizer = (*Store)(nil)` 改为 `var _ ledger.Ledger = (*Store)(nil)`。

- [ ] **Step 3: 确认 `pg.go` 编译（Authorize 的 status 装配）**

若 `Authorize` 现在用 `Status: recStatus`（string）赋给 `ledger.Record.Status`（现为 Status 类型），编译会报类型不匹配——改为 `Status: ledger.Status(recStatus)`。

Run: `cd backend && go build ./internal/ledger/...`
Expected: 编译通过（无输出）。

- [ ] **Step 4: 改 `pg_integration_test.go` — 加 RunReconcile + 并发用例**

在文件内追加（`newPool` harness 已存在；确保 import 含 `sync`——若并发用例需要）：

```go
func TestStoreReconcileConformance(t *testing.T) {
	pool := newPool(t)
	if err := pg.EnsureSchema(context.Background(), pool); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	conformance.RunReconcile(t, func() ledger.Ledger {
		_, _ = pool.Exec(context.Background(), "TRUNCATE sw_state, ledger_intents")
		return pg.New(pool)
	})
}

func TestConcurrentReconcileSerializes(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()
	if err := pg.EnsureSchema(ctx, pool); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	store := pg.New(pool)
	if _, err := store.Authorize(ctx, ledger.Request{KeyID: "k", Cloid: "c", Digest: [32]byte{1}, Fence: 1, Notional: 1, DailyCap: 1000, NowMs: 1_700_000_000_000}); err != nil {
		t.Fatalf("authorize: %v", err)
	}
	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _, errs[i] = store.Reconcile(ctx, "k", "c", ledger.StatusSubmitted) }(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil { // signed->submitted is valid; a concurrent re-report is idempotent (submitted->submitted)
			t.Fatalf("goroutine %d err = %v, want nil", i, e)
		}
	}
	var final string
	if err := pool.QueryRow(ctx, "SELECT status FROM ledger_intents WHERE key_id='k' AND cloid='c'").Scan(&final); err != nil {
		t.Fatalf("final: %v", err)
	}
	if final != "submitted" {
		t.Fatalf("final status = %s, want submitted", final)
	}
}
```

> 注：若 `pg_integration_test.go` 现有 import 未含 `sync`，补上。`ledger`/`conformance`/`pg` import 已存在。

- [ ] **Step 5: 集成编译校验（本地无 Docker）**

Run: `cd backend && go test -c -tags=integration -o /dev/null ./internal/ledger/pg/`
Expected: 编译成功（无输出）。修复未用 import/类型不符直至通过。

- [ ] **Step 6: 全量门**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
Expected: 全 PASS；vet/race 静默；signer 构建成功。

- [ ] **Step 7: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/pg/schema.go backend/internal/ledger/pg/pg.go backend/internal/ledger/pg/pg_integration_test.go
git commit --no-verify -m "feat(backend): Postgres ledger Reconcile + Orphans (updated_at)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- Status 类型/常量 + Record.Status→Status → Task 1 Step 3/4 ✅
- 纯 Transition + isTerminal + allowedTransitions → Task 1 Step 5 ✅
- Reconciler/Ledger/Orphan/错误 → Task 1 Step 3 ✅
- Mem Reconcile/Orphans + updatedAt → Task 1 Step 6 ✅
- conformance RunReconcile（6 场景：正向链/幂等/非法/未知/孤儿终态排除/跨 key）→ Task 2 Step 3 ✅
- pg schema updated_at ALTER → Task 3 Step 1 ✅
- pg Reconcile/Orphans → Task 3 Step 2 ✅
- 集成 RunReconcile + 并发序列化用例 → Task 3 Step 4 ✅
- 测试门（go test/vet/race/build + 集成编译）→ 各 Task ✅
- 非目标（不接线/不跟踪部分成交/不改 hl）→ 计划未触及 ✅

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码；import 补充点显式标注。

**Type consistency：** `Status`/`StatusSigned..Canceled`、`Transition(current,target Status)(Status,error)`、`Reconcile(ctx,keyID,cloid string,target Status)(Status,error)`、`Orphans(ctx,olderThanMs int64)([]Orphan,error)`、`Orphan{KeyID,Cloid,Nonce,Status,UpdatedAtMs}`、`ErrInvalidTransition`/`ErrUnknownIntent`、`Ledger=Authorizer+Reconciler` 全程一致；pg SQL 参数序（$1 keyID,$2 cloid,$3 status）与 Scan 顺序一致。
