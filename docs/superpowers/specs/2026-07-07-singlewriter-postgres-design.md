# Postgres(pgx) 单写者 `Writer` 实现设计

> M6「租约 fencing 单写者」的落地切片：把已合并的纯逻辑核 `internal/singlewriter`（PR #28）落到 Postgres，成为真正跨主机、持久的单写者。承接 spec `2026-07-07-singlewriter-core-design.md`。

## 背景与目标

`internal/singlewriter` 已提供：纯 `decide(State, Request) → (State, Grant, error)`（fence→时钟→无效额度→每日额度→nonce，拒绝不改状态）、`Mem` 内存参考实现、可复用一致性套件 `conformance.Run`。但 `Mem` 是进程内的，无法跨主机、重启即丢。

本切片交付一个 **Postgres 支持的 `Writer`**：在单个数据库事务内完成 fence 校验 + 每日额度扣减 + nonce 高水位推进，通过行锁实现跨进程/跨主机的每 key 互斥，并把状态持久化（重启不丢高水位）。它必须通过 **同一套** `conformance.Run`（与 `Mem` 行为一致、逻辑零漂移）。

## 范围

- 把核心 `decide` 导出为 `Decide`，供 pg 子包复用同一纯转移。
- 新增子包 `backend/internal/singlewriter/pg`：schema + `EnsureSchema` + `PgWriter`（实现 `singlewriter.Writer`）。
- testcontainers 集成测试（构建标签隔离），复用 `conformance.Run` + pg 专属并发测试。
- CI：backend job 的测试步骤加 `-tags=integration`。

**非目标**：租约 acquire/renew/心跳（切片②）、endpoint 接线（切片③）、多表迁移工具（M6 ledger 时再引入 goose/migrate）。

## 组件

### 1. 导出 `Decide`（`internal/singlewriter`）

把 `decide.go` 中的私有 `decide` 改名为导出的 `Decide`，签名不变：

```go
// Decide is the pure single-writer transition shared by every Writer backend
// (Mem, Postgres) so their behavior cannot drift.
func Decide(s State, r Request) (State, Grant, error)
```

同步更新两处包内调用：

- `mem.go`：`next, g, err := Decide(m.state[r.KeyID], r)`
- `decide_test.go`：全部 `decide(...)` → `Decide(...)`

`conformance` 子包不受影响（仅用公开的 `Writer`）。

### 2. 子包 `backend/internal/singlewriter/pg`

`package pg`，import `singlewriter` + `github.com/jackc/pgx/v5` + `github.com/jackc/pgx/v5/pgxpool`。核心 `singlewriter` 包**保持不 import pgx**。

#### 2a. Schema（嵌入式幂等 DDL）

```sql
CREATE TABLE IF NOT EXISTS sw_state (
  key_id      text PRIMARY KEY,
  fence       bigint NOT NULL,
  last_nonce  bigint NOT NULL,
  spend_day   bigint NOT NULL,
  spend_total double precision NOT NULL
);
```

```go
// EnsureSchema idempotently creates the sw_state table. A dedicated migration
// tool (goose/migrate) is deferred to the multi-table M6 ledger work.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error
```

**uint64 ↔ bigint 无损**：`fence`/`last_nonce` 是 `uint64`；Postgres `bigint` 是有符号 `int64`。写入时传 `int64(u)`（二补数位型），读出时 `uint64(int64Val)`——位型往返无损；DB 从不对这些列做算术（所有逻辑在 `Decide`），故 bigint 对完整 uint64 域正确。`spend_day` 天数（`int64`）本就在 int64 域内；`spend_total` → `double precision`（`float64`）。

#### 2b. `PgWriter`

```go
// PgWriter is a Postgres-backed singlewriter.Writer: it runs Decide inside a
// row-locked transaction so per-key authorization is atomic and durable across
// processes and hosts.
type PgWriter struct{ pool *pgxpool.Pool }

// New returns a PgWriter over the given pool. Callers run EnsureSchema once at
// startup before serving.
func New(pool *pgxpool.Pool) *PgWriter

func (w *PgWriter) Authorize(ctx context.Context, r singlewriter.Request) (singlewriter.Grant, error)
```

### 3. `Authorize` 事务流程（种子 → 锁 → 转移 → 写；拒绝即回滚）

单事务（默认 READ COMMITTED；`FOR UPDATE` 行锁让同 key 并发事务串行化）：

1. `BEGIN`
2. **种子零行**（保证 `FOR UPDATE` 有行可锁，消除新 key 的 PK 竞态）：
   `INSERT INTO sw_state(key_id,fence,last_nonce,spend_day,spend_total) VALUES($1,0,0,0,0) ON CONFLICT (key_id) DO NOTHING`
3. **加锁读**：`SELECT fence,last_nonce,spend_day,spend_total FROM sw_state WHERE key_id=$1 FOR UPDATE`，扫描为 `singlewriter.State`（`uint64(fence)`、`uint64(last_nonce)`）。
4. `next, grant, err := singlewriter.Decide(state, r)`
   - `err != nil`（`ErrFenced`/`ErrDailyCap`/`ErrInvalidNotional`/`ErrInvalidClock`）→ **`ROLLBACK`**（连种子一起撤销，无残留行）→ 返回该类型化 err。
   - 否则 `UPDATE sw_state SET fence=$2,last_nonce=$3,spend_day=$4,spend_total=$5 WHERE key_id=$1`（传 `int64(next.Fence)`、`int64(next.LastNonce)`）→ `COMMIT` → 返回 `grant`。
5. 任何 DB 错误（连接/查询/提交失败）→ 尽力 `ROLLBACK` + 返回**包装的基础设施错误**（`fmt.Errorf("pg singlewriter: ...: %w", err)`），与类型化拒绝区分开，便于上层映射（拒绝→4xx，基础设施→5xx）。

**不变量**：拒绝路径整事务回滚 = 状态零变更（对齐 `Decide` 的「拒绝纯读」契约）；`Decide` 在 `FOR UPDATE` 之后、`UPDATE` 之前调用，check-and-reserve 在锁内原子完成。

### 4. 测试（testcontainers + 复用 conformance）

- **构建标签隔离**：集成测试文件首行 `//go:build integration`。**生产代码 `pg.go`/`schema.go` 不带标签**（`go build ./...` 始终编译含 pgx）；**仅 `pg_integration_test.go` 带标签**。
  - 本地基线 `cd backend && go test ./...` 不需 Docker、跳过 pg 集成（该包报 “no test files” 或仅编译）。
  - CI 与「真跑」用 `cd backend && go test -tags=integration ./...`。
- **容器夹具**：`//go:build integration` 的测试中，用 `github.com/testcontainers/testcontainers-go/modules/postgres` 拉起 Postgres（固定镜像版本如 `postgres:17-alpine`），取 DSN 建 `pgxpool.Pool`，`EnsureSchema` 一次。容器/池在 `TestMain` 或包级 `sync.Once` 建一次、全测试共享。
- **复用一致性套件**：
  ```go
  conformance.Run(t, func() singlewriter.Writer {
      // TRUNCATE sw_state to guarantee empty state for each scenario.
      _, _ = pool.Exec(ctx, "TRUNCATE sw_state")
      return pg.New(pool)
  })
  ```
  conformance 各子测试顺序执行、每个先调 `newWriter`，故 `TRUNCATE` 隔离场景。这断言 `PgWriter` 与 `Mem` 在 fence/时钟/额度/跨日/无效输入/nonce 单调等 11 场景上**逐一致**。
- **pg 专属并发测试**（验证行锁而非内存锁）：`TRUNCATE` 后，N 个 goroutine 各持独立连接对同一 key 并发 `Authorize`（`per=100, cap=1000, 同 fence, 同 NowMs`）——断言成功笔数 `== cap/per`（不超额）、所有 `Grant.Nonce` **唯一**（不复用）。这验证 `FOR UPDATE` 跨事务互斥正确。

### 5. CI

`.github/workflows/ci.yml` 的 `backend` job：把 `Test` 步骤 `go test ./...` 改为 `go test -tags=integration ./...`（ubuntu-latest 自带 Docker，testcontainers 直接可用）。`Build`（`go build ./...`）、`Vet`（`go vet ./...`）不变。

依赖：`pgx/v5`（生产，进 signer 二进制）；`testcontainers-go` + 其 postgres 模块（仅 `//go:build integration` 测试引用，不进生产二进制）。

## 验证门

- 本地（无 Docker 亦可）：`cd backend && go test ./... && go vet ./... && go build ./...` 全绿（pg 集成被标签跳过）。
- 集成（需 Docker）：`cd backend && go test -tags=integration ./...` 全绿——`conformance.Run` 对 `PgWriter` 全过 + pg 并发测试通过。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅触及：`internal/singlewriter/{decide.go,mem.go,decide_test.go}`（导出 `Decide`）、新增 `internal/singlewriter/pg/*`、`.github/workflows/ci.yml`、`backend/go.mod`/`go.sum`、两份 docs。

## 备注

- pgx 成为 signer 的生产依赖，符合架构文档 §6.2 对 M6 的 Postgres 选型；testcontainers 仅测试、且标签隔离，不违背「signer 最小依赖」。
- `PgWriter` 本身不注入时钟：`NowMs` 由 `Request` 传入（与 `Decide` 一致），故 pg 层时钟无关、测试可注入固定时钟。
- 本片不改 `Mem`（除因 `decide`→`Decide` 改名产生的一处调用更新）、不接线 endpoint。
