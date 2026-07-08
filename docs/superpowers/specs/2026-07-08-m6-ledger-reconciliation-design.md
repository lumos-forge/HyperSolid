# M6 意图账本 · 对账状态机 + 孤儿单侦测（`internal/ledger`）— 子项目 B

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）— 子项目 B；A（cloid 幂等核心 PR #39）+ C（signer 接线 PR #40）已合并

## 背景

A 交付了 cloid 幂等入账（记录初始 `status="signed"`），C 让签名路径经账本生效。
但账本记录停在 `signed`——尚无「提交 → 对账 open/filled/rejected」终态推进，也无
「签了但迟迟无终态确认」的**孤儿单侦测**。§6.2：意图 → 持久化 → 签名 → 提交 →
按 cloid 对账。本子项目 B 补齐这条链的对账端。

## 目标

- 对 (keyID, cloid) 记录的**对账状态机**：`signed → submitted → open → filled/rejected/canceled`，
  校验合法转移、幂等重报、拒绝非法转移（fail-closed）。
- **孤儿单侦测**：列出非终态且 `updatedAt` 早于给定 cutoff 的记录。
- 纯核心 + Mem + conformance + Postgres，镜像 A。**先不接线**（不接 HL 回执源/轮询、不加端点）。

## 状态与转移（粗粒度）

状态（`type Status string`）：`signed`(初始)、`submitted`、`open`、终态 `filled`/`rejected`/`canceled`。

允许转移（其余一律 `ErrInvalidTransition`）：

| current | 允许 target |
|---|---|
| signed | submitted, rejected |
| submitted | open, filled, rejected |
| open | filled, canceled, rejected |
| （任意）| 自身（幂等 no-op，含终态自身） |

终态（filled/rejected/canceled）除幂等自身外不可再转移（含跨终态 filled→rejected 亦拒绝）。
部分成交不单列状态——仍归 `open`（仍被孤儿侦测盯住）。

## 架构（扩展 `internal/ledger`）

```
internal/ledger/
  ledger.go        // +Status 类型/常量, Orphan, ErrInvalidTransition/ErrUnknownIntent,
                   //  Reconciler / Ledger 接口；Record.Status: string → Status
  decide.go        // Status: "signed" → StatusSigned（唯一改动）
  reconcile.go     // NEW: 纯 Transition + isTerminal + allowedTransitions
  mem.go           // +updatedAt 跟踪；实现 Reconcile / Orphans
  reconcile_test.go// NEW: Transition 直接单测
  mem_test.go      // +conformance.RunReconcile(t, Mem)
  conformance/
    conformance.go // +RunReconcile(t, newLedger func() ledger.Ledger)
  pg/
    schema.go      // +ALTER TABLE ... ADD COLUMN IF NOT EXISTS updated_at
    pg.go          // +Reconcile / Orphans；status 扫描为 Status
    pg_integration_test.go // +RunReconcile(Store) + 并发同 cloid 重复转移用例
```

### 纯核心类型与转移

```go
type Status string

const (
	StatusSigned    Status = "signed"
	StatusSubmitted Status = "submitted"
	StatusOpen      Status = "open"
	StatusFilled    Status = "filled"
	StatusRejected  Status = "rejected"
	StatusCanceled  Status = "canceled"
)

// Record.Status 类型由 string 改为 Status（A 的 decide.go 置 StatusSigned）。

type Orphan struct {
	KeyID       string
	Cloid       string
	Nonce       uint64
	Status      Status
	UpdatedAtMs int64
}

type Reconciler interface {
	// Reconcile 校验 current→target 转移并持久化，成功即刷新 updatedAt=now()（含幂等
	// 重报同状态——视作「proof of life」，刷新孤儿计时）。未知 (keyID,cloid) →
	// ErrUnknownIntent；非法转移 → ErrInvalidTransition（不改状态、不刷 updatedAt）。
	Reconcile(ctx context.Context, keyID, cloid string, target Status) (Status, error)
	// Orphans 返回非终态且 updatedAt < olderThanMs 的记录（跨所有 key）。
	Orphans(ctx context.Context, olderThanMs int64) ([]Orphan, error)
}

// Ledger 组合幂等授权与对账，供 conformance 与生产接线复用。
type Ledger interface {
	Authorizer
	Reconciler
}

var (
	ErrInvalidTransition = errors.New("invalid status transition")
	ErrUnknownIntent     = errors.New("unknown intent")
)
```

`reconcile.go` 纯转移：

```go
// isTerminal 报告 s 是否为终态。
func isTerminal(s Status) bool // filled/rejected/canceled

// allowedTransitions 是各源状态允许的目标集合（不含幂等自身）。
var allowedTransitions = map[Status]map[Status]bool{
	StatusSigned:    {StatusSubmitted: true, StatusRejected: true},
	StatusSubmitted: {StatusOpen: true, StatusFilled: true, StatusRejected: true},
	StatusOpen:      {StatusFilled: true, StatusCanceled: true, StatusRejected: true},
}

// Transition 校验 current→target：相同 → 幂等返回；在允许集合内 → 返回 target；
// 否则 ErrInvalidTransition。current 状态字符串不合法（非六态之一）亦拒绝。
func Transition(current, target Status) (Status, error) {
	if current == target {
		return current, nil // idempotent (含终态重报)
	}
	if allowedTransitions[current][target] {
		return target, nil
	}
	return current, ErrInvalidTransition
}
```

### Mem

`Mem` 增加 `updatedAt map[recordKey]int64`。`Authorize`（A）在写入新记录时打
`time.Now().UnixMilli()`；`Reconcile` 查 existing（无 → `ErrUnknownIntent`）→ `Transition`
（非法 → 直接返回，不改任何状态）→ 更新 `records[rk].Status` 与 `updatedAt[rk]=now`
（成功即刷新，幂等重报同状态也刷新）→ 返回新状态。`Orphans` 遍历 records，收集
`!isTerminal(status) && updatedAt < olderThanMs`。单锁保护。

### conformance：`RunReconcile`

`RunReconcile(t, newLedger func() ledger.Ledger)`。每场景先用 `Authorize` 播下 `signed`
记录（复用 A 的 Request；Digest 任意、Fence/NowMs 合法）。覆盖：

1. 正向链：signed→submitted→open→filled，每步 `Reconcile` 返回对应状态、无错。
2. 幂等重报：对已 `filled` 记录再 `Reconcile(filled)` → 返回 filled、无错。
3. 非法转移：filled→open、open→signed、filled→rejected（跨终态）→ `ErrInvalidTransition`；
   状态不变——**间接验证**：随后对该记录做一个合法转移/幂等重报（如 open→filled 成功返回
   filled，或 filled→filled 返回 filled），证明非法尝试未污染状态（无需 Get 方法）。
4. 未知意图：`Reconcile` 一个从未 `Authorize` 的 (keyID,cloid) → `ErrUnknownIntent`。
5. 孤儿侦测：播 3 个 signed，其一 → filled（终态）、其一 → open（非终态），其一留 signed；
   `Orphans(farFuture=4_000_000_000_000)` → 返回 open+signed 两条、**不含** filled；
   `Orphans(farPast=1_000_000_000)` → 空。
6. 跨 key 孤儿：两个不同 key 各留一个非终态 → `Orphans(farFuture)` 均返回（Orphan.KeyID 正确）。

> 时钟无关性：Mem 用 wall clock、pg 用 DB `now()` 打 updatedAt；用**极端 cutoff**
> （远未来抓全部、远过去抓 0）使两实现结果一致，无需控制真实时钟。

### Postgres `Store`

- `schema.go` 的 `EnsureSchema` 在建表后追加：
  `ALTER TABLE ledger_intents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`
  （A 的 `recInsertSQL` 不设 updated_at → 插入时默认 `now()`，即签名时刻）。
- `Reconcile`：`BeginTx(ReadCommitted)` → `SELECT status FROM ledger_intents WHERE key_id=$1 AND cloid=$2 FOR UPDATE`
  （无行 `pgx.ErrNoRows` → `ErrUnknownIntent`）→ `Transition(current, target)`（非法 → 返回，deferred Rollback）
  → `UPDATE ledger_intents SET status=$3, updated_at=now() WHERE key_id=$1 AND cloid=$2`（成功即写，
  含幂等重报同状态刷新 updated_at）→ Commit。返回新状态。
- `Orphans`：`SELECT key_id, cloid, nonce, status, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint
  FROM ledger_intents WHERE status NOT IN ('filled','rejected','canceled') AND updated_at < to_timestamp($1/1000.0)`
  → 装配 `[]Orphan`（nonce 的 int64 位模式转 uint64）。
- 基础设施错误包裹（5xx）、typed 拒绝（ErrUnknownIntent/ErrInvalidTransition）直返（4xx）。

集成测试：`RunReconcile(t, func() ledger.Ledger { TRUNCATE; return pg.New(pool) })` +
一个「并发对同一 signed 记录多次 `Reconcile(submitted)`：全部成功且最终状态 submitted、
无因竞态产生的非法转移错误」的用例（验证 `FOR UPDATE` 行锁序列化）。本地仅编译校验，CI 真跑。

## 错误处理（fail-closed）

| 情形 | 错误 | 未来 HTTP（接线时） |
|---|---|---|
| 未知 (keyID,cloid) | `ErrUnknownIntent` | 404 |
| 非法转移（回退/跨终态/终态外推）| `ErrInvalidTransition` | 409 |
| 基础设施（DB）| 包裹错误 | 500 |

## 非目标（YAGNI）

- 不接 HL 回执源（userFills/orderStatus 轮询）与不加 HTTP 端点（后续 slice）。
- 不做部分成交量跟踪、不单列 partiallyFilled。
- 不动 `internal/hl`、不改 `internal/singlewriter`。
- 不对孤儿单采取动作（撤单）——仅侦测返回候选。

## 验收门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./internal/ledger/pg/`（真跑需 Docker → CI）。
