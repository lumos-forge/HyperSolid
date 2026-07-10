# Signer IP / 地址级额度统管 — Design

**Date:** 2026-07-10  
**Status:** Approved  
**Scope:** 仅限 signer `/v1/sign/l1` ingress 配额；在现有 **per-key** 速率/日额度之上，新增 **per-(OwnerAddress, RemoteAddr)** 速率预算与 **per-OwnerAddress** 日 notional 额度。**不含** WS 分片配额、统一降级、代理头信任。

## 1. Goal

在 signer 现有的 **per-key** 令牌桶限流与 **per-key** 日 notional 额度之上，增加：

1. **per-(OwnerAddress, RemoteAddr)** 请求速率预算（token bucket）  
2. **per-OwnerAddress** 日 notional 额度（跨多个 key 聚合）

同时保持现有 M6/M10 核心不变：
- cloid 幂等 replay 仍不重复扣任何额度
- nonce / fence / 日额度仍是原子授权
- fail-closed

## 2. Why this slice

当前 signer 只做：
- `ratelimit.Limiter.Allow(req.KeyID, cfg.RatePerSec, cfg.RateBurst)` → **per-key** 速率预算
- `auth.Authorize(... DailyCap: cfg.DailyMaxNotionalUsdc ...)` → **per-key** 日额度

而 `docs/BACKEND-ARCHITECTURE.md §6` 仍明确缺少：
- **IP/地址级额度统管**
- WS 分片配额
- 临界统一降级

本片只解决其中最小、最独立、又与 signer 现有边界最贴近的一块：**ingress 配额统管**。

## 3. Locked semantics

本片经过确认后的固定语义如下：

### 3.1 Scope
- 只做 signer `/v1/sign/l1`
- 不做 WS `≤10 用户/IP`
- 不做统一降级

### 3.2 Address identity
- “地址”来自 **server-authoritative** 的 `policy.Config.OwnerAddress`
- 不由客户端请求体提供

### 3.3 IP identity
- 只认 `r.RemoteAddr`
- **不信任** `X-Forwarded-For` / `Forwarded`

### 3.4 IP aggregation key
- IP 预算按 **`(OwnerAddress, RemoteAddr)`** 聚合
- 同一用户在同一来源 IP 上共享一份 IP 桶
- 不同用户即使同 NAT，也不互相挤占

### 3.5 Cap relationship
- 现有 **per-key** 日额度继续保留
- 新增 **per-address** 日额度是**叠加**的第二道防线
- 一次 fresh 授权必须同时通过：
  - per-key 日额度
  - per-address 日额度

## 4. Config surface (`internal/policy.Config`)

`policy.Config` 新增 4 个字段：

```go
OwnerAddress               string
IPRatePerSec               float64
IPRateBurst                float64
AddressDailyMaxNotionalUsdc float64
```

语义：
- `OwnerAddress`：该 key 归属的权威地址（server 配置）
- `IPRatePerSec` / `IPRateBurst`：`(OwnerAddress, RemoteAddr)` 粒度的速率预算
- `AddressDailyMaxNotionalUsdc`：`OwnerAddress` 粒度的日 notional 额度

约束：
- 0 = disabled（与现有 `RatePerSec`、`DailyMaxNotionalUsdc` 一致）
- `policy.Evaluate()` 仍**忽略**这些状态型字段；它继续只做纯 reject-first 判定
- 若启用某项预算，但对应 identity 无法权威得到，则该预算 **fail-closed**

## 5. Identity normalization

### 5.1 OwnerAddress
新增一个小的 signer-side 规范化 helper（不引入新依赖）：
- trim 空白
- lower-case
- 必须 `0x` 前缀
- 必须 40 个 hex nybbles（总长 42）

若：
- `IPRatePerSec > 0` 或 `AddressDailyMaxNotionalUsdc > 0`
- 但 `OwnerAddress` 缺失 / 非法

则按对应预算维度 **fail-closed**。

### 5.2 RemoteAddr
只从 `r.RemoteAddr` 取 host：
- `net.SplitHostPort`
- `netip.ParseAddr`
- canonical `ip.String()`

若：
- `IPRatePerSec > 0`
- 但 `RemoteAddr` 缺失 / 非法

则 **429 fail-closed**。

## 6. Ingress rate limiting

保持现有 per-key limiter 不变，再新增第二个 limiter 实例：

- `keyLimiter`：继续按 `req.KeyID`
- `ipLimiter`：按 `ownerAddress + "|" + canonicalIP`

`handleSignL1` 入口顺序调整为：

1. decode request
2. lookup signer by `keyId`（未知仍 404）
3. `cfg := policies.Get(req.KeyID)`
4. 若 `cfg.IPRatePerSec > 0`：
   - 规范化 `OwnerAddress`
   - 解析 `RemoteAddr`
   - `ipLimiter.Allow(ownerIPKey, cfg.IPRatePerSec, cfg.IPRateBurst)`
   - 失败 → `429 "ip rate limit exceeded"`
5. 现有 `keyLimiter.Allow(req.KeyID, cfg.RatePerSec, cfg.RateBurst)`
   - 失败 → 继续保持 `429 "rate limit exceeded"`
6. 现有 `policy.Evaluate`
7. 构造 digest / fence
8. 进入 `auth.Authorize(...)`

这样：
- unknown key 仍优先 404
- IP 与 key 的速率限制都在真正授权前发生
- 两个 limiter 都是 O(1)、fail-closed、并发安全

## 7. Atomic per-address daily cap (ledger-layer, not front-door tracker)

### 7.1 Why at ledger layer

**不**在 handler 里另起一个 in-memory address spend tracker。  
原因：地址日额度必须与现有的
- cloid 幂等
- nonce 分配
- per-key 日额度
- fence

处在**同一个原子授权决策**里，否则会出现：
- replay 重复扣地址额度
- 多实例/并发下地址额度双扣
- fresh request 地址额度失败但 per-key nonce 已前进

`ledger` 已经掌握 “fresh vs duplicate replay”，所以它是正确承载层。

### 7.2 Ledger API changes

`ledger.Request` 新增：

```go
AddressSpendKey string
AddressDailyCap float64
```

含义：
- `AddressSpendKey`：规范化后的 `OwnerAddress`
- `AddressDailyCap`：该地址的日额度；0 = disabled

### 7.3 New spend state in ledger

在 `ledger` 包内新增一个小的纯状态：

```go
type SpendState struct {
    SpendDay   int64
    SpendTotal float64
}
```

以及一个纯 helper `DecideSpend(...)`：
- 输入：`state, notional, dailyCap, nowMs`
- 输出：`nextState` 或 typed error
- 逻辑与现有 daily cap 语义一致：
  - `dailyCap < 0` → fail-closed
  - `notional` NaN/Inf/negative → fail-closed
  - UTC day rollover reset
  - strict `>` 拒绝，exactly-at-cap 允许

### 7.4 `ledger.Decide(...)`

`ledger.Decide` 扩成同时处理：

1. 现有 replay/collision 判定
2. 现有 `singlewriter.Decide(...)`
   - per-key fence
   - per-key daily cap
   - nonce
3. 新的 address spend check/reserve

关键语义：
- **duplicate replay**：直接返回原 nonce，**不重复扣** per-key 或 per-address 额度
- 任一额度失败：
  - 不推进 nonce
  - 不写 ledger record
  - 不写 per-key / per-address spend state

## 8. Persistence model

### 8.1 `ledger.Mem`

新增：

```go
addrSpend map[string]SpendState
```

`Authorize` 仍在**同一把锁**下：
- 读取 `sw[r.KeyID]`
- 读取 `addrSpend[r.AddressSpendKey]`（仅当 `AddressDailyCap > 0`）
- 调 `ledger.Decide(...)`
- 仅在 fresh success 时一起写回：
  - `sw`
  - `addrSpend`
  - `records`
  - `updatedAt`

### 8.2 `ledger/pg`

新增表：

```sql
CREATE TABLE IF NOT EXISTS addr_spend_state (
    address_key text PRIMARY KEY,
    spend_day   bigint NOT NULL,
    spend_total double precision NOT NULL
)
```

`Authorize` 事务内流程：

1. 现有 `sw_state` seed + `FOR UPDATE`
2. 读取 `(keyID, cloid)` record
3. 若是 duplicate replay，直接返回（不触地址额度表）
4. 若 `AddressDailyCap > 0`：
   - `addr_spend_state` seed + `FOR UPDATE`
   - 读当前 `SpendState`
5. 调 `ledger.Decide(...)`
6. fresh success 时事务内一起更新：
   - `sw_state`
   - `addr_spend_state`（若启用）
   - `ledger_intents`

这保证：
- per-key cap
- per-address cap
- nonce
- ledger intent insertion

在一个事务里 all-or-nothing。

## 9. Error surface

HTTP outward surface：

- per-user-IP 预算超限 / IP identity 不可用（但 IP 预算启用）  
  → `429 "ip rate limit exceeded"`

- 现有 per-key 预算超限  
  → 保持 `429 "rate limit exceeded"`

- per-address 日额度超限 / 地址 identity 不可用（但地址额度启用）  
  → `403 "address daily cap exceeded"`

- 现有 per-key 日额度超限  
  → 保持 `403 "daily cap exceeded"`

fail-closed 继续优先于“尽量放行”。

## 10. Testing strategy

### 10.1 `internal/policy`
- 新字段零值默认不影响 `Evaluate`
- 明确 `Evaluate` 继续忽略 `OwnerAddress` / `IPRate*` / `AddressDailyMaxNotionalUsdc`

### 10.2 `internal/ledger` / `pg`
新增 conformance / integration coverage：

- **shared-address cap across keys**  
  同 `OwnerAddress` 的 `keyA`、`keyB` 共享地址日额度

- **different addresses isolated**  
  不同地址互不影响

- **duplicate replay does not recharge**  
  同 `(keyID, cloid, digest)` replay 不重复扣地址额度

- **address-cap denial is atomic**  
  地址额度失败时：
  - nonce 不推进
  - record 不写
  - per-key / per-address spend 均不变

### 10.3 `cmd/signer`
新增 handler tests：

- same `(OwnerAddress, RemoteAddr)` across two keys share one IP bucket
- same `RemoteAddr`, different owners do **not** share
- same owner, different IPs do **not** share
- invalid `RemoteAddr` with IP limit enabled → 429 fail-closed
- invalid/missing `OwnerAddress` with IP limit enabled → 429 fail-closed
- invalid/missing `OwnerAddress` with address daily cap enabled → 403 fail-closed
- sign path still preserves:
  - unknown key 404 before budgets
  - existing per-key rate behavior
  - existing per-key daily cap behavior

## 11. Out of scope

- WS `≤10 用户/IP`
- 统一降级
- 任何 `X-Forwarded-For` / `Forwarded` 信任模型
- 新 Prometheus 指标（本片先复用现有 429/403 + 结构化日志观察）

## 12. Verification gate

- `cd backend && go test ./...`
- `cd backend && go vet ./...`
- `cd backend && go test -race ./internal/... ./cmd/...`
- `cd backend && go build ./cmd/signer && rm -f signer`
- `cd backend && go test -c -tags=integration -o /dev/null ./...`

并新增覆盖：
- shared-address cap across keys
- duplicate replay not recharging address cap
- shared per-(owner,ip) limiter semantics
