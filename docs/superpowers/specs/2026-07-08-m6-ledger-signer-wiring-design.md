# M6 意图账本接线 signer `/v1/sign/l1`（`cmd/signer`）— 子项目 C

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）— 子项目 C（signer 接线）；依赖已合并的 A（`internal/ledger`，PR #39）

## 背景

子项目 A 交付了 `internal/ledger` cloid 幂等核心（纯 `Decide` + `Mem` + `conformance` +
Postgres `Store`），但**未接线**——签名端点 `/v1/sign/l1` 仍用 `singlewriter.Writer`
分配 nonce，幂等能力尚未在签名路径生效。

本子项目 C 把 `/v1/sign/l1` 的 nonce 分配从 `singlewriter.Writer` 切换到
`ledger.Authorizer`，让每个签名动作按幂等键（cloid）持久化入账并去重，完全实现
§6.2「杜绝重复/孤儿单」。**签名字节保持不变**（golden 逐字节仍过）。

## 关键约束：幂等键与 params.cloid 解耦

首个 golden order 向量的 `params` **不含** `cloid`；若把 cloid 写进 params 会改变被签
action 的 msgpack → 破坏 golden 逐字节一致。因此：

- 请求新增**顶层 `cloid` 字段**作为**我们的账本幂等键**，与 `params.cloid` **解耦**
  （不做一致性校验、不写入 params）。params 原样透传 → 签名字节不变。
- 幂等如何生效：账本对同一幂等键返回**同一 nonce** → 调用方重投**完全相同的已签
  payload（同 nonce）** → HL 按 **nonce 已用**拒绝重复 → 无重复单。（若调用方另在
  params 里也设了 cloid，HL 再加一层按 cloid 去重，属额外保险，非必需。）

## 目标

- `/v1/sign/l1` 经 `ledger.Authorizer` 分配 nonce；单写者从端点退役（ledger 是其超集，
  内部仍复用 `singlewriter.Decide`，nonce 权威单一、不分叉）。
- 顶层 `cloid` 必填（fail-closed）；缺失 → 400。
- intent 摘要（nonce 无关）驱动碰撞检测：同 cloid 改价/改量 → 409。
- golden 逐字节不变；幂等重放返回同 nonce + 同签名。

## 非目标（YAGNI）

- 不做 B（`submitted/open/filled/rejected` 终态；账本 `Status` 恒 `"signed"`）。
- 不改 `internal/ledger` 核心与 `internal/hl`。
- 不校验顶层 cloid 与 params.cloid 一致（见上「解耦」）。
- 不改 `/v1/digest/l1`（keyless）与 policy 评估逻辑。

## 架构与改动（仅 `backend/cmd/signer/`）

### 1. 请求/响应契约

```go
type signL1Request struct {
	KeyID     string          `json:"keyId"`
	Cloid     string          `json:"cloid"`  // NEW: ledger idempotency key (required)
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	IsTestnet bool            `json:"isTestnet"`
}

type signL1Response struct {
	R         string `json:"r"`
	S         string `json:"s"`
	V         int    `json:"v"`
	Nonce     uint64 `json:"nonce"`
	Duplicate bool   `json:"duplicate"` // NEW: true = idempotent replay
}
```

### 2. intent 摘要（nonce 无关）

在 `hl.ActionFromKind` 之后、`Authorize` 之前计算：

```go
enc, err := hl.Encode(action) // canonical msgpack, nonce-independent
if err != nil { writeErr(w, 400, ...); return }
h := sha256.New()
h.Write(enc)
if req.IsTestnet { h.Write([]byte{1}) } else { h.Write([]byte{0}) }
var digest [32]byte
copy(digest[:], h.Sum(nil))
```

同 (kind, params, isTestnet) → 同摘要（幂等重放）；改价/改量/切换 testnet → 异摘要
→ `ErrCloidReuse`（fail-closed）。

### 3. `handleSignL1`：用 `ledger.Authorizer` 取代 `singlewriter.Writer`

签名 handler 保持既有顺序（decode → keystore → policy.Evaluate → ActionFromKind →
fencer.Fence()），仅把授权步骤换成：

```go
grant, err := auth.Authorize(r.Context(), ledger.Request{
	KeyID:    req.KeyID,
	Cloid:    req.Cloid,
	Digest:   digest,
	Fence:    fence,
	Notional: intent.NotionalUsdc,
	DailyCap: cfg.DailyMaxNotionalUsdc,
	NowMs:    nowMs(),
})
```

错误映射（新增 2 条，其余透传不变）：

| 错误 | HTTP |
|---|---|
| `ledger.ErrMissingCloid` | 400 |
| `ledger.ErrCloidReuse` | 409 |
| `singlewriter.ErrFenced` | 409（不变） |
| `singlewriter.ErrDailyCap` | 403（不变） |
| `singlewriter.ErrInvalidNotional` | 403（不变） |
| `singlewriter.ErrInvalidClock` | 500（不变） |

用 `grant.Nonce` 签名（重放时为原 nonce → 重签字节相同）；响应 `Duplicate: grant.Duplicate`。

> 注：`ErrMissingCloid` 在 `ledger.Decide` 中先于 fence 检查。端点在 policy.Evaluate
> 与 fencer.Fence() **之后**才调用 `Authorize`，故既有「policy 403 / 非 leader 503 /
> 坏参数 400」路径（均在 Authorize 之前返回）不受影响。

### 4. `newMux` / `handleSignL1` 签名

`handleSignL1(ks, policies, auth ledger.Authorizer, fencer, nowMs)`；
`newMux(ks, policies, auth ledger.Authorizer, fencer, nowMs)`。
`Fencer` 接口与 `staticFencer` 不变。

### 5. `buildHandler` 接线

- `databaseURL == ""`（内存默认）：`auth := ledger.NewMem()`。
- 否则（Postgres）：`ledgerpg.EnsureSchema(ctx, pool)`（内部已链 `swpg.EnsureSchema`
  建 `sw_state` + 建 `ledger_intents`）→ `auth := ledgerpg.New(pool)`。
  移除单独的 `swpg.EnsureSchema` 调用与 `swpg.New`（由 ledgerpg 取代）。
  lease schema/leader 接线不变。

### 6. 测试更新（`cmd/signer/main_test.go` + `main_integration_test.go`）

- `leaderMux` 辅助：`ledger.NewMem()` 取代 `singlewriter.NewMem()`。
- `TestSignL1Endpoint`（golden）：请求补顶层 `"cloid":"golden-c1"`；**params 不变** →
  签名逐字节仍与向量一致；nonce 仍等于注入时钟。
- `TestSignL1NotLeader`：`newMux(..., ledger.NewMem(), ...)`；body 无需 cloid（503 在
  Authorize 前返回）。
- `TestSignL1FencedConflict`：用 `ledger.NewMem()` 预置——先
  `mem.Authorize(ctx, ledger.Request{KeyID:"k1", Cloid:"seed", Digest:[32]byte{9}, Fence:5, NowMs:...})`
  把 fence 推到 5；端点请求 body 补一个**不同**的 `"cloid":"req-c1"`（否则 `ErrMissingCloid`
  400 会先于 `ErrFenced`）→ 陈旧 epoch 1 → 409 fenced。
- `main_integration_test.go`：`sign(cloid string)`；轮询用 `"c1"`；「第二次签名」用
  **不同** `"c2"` → `n2 > n1`；再补一次 `"c1"` 断言得 `n1`（同 nonce，端到端幂等）。
- **新增单元测试**（`ledger.NewMem()` + `constFencer{leader:true}` + 注入时钟）：
  - 幂等重放：同 cloid + 同 params 二次请求 → 同 nonce、同 (r,s,v)、`duplicate:true`。
  - cloid 复用异摘要：同 cloid + 改 px → 409。
  - 缺 cloid：无 `cloid` 字段 → 400。
- 移除 `main_test.go` 中不再使用的 `singlewriter` import（若 FencedConflict 改造后未再直接用）。

## 数据流（接线后，端到端）

M4 → `POST /v1/sign/l1 {keyId, cloid, kind, params, isTestnet}` → policy.Evaluate →
`hl.ActionFromKind` → `digest=sha256(msgpack(action)‖testnet)` → fencer.Fence() →
`ledger.Authorize` →（首见）分配 nonce+入账 /（重放）返回原 nonce → `signer.SignL1Action(action, nonce)`
→ `{r,s,v,nonce,duplicate}`。重投同 cloid → 同 nonce → HL 按 nonce 拒重复。

## 验收门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./...`
  （`cmd/signer` 集成测试真跑需 Docker → CI 执行）。
