# 持久租约存储 + fencing epoch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `backend/internal/lease`（纯 `Decide` + `Lease`/`Store`/错误）与 `backend/internal/lease/pg`（Postgres 实现，DB 时钟），提供一个按名字键控的持久租约存储：acquire/renew/release + 每 name 严格递增的 fencing `epoch`。

**Architecture:** 纯函数 `Decide(Row, Req) → (next, write, out, err)` 承载全部裁决（DB 喂 now，skew-free、可假时钟单测）；Postgres `PgStore` 在单个 READ COMMITTED `FOR UPDATE` 锁事务内 `SELECT …, now()` 把 DB 时间喂给纯决策，据结果 UPDATE/COMMIT，拒绝即回滚。行永不删除，epoch 单调。

**Tech Stack:** Go 1.26；`github.com/jackc/pgx/v5` + `pgxpool`（生产，已在 go.mod）；`testcontainers-go` + postgres 模块（仅 `//go:build integration` 测试，已在 go.mod，PR #29）；`postgres:17-alpine`。

---

## File Structure

- `backend/internal/lease/lease.go` — `Lease` 结构、`Store` 接口、三个 sentinel error。（Task 1）
- `backend/internal/lease/decide.go` — 导出的决策契约 `Row`/`Op`/`Req` + 纯 `Decide`。（Task 2）
- `backend/internal/lease/decide_test.go` — `Decide` 单元测试（假时钟）。（Task 2）
- `backend/internal/lease/pg/schema.go` — DDL 常量 + `EnsureSchema`。（Task 3）
- `backend/internal/lease/pg/pg.go` — `PgStore` + `New` + `Acquire`/`Renew`/`Release`（事务化）。（Task 3）
- `backend/internal/lease/pg/pg_integration_test.go` — `//go:build integration`，testcontainers 集成测试。（Task 3）

> 约定参照：模块路径 `github.com/lumos-forge/hypersolid/backend`；事务范式与 uint64↔bigint 位型、`%w` 包装、种子→`FOR UPDATE`→纯决策→`UPDATE`→`COMMIT` 复刻 `backend/internal/singlewriter/pg/pg.go`（PR #29）。决策 API（`Decide`/`Row`/`Op`/`Req`）从一开始就**导出**，因为 `pg` 子包在 `lease` 包外需复用同一纯决策（与 singlewriter 导出 `Decide`/`State` 一致）。所有提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。本机无 Docker——集成测试只**编译校验**，真跑在 CI。

---

### Task 1: 类型、接口与错误

**Files:**
- Create: `backend/internal/lease/lease.go`

- [ ] **Step 1: 写包骨架**

创建 `backend/internal/lease/lease.go`：
```go
// Package lease is a name-keyed persistent lease store with a monotonic fencing
// epoch. A process acquires/renews a lease to become the single writer for a
// name; each (re)acquire mints a strictly higher Epoch that callers pass to
// singlewriter as Request.Fence, so a deposed holder is fenced out
// (docs/BACKEND-ARCHITECTURE.md §6.2, M6). Expiry uses the DB clock (skew-free).
package lease

import (
	"context"
	"errors"
	"time"
)

// Lease is a claim on a named resource. Epoch is the fencing token: it strictly
// increases on every (re)acquire and is passed to singlewriter as Request.Fence.
type Lease struct {
	Name        string
	Holder      string
	Epoch       uint64
	ExpiresAtMs int64 // absolute expiry on the DB clock (epoch ms)
}

// Store is a persistent lease authority. Implementations evaluate expiry against
// a single shared clock (the DB) so instances cannot disagree about liveness.
type Store interface {
	// Acquire claims the lease for holder if it is free or expired, minting a
	// bumped Epoch. If a different holder still holds a valid lease it returns
	// ErrHeld (a valid self-hold also returns ErrHeld: use Renew instead).
	Acquire(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
	// Renew extends the caller's still-valid lease, keeping the same Epoch. If the
	// caller's lease already lapsed it returns ErrExpired (must re-Acquire); if
	// someone else holds it, ErrNotHolder.
	Renew(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
	// Release voluntarily gives up the lease held by holder (marks it expired now,
	// preserving Epoch). A non-holder / absent lease is an idempotent no-op.
	Release(ctx context.Context, name, holder string) error
}

// Typed rejections; callers/endpoints map these to backoff / HTTP status.
var (
	ErrHeld      = errors.New("lease held by another holder")
	ErrNotHolder = errors.New("not the lease holder")
	ErrExpired   = errors.New("lease expired; re-acquire")
)
```

- [ ] **Step 2: 编译 + vet**

Run: `cd backend && go build ./internal/lease/ && go vet ./internal/lease/`
Expected: 编译通过、vet 无输出（接口暂无实现、`time` 已用于接口签名——均允许）。

- [ ] **Step 3: 提交**

```bash
git add backend/internal/lease/lease.go
git commit --no-verify -m "feat(backend): lease types, Store interface, error taxonomy

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 纯 `Decide`

**Files:**
- Create: `backend/internal/lease/decide.go`
- Test: `backend/internal/lease/decide_test.go`

- [ ] **Step 1: 写失败测试**

创建 `backend/internal/lease/decide_test.go`：
```go
package lease

import "testing"

const dNow int64 = 1_700_000_000_000

func TestAcquireFreshSeedRow(t *testing.T) {
	// seed row: holder "", epoch 0, expired (expires 0).
	next, write, out, err := Decide(Row{ExpiresAtMs: 0}, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Holder != "a" || next.Epoch != 1 || next.ExpiresAtMs != dNow+1000 {
		t.Fatalf("next=%+v, want {a 1 %d}", next, dNow+1000)
	}
	if out.Holder != "a" || out.Epoch != 1 {
		t.Fatalf("out=%+v, want holder a epoch 1", out)
	}
}

func TestAcquireHeldByOtherRejected(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow + 5000}
	next, write, _, err := Decide(cur, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrHeld || write {
		t.Fatalf("err=%v write=%v, want ErrHeld/false", err, write)
	}
	if next != cur {
		t.Fatalf("state mutated on ErrHeld")
	}
}

func TestAcquireSelfValidRejected(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow + 5000}
	_, write, _, err := Decide(cur, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrHeld || write {
		t.Fatalf("err=%v write=%v, want ErrHeld/false (self valid hold → use Renew)", err, write)
	}
}

func TestAcquireStealsExpiredBumpsEpoch(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow - 1} // expired
	next, write, _, err := Decide(cur, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Holder != "a" || next.Epoch != 4 {
		t.Fatalf("next=%+v, want holder a epoch 4 (cur.epoch+1)", next)
	}
}

func TestRenewValidKeepsEpoch(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow + 500}
	next, write, _, err := Decide(cur, Req{Op: OpRenew, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Epoch != 3 || next.ExpiresAtMs != dNow+1000 {
		t.Fatalf("next=%+v, want epoch 3 (unchanged) expires %d", next, dNow+1000)
	}
}

func TestRenewExpiredSelf(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow - 1}
	_, write, _, err := Decide(cur, Req{Op: OpRenew, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrExpired || write {
		t.Fatalf("err=%v write=%v, want ErrExpired/false", err, write)
	}
}

func TestRenewNotHolder(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow + 500}
	_, write, _, err := Decide(cur, Req{Op: OpRenew, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrNotHolder || write {
		t.Fatalf("err=%v write=%v, want ErrNotHolder/false", err, write)
	}
}

func TestReleaseHolderExpiresKeepsEpoch(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow + 500}
	next, write, _, err := Decide(cur, Req{Op: OpRelease, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Holder != "a" || next.Epoch != 3 || next.ExpiresAtMs != dNow {
		t.Fatalf("next=%+v, want {a 3 %d} (expired now, epoch kept)", next, dNow)
	}
}

func TestReleaseNonHolderNoop(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow + 500}
	_, write, _, err := Decide(cur, Req{Op: OpRelease, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || write {
		t.Fatalf("err=%v write=%v, want nil/false (idempotent no-op)", err, write)
	}
}

func TestEpochMonotonicAcrossReleaseReacquire(t *testing.T) {
	// acquire → epoch 1
	n1, _, _, _ := Decide(Row{ExpiresAtMs: 0}, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	// release → epoch kept 1, expired
	n2, _, _, _ := Decide(n1, Req{Op: OpRelease, Holder: "a", NowMs: dNow + 10, TtlMs: 1000})
	// re-acquire → epoch 2 (not reset to 1)
	n3, _, _, err := Decide(n2, Req{Op: OpAcquire, Holder: "a", NowMs: dNow + 20, TtlMs: 1000})
	if err != nil {
		t.Fatalf("re-acquire err=%v", err)
	}
	if n3.Epoch != 2 {
		t.Fatalf("epoch=%d, want 2 (monotonic across release/re-acquire)", n3.Epoch)
	}
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && go test ./internal/lease/`
Expected: FAIL —— 编译错误 `undefined: Decide` / `Row` / `Req` / `OpAcquire` 等。

- [ ] **Step 3: 实现 `Decide`**

创建 `backend/internal/lease/decide.go`：
```go
package lease

// Row is the current persisted lease row (a seeded brand-new name is
// {Holder:"", Epoch:0, ExpiresAtMs:0} — already expired). A Store backend reads
// this row (and the DB clock) under a lock and feeds it to Decide.
type Row struct {
	Holder      string
	Epoch       uint64
	ExpiresAtMs int64
}

// Op selects the lease operation.
type Op int

const (
	OpAcquire Op = iota
	OpRenew
	OpRelease
)

// Req is one lease operation evaluated at DB time NowMs.
type Req struct {
	Op     Op
	Holder string
	NowMs  int64
	TtlMs  int64
}

// Decide computes the outcome of an operation against the current row at DB time
// NowMs. On a mutation it returns the next row to persist with write=true and the
// resulting Lease in out; on an idempotent no-op (Release by a non-holder)
// write=false and err=nil; on a rejection it returns a typed err
// (ErrHeld/ErrNotHolder/ErrExpired) with write=false and the state unchanged.
//
// Epoch is a per-name monotonic counter: acquiring a free/expired lease bumps it;
// renew keeps it; release preserves it (only expiring the lease). Rows are never
// deleted so the epoch can never regress below singlewriter's stored fence.
func Decide(cur Row, req Req) (next Row, write bool, out Lease, err error) {
	switch req.Op {
	case OpAcquire:
		if cur.ExpiresAtMs <= req.NowMs { // free or expired (incl. seed row)
			next = Row{Holder: req.Holder, Epoch: cur.Epoch + 1, ExpiresAtMs: req.NowMs + req.TtlMs}
			return next, true, leaseToOut(next), nil
		}
		return cur, false, Lease{}, ErrHeld
	case OpRenew:
		if cur.Holder == req.Holder && cur.ExpiresAtMs > req.NowMs {
			next = Row{Holder: cur.Holder, Epoch: cur.Epoch, ExpiresAtMs: req.NowMs + req.TtlMs}
			return next, true, leaseToOut(next), nil
		}
		if cur.Holder == req.Holder { // holder matches but already expired
			return cur, false, Lease{}, ErrExpired
		}
		return cur, false, Lease{}, ErrNotHolder
	case OpRelease:
		if cur.Holder == req.Holder {
			next = Row{Holder: cur.Holder, Epoch: cur.Epoch, ExpiresAtMs: req.NowMs} // expire now, keep epoch
			return next, true, leaseToOut(next), nil
		}
		return cur, false, Lease{}, nil // idempotent no-op; never touch another's lease
	default:
		return cur, false, Lease{}, ErrNotHolder
	}
}

// leaseToOut builds the public Lease from a row (Name is filled by the Store,
// which knows the name).
func leaseToOut(r Row) Lease {
	return Lease{Holder: r.Holder, Epoch: r.Epoch, ExpiresAtMs: r.ExpiresAtMs}
}
```

- [ ] **Step 4: 运行验证通过 + vet**

Run: `cd backend && go test ./internal/lease/ && go vet ./internal/lease/`
Expected: PASS（10 个测试全过）；vet 无输出。

- [ ] **Step 5: 提交**

```bash
git add backend/internal/lease/decide.go backend/internal/lease/decide_test.go
git commit --no-verify -m "feat(backend): pure lease.Decide (acquire/renew/release, monotonic epoch)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Postgres `PgStore` + schema + 集成测试

**Files:**
- Create: `backend/internal/lease/pg/schema.go`
- Create: `backend/internal/lease/pg/pg.go`
- Create: `backend/internal/lease/pg/pg_integration_test.go`（`//go:build integration`）

- [ ] **Step 1: 写 schema.go**

创建 `backend/internal/lease/pg/schema.go`：
```go
package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// createSchemaSQL is the single-table DDL for leases. expires_at is epoch ms
// (bigint) to match the pure Decide's int64-ms clock. epoch holds a uint64 as its
// int64 bit-pattern (the DB does no arithmetic on it).
const createSchemaSQL = `CREATE TABLE IF NOT EXISTS lease (
	name       text   PRIMARY KEY,
	holder     text   NOT NULL,
	epoch      bigint NOT NULL,
	expires_at bigint NOT NULL
)`

// EnsureSchema idempotently creates the lease table.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, createSchemaSQL)
	return err
}
```

- [ ] **Step 2: 写 pg.go（PgStore + 三方法）**

创建 `backend/internal/lease/pg/pg.go`：
```go
// Package pg is a Postgres-backed lease.Store: it evaluates lease.Decide inside a
// row-locked transaction using the DATABASE clock (now()) as the single time
// source, so instances cannot disagree about lease liveness
// (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package pg

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
)

// PgStore is a Postgres-backed lease.Store.
type PgStore struct{ pool *pgxpool.Pool }

// New returns a PgStore over the given pool. Run EnsureSchema once at startup.
func New(pool *pgxpool.Pool) *PgStore { return &PgStore{pool: pool} }

const (
	// seedSQL guarantees the row exists so SELECT … FOR UPDATE always has a row to
	// lock (race-free for brand-new names). The seed row is epoch 0 / expired.
	// Do NOT replace with a lazy SELECT-then-insert: that reintroduces a new-name race.
	seedSQL   = `INSERT INTO lease (name, holder, epoch, expires_at) VALUES ($1, '', 0, 0) ON CONFLICT (name) DO NOTHING`
	selectSQL = `SELECT holder, epoch, expires_at, (extract(epoch from now())*1000)::bigint FROM lease WHERE name = $1 FOR UPDATE`
	updateSQL = `UPDATE lease SET holder = $2, epoch = $3, expires_at = $4 WHERE name = $1`
)

func (s *PgStore) Acquire(ctx context.Context, name, holder string, ttl time.Duration) (lease.Lease, error) {
	return s.run(ctx, name, lease.OpAcquire, holder, ttl)
}

func (s *PgStore) Renew(ctx context.Context, name, holder string, ttl time.Duration) (lease.Lease, error) {
	return s.run(ctx, name, lease.OpRenew, holder, ttl)
}

func (s *PgStore) Release(ctx context.Context, name, holder string) error {
	_, err := s.run(ctx, name, lease.OpRelease, holder, 0)
	return err
}

// run executes one lease operation in a single row-locked READ COMMITTED
// transaction: seed the row, lock it FOR UPDATE (reading the DB clock in the same
// query), apply lease.Decide, then UPDATE+COMMIT (mutation) or COMMIT (no-op), or
// roll back on a typed rejection. Infra errors are wrapped.
func (s *PgStore) run(ctx context.Context, name string, op lease.Op, holder string, ttl time.Duration) (lease.Lease, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: begin: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit; undoes the seed on reject/error

	if _, err := tx.Exec(ctx, seedSQL, name); err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: seed: %w", err)
	}

	var curHolder string
	var epoch, expiresAt, nowMs int64
	if err := tx.QueryRow(ctx, selectSQL, name).Scan(&curHolder, &epoch, &expiresAt, &nowMs); err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: select: %w", err)
	}

	next, write, out, derr := lease.Decide(
		lease.Row{Holder: curHolder, Epoch: uint64(epoch), ExpiresAtMs: expiresAt},
		lease.Req{Op: op, Holder: holder, NowMs: nowMs, TtlMs: ttl.Milliseconds()},
	)
	if derr != nil {
		return lease.Lease{}, derr // typed rejection; deferred Rollback undoes the seed
	}
	if write {
		if _, err := tx.Exec(ctx, updateSQL, name, next.Holder, int64(next.Epoch), next.ExpiresAtMs); err != nil {
			return lease.Lease{}, fmt.Errorf("pg lease: update: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: commit: %w", err)
	}
	out.Name = name
	return out, nil
}

// compile-time assertion that PgStore satisfies the Store interface.
var _ lease.Store = (*PgStore)(nil)
```

- [ ] **Step 3: 写集成测试（标签隔离，testcontainers）**

创建 `backend/internal/lease/pg/pg_integration_test.go`：
```go
//go:build integration

package pg_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
	"github.com/lumos-forge/hypersolid/backend/internal/lease/pg"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("lease"),
		tcpostgres.WithUsername("lease"),
		tcpostgres.WithPassword("lease"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2),
		),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start postgres container: %v\n", err)
		os.Exit(1)
	}
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Fprintf(os.Stderr, "connection string: %v\n", err)
		os.Exit(1)
	}
	testPool, err = pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pool: %v\n", err)
		os.Exit(1)
	}
	if err := pg.EnsureSchema(ctx, testPool); err != nil {
		fmt.Fprintf(os.Stderr, "ensure schema: %v\n", err)
		os.Exit(1)
	}
	code := m.Run()
	testPool.Close()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

func TestAcquireRenewReleaseLifecycle(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "lc"

	l, err := s.Acquire(ctx, name, "a", time.Second)
	if err != nil || l.Epoch != 1 || l.Holder != "a" || l.Name != name {
		t.Fatalf("acquire: l=%+v err=%v, want epoch 1 holder a name %s", l, err, name)
	}
	// another holder cannot acquire while valid
	if _, err := s.Acquire(ctx, name, "b", time.Second); !errors.Is(err, lease.ErrHeld) {
		t.Fatalf("acquire by b: err=%v, want ErrHeld", err)
	}
	// holder renews, epoch unchanged
	r, err := s.Renew(ctx, name, "a", time.Second)
	if err != nil || r.Epoch != 1 {
		t.Fatalf("renew: r=%+v err=%v, want epoch 1", r, err)
	}
	// non-holder renew rejected
	if _, err := s.Renew(ctx, name, "b", time.Second); !errors.Is(err, lease.ErrNotHolder) {
		t.Fatalf("renew by b: err=%v, want ErrNotHolder", err)
	}
	// release, then b acquires with a HIGHER epoch (monotonic, not reset)
	if err := s.Release(ctx, name, "a"); err != nil {
		t.Fatalf("release: %v", err)
	}
	l2, err := s.Acquire(ctx, name, "b", time.Second)
	if err != nil || l2.Epoch != 2 || l2.Holder != "b" {
		t.Fatalf("acquire after release: l2=%+v err=%v, want epoch 2 holder b", l2, err)
	}
}

func TestExpiryAllowsSteal(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "exp"
	if _, err := s.Acquire(ctx, name, "a", 200*time.Millisecond); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	time.Sleep(300 * time.Millisecond) // let it expire on the DB clock
	l, err := s.Acquire(ctx, name, "b", time.Second)
	if err != nil || l.Holder != "b" || l.Epoch != 2 {
		t.Fatalf("steal expired: l=%+v err=%v, want holder b epoch 2", l, err)
	}
	// a's stale renew now fails (b holds it)
	if _, err := s.Renew(ctx, name, "a", time.Second); !errors.Is(err, lease.ErrNotHolder) {
		t.Fatalf("a renew after steal: err=%v, want ErrNotHolder", err)
	}
}

func TestRenewExpiredSelfReturnsErrExpired(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "exp2"
	if _, err := s.Acquire(ctx, name, "a", 200*time.Millisecond); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := s.Renew(ctx, name, "a", time.Second); !errors.Is(err, lease.ErrExpired) {
		t.Fatalf("renew expired self: err=%v, want ErrExpired", err)
	}
}

func TestConcurrentAcquireSingleWinner(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "race"
	const holders = 30
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	held := 0
	unexpected := []error{}
	for i := 0; i < holders; i++ {
		h := fmt.Sprintf("h%d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, err := s.Acquire(ctx, name, h, time.Minute)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
				if l.Epoch != 1 {
					unexpected = append(unexpected, fmt.Errorf("winner epoch %d, want 1", l.Epoch))
				}
			case errors.Is(err, lease.ErrHeld):
				held++
			default:
				unexpected = append(unexpected, err)
			}
		}()
	}
	wg.Wait()
	if len(unexpected) > 0 {
		t.Fatalf("unexpected: %v", unexpected)
	}
	if wins != 1 {
		t.Fatalf("winners = %d, want exactly 1", wins)
	}
	if held != holders-1 {
		t.Fatalf("ErrHeld count = %d, want %d", held, holders-1)
	}
}
```

> 第三方库 API 提示：若所装 testcontainers-go 版本的 `postgres.Run` 选项 / `wait` 路径 / `ConnectionString` 形态与上文不同，按该版本实际 API 微调（`go doc` 确认），保持行为不变。（PR #29 已验证 v0.43.0 与此写法一致。）

- [ ] **Step 4: 本地编译校验（无 Docker）+ 无标签基线 + 全量**

Run: `cd backend && go build ./... && go vet ./... && go test ./... && go mod tidy`
Expected: 全绿；`lease/pg` 报 “no test files”（集成测试被标签排除）；tidy 稳定。
Run: `cd backend && go test -c -tags=integration -o /dev/null ./internal/lease/pg/`
Expected: 编译成功、无输出（不起容器）。若 testcontainers 签名有差异按上文提示微调。
Run: `cd backend && go build ./cmd/signer && rm -f signer`
Expected: signer 构建成功（二进制已删）。

- [ ] **Step 5: 提交**

```bash
git add backend/internal/lease/pg/schema.go backend/internal/lease/pg/pg.go backend/internal/lease/pg/pg_integration_test.go
git commit --no-verify -m "feat(backend): Postgres lease.Store (DB-clock leases + testcontainers integration)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- 无 Docker 基线：`cd backend && go test ./... && go vet ./... && go build ./...` 全绿（lease/pg 集成被标签跳过）。
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./internal/lease/pg/` 成功；**真跑由 CI**（backend job 已 `-tags=integration`）在本 PR 拉起 Postgres 跑通 lifecycle/expiry/并发。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅新增 `internal/lease/{lease.go,decide.go,decide_test.go}` + `internal/lease/pg/{schema.go,pg.go,pg_integration_test.go}` + 两份 docs（testcontainers/pgx 已在 go.mod，`go mod tidy` 应无新增依赖）。

## 备注

- **不删行**保证 epoch 单调，天然对齐单写者层 per-key `Fence` 单调；换主抢占 epoch 递增使旧持有者在 `PgWriter.Authorize` 被 fence。
- DB 时钟在锁事务内读取（`extract(epoch from now())*1000`），所有实例同一时间源，skew-free；纯 `Decide` 仍可用假 nowMs 快速单测。
- 本片只产出租约与 epoch；心跳循环、per-key/leader 的 lease-name 映射、epoch→`Fence` 接线在切片③。
