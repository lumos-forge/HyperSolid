# M6 意图账本 · cloid 幂等核心（`internal/ledger`）— 子项目 A

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）— 子项目 A（幂等核心）；后续 B（对账状态机）、C（signer 接线）

## 背景

M6 跨主机单写者（`internal/singlewriter`，PR #28–#33）已落地：对每个 agent key
原子地做 fence + 日限 + 严格递增 nonce。但签名路径尚未按 cloid 持久化意图、
也不做幂等——同一 cloid 的重试会分配**新** nonce，可能在 HL 侧留下重复/孤儿单。

本子项目 A 交付 **cloid 幂等意图账本核心** `internal/ledger`：签名前按
(keyID, cloid) 持久化 intent，同一 cloid（且 intent 摘要一致）重试返回**同一**
nonce（不重复分配、不重复计日限），从而重投在 HL 侧按 cloid 天然去重、成为
真正的幂等 no-op。**先不接线**（signer 集成 = 子项目 C）。

## 目标

- 新包 `internal/ledger`，四件套镜像 `singlewriter`：纯 `Decide` + `Mem` 参考实现
  + 独立 `conformance` 套件 + Postgres `Store`。
- cloid 幂等：同 cloid + 同摘要 → 返回原 grant（`Duplicate=true`），state 不变。
- 碰撞检测（生产级 fail-closed）：同 cloid + **不同摘要** → `ErrCloidReuse`（拒签）。
- 空 cloid → `ErrMissingCloid`（账本要求每单必须带 cloid）。
- 复用（DRY）已验证的 `singlewriter.Decide` 做 fence/日限/nonce，并**透传**其全部
  typed 错误（ErrFenced / ErrDailyCap / ErrInvalidNotional / ErrInvalidClock）。

## 非目标（YAGNI）

- 不接线 signer `/v1/sign/l1`（= 子项目 C）。
- 不做 `submitted/open/filled/rejected` 终态转移与撤单对账（= 子项目 B）；
  本子项目 `Record.Status` 恒为 `"signed"`，字段预留给 B 扩展。
- 不计算 intent 摘要（`Digest` 为调用方提供的不透明 `[32]byte`；C 接线时用
  signer 已算出的 HL action 哈希填充）。ledger 核心不依赖 `internal/hl`。
- 不改 `internal/singlewriter`（仅复用其 `Decide`/`State`/errors）。

## 架构

方案 1（组合复用 single-writer）。新包 `internal/ledger`：

```
internal/ledger/
  ledger.go               // 类型 + errors + Authorizer 接口
  decide.go               // 纯 Decide（内部调用 singlewriter.Decide）
  mem.go                  // Mem 参考实现（map + mutex）
  decide_test.go          // Decide 直接单测（可选，主覆盖在 conformance）
  mem_test.go             // conformance.Run(t, NewMem)
  conformance/
    conformance.go        // 可复用契约套件（import testing；生产库保持 testing-free）
  pg/
    pg.go                 // Postgres Store：一个 FOR UPDATE 事务跑 ledger.Decide
    schema.go             // ensure ledger_intents（并复用 swpg.EnsureSchema）
    pg_integration_test.go// //go:build integration；testcontainers；跑 conformance.Run
```

### 纯核心类型与 `Decide`

```go
// Request 是一次 cloid 幂等签名授权。
type Request struct {
    KeyID    string   // agent 私钥 id（复用 singlewriter 的 per-key 语义）
    Cloid    string   // 客户端订单 id；账本主键的一半；必须非空
    Digest   [32]byte // intent 摘要（调用方提供，通常为 HL action 哈希）
    Fence    uint64   // 租约 fencing token（透传给 singlewriter）
    Notional float64  // 本单 USD 名义额（透传）
    DailyCap float64  // per-key 日限（透传）
    NowMs    int64    // 调用方时钟 ms（透传；可注入）
}

// Grant 是一次被接受（或幂等重放）的授权结果。
type Grant struct {
    Nonce     uint64 // 用于签名的 nonce（新分配或原记录）
    Duplicate bool   // true = 幂等重放（返回原 nonce，未再计日限/未 bump nonce）
}

// Record 是账本中一条 (keyID, cloid) 意图记录（子项目 B 扩展 Status 转移）。
type Record struct {
    Nonce  uint64
    Digest [32]byte
    Status string // 本子项目恒为 "signed"
}

// Authorizer 是 cloid 幂等账本权威。
type Authorizer interface {
    Authorize(ctx context.Context, r Request) (Grant, error)
}

var (
    ErrMissingCloid = errors.New("missing cloid")        // 空 cloid → 拒签
    ErrCloidReuse   = errors.New("cloid reuse mismatch") // 同 cloid 异摘要 → 拒签
)
```

纯转移（`existing` 为该 (keyID,cloid) 的当前记录，无则 nil）：

```go
// Decide 是纯账本转移。existing==nil 表示该 cloid 首见。
// 返回下一 single-writer 状态、要持久化的记录、grant，或 typed error（拒绝时
// 不改任何状态）。Mem 与 Postgres 应用同一逻辑，行为不可漂移。
func Decide(sw singlewriter.State, existing *Record, r Request) (singlewriter.State, Record, Grant, error) {
    // 1. 空 cloid fail-closed（账本要求每单带 cloid 才能幂等）。
    if r.Cloid == "" {
        return sw, Record{}, Grant{}, ErrMissingCloid
    }
    // 2. 幂等重放 / 碰撞检测。
    if existing != nil {
        if existing.Digest != r.Digest {
            return sw, Record{}, Grant{}, ErrCloidReuse // 同 cloid 异摘要
        }
        // 同摘要 → 幂等重放：原 nonce，state 不变，未再计日限、未 bump nonce。
        return sw, *existing, Grant{Nonce: existing.Nonce, Duplicate: true}, nil
    }
    // 3. 首见 cloid → 复用 single-writer 做 fence+日限+nonce（透传其 typed 错误）。
    nextSW, swg, err := singlewriter.Decide(sw, singlewriter.Request{
        KeyID: r.KeyID, Fence: r.Fence, Notional: r.Notional, DailyCap: r.DailyCap, NowMs: r.NowMs,
    })
    if err != nil {
        return sw, Record{}, Grant{}, err
    }
    rec := Record{Nonce: swg.Nonce, Digest: r.Digest, Status: "signed"}
    return nextSW, rec, Grant{Nonce: swg.Nonce, Duplicate: false}, nil
}
```

### Mem 参考实现

`Mem` 持 `map[string]singlewriter.State`（per-key sw 状态）+
`map[recordKey]Record`（`recordKey = {keyID, cloid}`），单锁内查 existing → `Decide`
→ 非重放时持久化 nextSW + record → 返回 grant。镜像 `singlewriter.Mem`。

### conformance 套件（独立包 `ledger/conformance`）

`Run(t, newAuth func() ledger.Authorizer)` 覆盖：

1. 首见 cloid → nonce=NowMs，`Duplicate=false`。
2. 同 cloid + 同摘要重放 → `Duplicate=true`、同 nonce；且**未重复计日限**
   （用 notional 数值编排：cloid1 notional=600/cap=1000 → 重放 cloid1 →
   cloid2 notional=300 应成功=900≤1000；若重放误计则 1500>1000 会失败）。
3. 同 cloid + **异摘要** → `ErrCloidReuse`，state 不变（随后原摘要重放仍得原 nonce）。
4. 空 cloid → `ErrMissingCloid`，不消耗 nonce（随后正常 cloid 得 nonce=NowMs）。
5. 多个不同 cloid → 各自严格递增的不同 nonce。
6. 透传：stale fence→`ErrFenced`；超日限→`ErrDailyCap`；NaN/Inf/负 notional→
   `ErrInvalidNotional`；NowMs≤0→`ErrInvalidClock`（均不写记录）。
7. per-key 隔离：同一 cloid 在不同 keyID 下互不影响（各自独立记录与 nonce）。
8. 重放稳定性：cloid1 首见后经若干其它 cloid 推进 nonce，再重放 cloid1 仍返回
   其**原始** nonce（非当前 high-water）。

### Postgres `Store`

新表（复用 `singlewriter/pg` 的 `sw_state`）：

```sql
CREATE TABLE IF NOT EXISTS ledger_intents (
    key_id     text NOT NULL,
    cloid      text NOT NULL,
    nonce      bigint NOT NULL,       -- uint64 位模式存 int64（DB 不做算术）
    digest     bytea NOT NULL,
    status     text NOT NULL,
    notional   double precision NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, cloid)
)
```

`Store.Authorize` 在**一个** `BeginTx(ReadCommitted)` 事务里：
1. seed `sw_state`（`INSERT … ON CONFLICT DO NOTHING`，与 singlewriter/pg 同款，
   保证有行可锁，规避新 key 竞态）。
2. `SELECT … FOR UPDATE` 锁 `sw_state`（per-key 互斥，跨事务序列化同 key 写者）。
3. `SELECT nonce,digest,status FROM ledger_intents WHERE key_id=$1 AND cloid=$2`
   （sw_state 的行锁已给该 key 互斥，故此处无需再 FOR UPDATE）；命中则装配
   `*Record`，否则 nil。
4. 跑 `ledger.Decide(swState, existing, r)`。
5. typed 拒绝 → 返回（deferred Rollback 撤销 seed，无状态变化）；
   `Duplicate=true` → 直接返回 grant（不写任何行）；
   新记录 → `UPDATE sw_state`（写回 Decide 的 nextSW）+
   `INSERT INTO ledger_intents(...)` → `COMMIT`。
6. 基础设施错误包裹（5xx），与 typed 拒绝（4xx）区分。

`EnsureSchema` 先调 `swpg.EnsureSchema(ctx, pool)` 复用 `sw_state` DDL，再建
`ledger_intents`（DRY：sw_state 逻辑与 DDL 皆不重复；仅在本事务内重新声明
seed/select/update `sw_state` 的 SQL 字面量，因其 schema 稳定）。

集成测试 `//go:build integration` + testcontainers（`postgres:17-alpine`），
跑 `conformance.Run(t, func() ledger.Authorizer { return pg.New(pool) })` +
一个「同 cloid 并发只放行一次、另一路得同 nonce」的并发用例，验证行锁。
本地仅编译校验（`go test -c -tags=integration`），CI 真跑（已有 pre-pull 步骤）。

## 数据流（本子项目内，未接线）

调用方（未来 C）→ `ledger.Authorize({KeyID,Cloid,Digest,Fence,Notional,DailyCap,NowMs})`
→ Decide（幂等/碰撞/透传 single-writer）→ `Grant{Nonce, Duplicate}`。
`Duplicate=true` 时调用方复用原签名重投；`false` 时用返回 nonce 首次签名。

## 错误处理（fail-closed）

| 情形 | 错误 | 未来 HTTP（C） |
|---|---|---|
| 空 cloid | `ErrMissingCloid` | 400 |
| 同 cloid 异摘要 | `ErrCloidReuse` | 409 |
| stale fence | `ErrFenced`（透传） | 409 |
| 超日限 / 负 cap | `ErrDailyCap`（透传） | 403 |
| NaN/Inf/负 notional | `ErrInvalidNotional`（透传） | 403 |
| NowMs≤0 | `ErrInvalidClock`（透传） | 400/500 |

任何拒绝都不改状态、不写记录、不消耗 nonce（除单写者语义：日限拒绝本就不 bump nonce）。

## 测试门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/...`
- `cd backend && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./internal/ledger/pg/`
  （真跑需 Docker，本地不可用 → CI 执行）。
