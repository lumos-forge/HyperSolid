# Postgres(pgx) 单写者 `Writer` 实现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `internal/singlewriter` 增加一个 Postgres 支持的 `Writer`（`internal/singlewriter/pg`）：在单个行锁事务内运行共享的 `Decide` 转移，实现跨主机、持久、每 key 原子的 fence+额度+nonce 授权，并通过同一套 `conformance.Run`。

**Architecture:** 先把核心私有 `decide` 导出为 `Decide`（供子包复用、零漂移）；再写 pgx 生产代码（幂等 `EnsureSchema` + `PgWriter.Authorize`：种子零行 → `SELECT … FOR UPDATE` → `Decide` → `UPDATE`/`COMMIT`，拒绝即整事务回滚）；最后用 testcontainers 起真实 Postgres 跑 `conformance.Run` + 跨事务并发测试，集成测试用 `//go:build integration` 标签隔离，CI 加 `-tags=integration`。

**Tech Stack:** Go 1.26；`github.com/jackc/pgx/v5` + `pgxpool`（生产）；`github.com/testcontainers/testcontainers-go` + `.../modules/postgres`（仅测试、标签隔离）；`postgres:17-alpine`。

---

## File Structure

- `backend/internal/singlewriter/decide.go` — 私有 `decide` → 导出 `Decide`（改名 + 文档）。（Task 1）
- `backend/internal/singlewriter/mem.go` — 调用点 `decide(...)` → `Decide(...)`。（Task 1）
- `backend/internal/singlewriter/decide_test.go` — 全部 `decide(...)` → `Decide(...)`。（Task 1）
- `backend/internal/singlewriter/pg/schema.go` — DDL 常量 + `EnsureSchema(ctx, pool)`。（Task 2）
- `backend/internal/singlewriter/pg/pg.go` — `PgWriter` + `New` + `Authorize`（事务化）。（Task 2）
- `backend/go.mod` / `go.sum` — 加 `pgx/v5`（Task 2）、`testcontainers-go` + postgres 模块（Task 3）。
- `backend/internal/singlewriter/pg/pg_integration_test.go` — `//go:build integration`；testcontainers 夹具 + `conformance.Run` + 并发测试。（Task 3）
- `.github/workflows/ci.yml` — backend job 的 Test 步骤加 `-tags=integration`。（Task 3）

> 约定参照：模块路径 `github.com/lumos-forge/hypersolid/backend`；现有 `internal/singlewriter/{singlewriter.go,decide.go,mem.go}` 已定义 `Request{KeyID,Fence,Notional,DailyCap,NowMs}`、`Grant{Nonce}`、`State{Fence,LastNonce,SpendDay,SpendTotal}`、`Writer`、`ErrFenced/ErrDailyCap/ErrInvalidNotional/ErrInvalidClock`。所有提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: 导出核心转移 `Decide`

**Files:**
- Modify: `backend/internal/singlewriter/decide.go`
- Modify: `backend/internal/singlewriter/mem.go`
- Modify: `backend/internal/singlewriter/decide_test.go`

- [ ] **Step 1: 改测试调用点（先让其反映新 API）**

在 `backend/internal/singlewriter/decide_test.go` 中，把**每一处** `decide(` 调用改为 `Decide(`（分布在 `TestDecideFreshKeyNonceIsNow`、`TestDecideNonceStrictlyIncreasesOnClockRegress`、`TestDecideFenceRejectsStaleToken`、`TestDecideFenceEqualAndHigherAccepted`、`TestDecideDailyCapStrictBoundary`、`TestDecideZeroCapUnlimited`、`TestDecideDayRollResetsSpend`、`TestDecideInvalidNotionalFailsClosed`、`TestDecideNegativeCapFailsClosed`、以及 M1 修复新增的 `TestDecideInvalidClockFailsClosed`）。用 grep 找全并逐一替换：`grep -n 'decide(' backend/internal/singlewriter/decide_test.go`。

- [ ] **Step 2: 运行验证失败**

Run: `cd backend && go test ./internal/singlewriter/ -run TestDecide`
Expected: FAIL —— 编译错误 `undefined: Decide`（`decide` 尚未改名）。

- [ ] **Step 3: 导出 `decide` → `Decide`**

在 `backend/internal/singlewriter/decide.go` 中，把函数改名并更新文档首行：
- 第 5 行注释 `// decide is the pure single-writer transition.` → `// Decide is the pure single-writer transition.`
- 第 12 行 `func decide(s State, r Request) (State, Grant, error) {` → `func Decide(s State, r Request) (State, Grant, error) {`

在 `backend/internal/singlewriter/mem.go` 第 25 行，把调用改名：
- `next, g, err := decide(m.state[r.KeyID], r)` → `next, g, err := Decide(m.state[r.KeyID], r)`

- [ ] **Step 4: 运行验证通过 + 全量 + vet**

Run: `cd backend && go test ./internal/singlewriter/... && go vet ./internal/singlewriter/... && go test ./...`
Expected: PASS —— `TestDecide*`、`TestMemConformance`、并发测试全过；vet 无输出；全量测试全绿。

- [ ] **Step 5: 提交**

```bash
git add backend/internal/singlewriter/decide.go backend/internal/singlewriter/mem.go backend/internal/singlewriter/decide_test.go
git commit --no-verify -m "refactor(backend): export singlewriter.Decide for reuse by backends

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Postgres 生产代码（schema + PgWriter）

**Files:**
- Create: `backend/internal/singlewriter/pg/schema.go`
- Create: `backend/internal/singlewriter/pg/pg.go`
- Modify: `backend/go.mod` / `backend/go.sum`（加 pgx/v5）

> 说明：`PgWriter` 需要真实 DB 才能运行，无法脱库单测；其行为验证由 Task 3 的 testcontainers 集成测试完成。本任务只写生产代码并确保**编译 + vet 通过**。

- [ ] **Step 1: 加 pgx 依赖**

Run: `cd backend && go get github.com/jackc/pgx/v5@latest`
Expected: `go.mod` 出现 `github.com/jackc/pgx/v5`；无错误。

- [ ] **Step 2: 写 schema.go**

创建 `backend/internal/singlewriter/pg/schema.go`：
```go
package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// createSchemaSQL is the single-table DDL for the single-writer state. Columns
// fence/last_nonce hold uint64 values stored as their int64 bit-pattern (the DB
// never does arithmetic on them; all logic is in singlewriter.Decide), so bigint
// round-trips the full uint64 domain losslessly.
const createSchemaSQL = `CREATE TABLE IF NOT EXISTS sw_state (
	key_id      text PRIMARY KEY,
	fence       bigint NOT NULL,
	last_nonce  bigint NOT NULL,
	spend_day   bigint NOT NULL,
	spend_total double precision NOT NULL
)`

// EnsureSchema idempotently creates the sw_state table. A dedicated migration
// tool (goose/migrate) is deferred to the multi-table M6 ledger work.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, createSchemaSQL)
	return err
}
```

- [ ] **Step 3: 写 pg.go（PgWriter + Authorize）**

创建 `backend/internal/singlewriter/pg/pg.go`：
```go
// Package pg is a Postgres-backed singlewriter.Writer: it runs singlewriter.Decide
// inside a row-locked transaction so per-key authorization (fence + daily cap +
// nonce high-water) is atomic and durable across processes and hosts
// (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package pg

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// PgWriter is a Postgres-backed singlewriter.Writer.
type PgWriter struct{ pool *pgxpool.Pool }

// New returns a PgWriter over the given pool. Run EnsureSchema once at startup
// before serving.
func New(pool *pgxpool.Pool) *PgWriter { return &PgWriter{pool: pool} }

const (
	seedSQL   = `INSERT INTO sw_state (key_id, fence, last_nonce, spend_day, spend_total) VALUES ($1, 0, 0, 0, 0) ON CONFLICT (key_id) DO NOTHING`
	selectSQL = `SELECT fence, last_nonce, spend_day, spend_total FROM sw_state WHERE key_id = $1 FOR UPDATE`
	updateSQL = `UPDATE sw_state SET fence = $2, last_nonce = $3, spend_day = $4, spend_total = $5 WHERE key_id = $1`
)

// Authorize runs Decide inside a single row-locked transaction: it seeds a zero
// row, locks it FOR UPDATE (per-key mutual exclusion across transactions),
// applies Decide, and either COMMITs the new state or rolls back on a typed
// rejection (leaving no state change). Infrastructure errors are wrapped so the
// caller can distinguish them (5xx) from typed policy rejections (4xx).
func (w *PgWriter) Authorize(ctx context.Context, r singlewriter.Request) (singlewriter.Grant, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: begin: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after a successful Commit; undoes the seed on any reject/error

	if _, err := tx.Exec(ctx, seedSQL, r.KeyID); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: seed: %w", err)
	}

	var fence, lastNonce, spendDay int64
	var spendTotal float64
	if err := tx.QueryRow(ctx, selectSQL, r.KeyID).Scan(&fence, &lastNonce, &spendDay, &spendTotal); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: select: %w", err)
	}
	state := singlewriter.State{
		Fence:      uint64(fence),
		LastNonce:  uint64(lastNonce),
		SpendDay:   spendDay,
		SpendTotal: spendTotal,
	}

	next, grant, derr := singlewriter.Decide(state, r)
	if derr != nil {
		// Typed rejection: the deferred Rollback undoes the seed → no state change.
		return singlewriter.Grant{}, derr
	}

	if _, err := tx.Exec(ctx, updateSQL, r.KeyID, int64(next.Fence), int64(next.LastNonce), next.SpendDay, next.SpendTotal); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: commit: %w", err)
	}
	return grant, nil
}

// compile-time assertion that PgWriter satisfies the Writer interface.
var _ singlewriter.Writer = (*PgWriter)(nil)
```

- [ ] **Step 4: 编译 + vet + tidy**

Run: `cd backend && go build ./... && go vet ./... && go mod tidy && go build ./cmd/signer && rm -f signer`
Expected: 全部成功；`go mod tidy` 稳定（pgx 保留在 go.mod）；vet 无输出；signer 构建成功（二进制已删）。
Run: `cd backend && go test ./...`
Expected: PASS —— 现有全量测试仍全绿（pg 包尚无非标签测试文件，报 “no test files” 属正常）。

- [ ] **Step 5: 提交**

```bash
git add backend/internal/singlewriter/pg/schema.go backend/internal/singlewriter/pg/pg.go backend/go.mod backend/go.sum
git commit --no-verify -m "feat(backend): Postgres-backed singlewriter.Writer (schema + tx Authorize)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: testcontainers 集成测试 + CI

**Files:**
- Create: `backend/internal/singlewriter/pg/pg_integration_test.go`（`//go:build integration`）
- Modify: `backend/go.mod` / `backend/go.sum`（加 testcontainers）
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 加 testcontainers 依赖**

Run: `cd backend && go get github.com/testcontainers/testcontainers-go@latest github.com/testcontainers/testcontainers-go/modules/postgres@latest`
Expected: 二者进入 `go.mod`；无错误。

- [ ] **Step 2: 写集成测试（标签隔离，复用 conformance + 并发）**

创建 `backend/internal/singlewriter/pg/pg_integration_test.go`：
```go
//go:build integration

package pg_test

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter/conformance"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter/pg"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("sw"),
		tcpostgres.WithUsername("sw"),
		tcpostgres.WithPassword("sw"),
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

func TestPgWriterConformance(t *testing.T) {
	ctx := context.Background()
	conformance.Run(t, func() singlewriter.Writer {
		if _, err := testPool.Exec(ctx, "TRUNCATE sw_state"); err != nil {
			t.Fatalf("truncate: %v", err)
		}
		return pg.New(testPool)
	})
}

func TestPgWriterConcurrentNoReuseNoOverspend(t *testing.T) {
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, "TRUNCATE sw_state"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	w := pg.New(testPool)
	const per = 100.0
	const cap = 1000.0
	const goroutines = 50
	const now = int64(1_700_000_000_000)
	var wg sync.WaitGroup
	var mu sync.Mutex
	nonces := make(map[uint64]int)
	accepted := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g, err := w.Authorize(ctx, singlewriter.Request{KeyID: "k1", Fence: 1, Notional: per, DailyCap: cap, NowMs: now})
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
		t.Fatalf("accepted = %d, want %d (no overspend across transactions)", accepted, int(cap/per))
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

> 第三方库 API 提示：若安装的 testcontainers-go 版本的 `postgres.Run` 选项名或 `wait` 包路径与上文略有出入（如 `WithOccurrence` 签名、`ConnectionString` 参数形态），按该版本的实际 API 微调导入与调用，保持行为不变（起容器 → 取 DSN → 建 pool → `EnsureSchema`）。运行 Step 3 时编译器会明确指出任何签名差异。

- [ ] **Step 3: 运行集成测试（需 Docker）**

Run: `cd backend && go mod tidy && go test -tags=integration ./internal/singlewriter/pg/ -v`
Expected: PASS —— `TestPgWriterConformance`（`conformance.Run` 的 11 个子场景对 `PgWriter` 全过）+ `TestPgWriterConcurrentNoReuseNoOverspend`（成功 10 笔、nonce 全唯一）。首次运行会拉取 `postgres:17-alpine` 镜像，耗时数十秒。

- [ ] **Step 4: 确认无标签基线不受影响**

Run: `cd backend && go test ./... && go vet ./... && go build ./...`
Expected: 全绿（pg 集成测试被 `//go:build integration` 排除，故本地无 Docker 亦通过）。

- [ ] **Step 5: CI 加 `-tags=integration`**

在 `.github/workflows/ci.yml` 的 `backend` job 中，把 Test 步骤改为带标签（ubuntu-latest 自带 Docker，testcontainers 直接可用）：
```yaml
      - name: Test
        run: go test -tags=integration ./...
```
（即把原第 63–64 行的 `- name: Test` / `run: go test ./...` 的 `run` 改为 `go test -tags=integration ./...`；`Build`/`Vet` 步骤不变。）

- [ ] **Step 6: 提交**

```bash
git add backend/internal/singlewriter/pg/pg_integration_test.go backend/go.mod backend/go.sum .github/workflows/ci.yml
git commit --no-verify -m "test(backend): testcontainers integration for pg singlewriter + CI -tags=integration

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- 无 Docker 基线：`cd backend && go test ./... && go vet ./... && go build ./...` 全绿（pg 集成被标签跳过）。
- 集成（需 Docker）：`cd backend && go test -tags=integration ./...` 全绿。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅触及：`internal/singlewriter/{decide.go,mem.go,decide_test.go}`、新增 `internal/singlewriter/pg/{schema.go,pg.go,pg_integration_test.go}`、`.github/workflows/ci.yml`、`backend/go.mod`/`go.sum`、两份 docs。

## 备注

- pgx 是 signer 的生产依赖（对齐架构文档 §6.2 的 M6 Postgres 选型）；testcontainers 仅被 `//go:build integration` 测试引用，不进生产二进制。
- `PgWriter` 与 `Mem` 共用 `singlewriter.Decide`，行为由**同一** `conformance.Run` 钉死；本片不接线 endpoint、不做租约生命周期。
- READ COMMITTED + `SELECT … FOR UPDATE` 行锁即可保证同 key 跨事务串行化；种子 `INSERT … ON CONFLICT DO NOTHING` 消除新 key 的 PK 竞态，且拒绝路径整事务回滚不留残行。
