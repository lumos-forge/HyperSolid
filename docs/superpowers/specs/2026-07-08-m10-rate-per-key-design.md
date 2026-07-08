# M10-rate：按 key 令牌桶限流设计

日期：2026-07-08
状态：已批准

## 背景

signer 目前对签名请求有多重 fail-closed 闸门：reject-first 策略（`policy.Evaluate`）、leader gate、单写者原子的 fencing + 日 notional 上限 + nonce。但**没有请求速率限制**：一个失控的 agent 或客户端 bug 可在极短时间内发起海量签名请求，冲击 signer 与下游 Hyperliquid。本切片补齐**按 key 的令牌桶限流**，超额 fail-closed 拒绝（HTTP 429）。

采用**令牌桶（token bucket）**：每 key 配 `RatePerSec`（稳态速率）+ `RateBurst`（桶容量/突发上限），平滑限速、允许可控突发、O(1)、无需存每请求时间戳，是生产标准的"速率预算"语义。实现仿现有 `policy.SpendTracker` 的有状态 per-key 模式（配置存 `policy.Config`，状态存独立组件，limit 参数按调用传入）。

## 目标

- 新增 `internal/ratelimit` 包：per-key 令牌桶 `Limiter`，并发安全，fail-closed。
- `policy.Config` 新增 `RatePerSec` / `RateBurst` 两字段（0 = 禁用，语义同 `DailyMaxNotionalUsdc`）。
- signer sign 路径插入限流闸门：已知 key 超额返回 429。

**非目标（YAGNI）**：不做分布式/持久化限流状态（见"关键取舍"，leader-gating 使 in-memory 即全局正确）；不新增 per-key 限流指标（复用切片 1 的 429 HTTP 计数，避免 keyID 高基数）；不限流其它端点（仅 `/v1/sign/l1`）。

## 架构

### 1. `internal/ratelimit`（新包）

```go
// Package ratelimit provides a per-key token-bucket rate limiter for the signing
// boundary. It is fail-closed: misconfiguration or a NaN/Inf parameter denies the
// request. Safe for concurrent use.
package ratelimit

type bucket struct {
	tokens float64 // available tokens (fractional)
	lastMs int64   // last refill timestamp (ms)
}

// Limiter enforces a per-key token-bucket budget. Config (ratePerSec, burst) is
// supplied per call — mirroring policy.SpendTracker.Charge — so the limiter holds
// only bucket state, not policy.
type Limiter struct {
	nowMs   func() int64
	mu      sync.Mutex
	buckets map[string]bucket
}

// New returns a Limiter. If nowMs is nil, it uses the real clock.
func New(nowMs func() int64) *Limiter { ... }

// Allow atomically charges one token against keyID's bucket, refilling by elapsed
// time at ratePerSec (capped at burst). It returns true when a token was consumed.
//
// Config semantics (fail-closed):
//   - ratePerSec == 0: limiting disabled → always true, WITHOUT allocating a bucket.
//   - ratePerSec < 0, or (ratePerSec > 0 and burst <= 0), or NaN/Inf on either:
//     misconfiguration → false (deny), WITHOUT allocating a bucket.
//   - ratePerSec > 0 and burst > 0: active. A first-seen key starts full (tokens =
//     burst). Refill = elapsedMs/1000 * ratePerSec, capped at burst. If tokens >= 1,
//     consume one and return true; else return false (bucket still updated to the
//     refilled value).
func (l *Limiter) Allow(keyID string, ratePerSec, burst float64) bool { ... }
```

令牌桶算法（活跃分支）：
```
now := l.nowMs()
b, ok := l.buckets[keyID]
if !ok {
    b = bucket{tokens: burst, lastMs: now}       // first-seen key starts full
} else {
    elapsed := now - b.lastMs
    if elapsed > 0 {
        b.tokens = min(burst, b.tokens + float64(elapsed)/1000.0*ratePerSec)
    }
    b.lastMs = now
}
if b.tokens >= 1 {
    b.tokens -= 1
    l.buckets[keyID] = b
    return true
}
l.buckets[keyID] = b
return false
```

- **禁用（ratePerSec == 0）不建桶**：直接返回 true，保持 buckets map 只含活跃限流 key。
- **fail-closed 校验**顺序：先查 NaN/Inf（rate 或 burst）→ false；再查 `ratePerSec < 0` → false；再查 `ratePerSec == 0` → true（禁用）；再查 `burst <= 0`（此时 rate>0）→ false；否则活跃。
- `elapsed > 0` 守卫防止时钟回拨导致负 refill（回拨时不加 token，仅更新 lastMs）。

### 2. `internal/policy` Config 新增字段

```go
type Config struct {
	AllowedKinds         map[string]bool
	KillSwitch           bool
	MaxNotionalUsdc      float64
	PerCoinMaxUsdc       map[string]float64
	DailyMaxNotionalUsdc float64
	RatePerSec           float64 // per-key sustained sign rate (tokens/sec); 0 = no rate limit
	RateBurst            float64 // token-bucket capacity (max burst); paired with RatePerSec
}
```

`Evaluate` 纯函数**不读取**这两字段（保持无状态），仅由 signer 装配层按调用传给 `Limiter.Allow`——完全复刻 `DailyMaxNotionalUsdc` 经 `SpendTracker.Charge` 传参的模式。

### 3. `cmd/signer` sign 路径插入闸门

在 `handleSignL1` 中，`ks.Signer(req.KeyID)` 成功之后、`policy.Evaluate` 之前插入（此处已取 `cfg := policies.Get(req.KeyID)`）：

```go
	signer, ok := ks.Signer(req.KeyID)
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown keyId")
		return
	}
	cfg := policies.Get(req.KeyID)
	if !limiter.Allow(req.KeyID, cfg.RatePerSec, cfg.RateBurst) {
		writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")
		return
	}
	intent := intentFor(req.Kind, req.Params)
	if d := policy.Evaluate(intent, cfg); !d.Allow {
		...
```

> 注：现有代码里 `cfg := policies.Get(req.KeyID)` 在 `intent` 之后。本切片将 `cfg` 上移到 `intent` 之前，以便限流闸门使用，`Evaluate` 仍用同一 `cfg`——纯行序调整，无语义变化。

- **位置理由**：仅为已知 key 建桶（未知 key 在上一步已 404，不进限流器 → 防随机 keyID 撑爆 map）；且在 encode/digest 之前，最早负载卸载。
- **装配（最小 churn）**：`handleSignL1(...)` 新增 `limiter *ratelimit.Limiter` 参数；`Limiter` 在 **`newMux` 内部**用其已有的 `nowMs` 构造一次（`limiter := ratelimit.New(nowMs)`）并传入 `handleSignL1`——**`newMux` 的公开签名保持不变**，故所有既有 `newMux` 调用点（含 6 处测试）零改动。一个 server 一个 Limiter，生命周期与 `newMux` 一致。默认 `Config{}` 的 `RatePerSec==0`（禁用），既有 sign 测试不受影响。

## 关键取舍

- **in-memory 单实例即全局正确**：签名是 leader-gated（`handleSignL1` 中非 leader 直接 503），所有**成功签名**只经唯一 leader 实例，故 leader 的本地令牌桶速率 == 全局签名速率。无需分布式限流状态（避免每请求 DB 往返）。leader failover 后新 leader 桶从满开始（短暂 fail-open 可接受；Postgres 中的日 notional 上限仍兜底总敞口）。若请求误达 follower，follower 在限流后仍会 503，其本地桶无实际影响。
- **观测复用切片 1**：限流拒绝返回 **429**，被现有 `hypersolid_http_requests_total{endpoint="sign_l1",code="429"}` 自动记录。**不新增** per-key 限流指标（keyID 作标签是高基数风险）。
- **限流计入"进入处理的请求"**：一个 token 对应一个被接纳处理的请求，包含随后被 policy/fence 拒绝的——这是标准限速语义（限的是请求频率而非成功率），可保护 signer 免受任何形式洪泛（含大量无效请求）。
- **fail-closed 覆盖误配**：负 rate、rate>0 但 burst<=0、NaN/Inf 一律拒绝（429）。429 对永久性误配略有误导，但 fail-closed 优先；运维会因持续 429 排查配置。

## 测试

- **`internal/ratelimit`**（fake clock）：
  - 满桶起始：burst 个请求连续放行，第 burst+1 个拒绝。
  - refill：耗尽后推进时间，按 ratePerSec 恢复相应 token 数后放行。
  - burst 夹取：长时间空闲后 token 不超过 burst。
  - 禁用：ratePerSec==0 恒放行，且 buckets map 不增长（无该 key 条目）。
  - fail-closed：ratePerSec<0、rate>0&burst<=0、NaN/Inf 均返回 false。
  - 时钟回拨：lastMs 之前的 now 不产生负 refill。
  - 并发：`-race` 下多 goroutine `Allow` 无数据竞争。
- **`internal/policy`**：Config 新字段默认 0（禁用）不影响 `Evaluate`（新增一个断言即可；`Evaluate` 不读取新字段）。
- **`cmd/signer`**：
  - 配 `RatePerSec/RateBurst` 的 key：突发到 burst 上限后下一请求得 **429**。
  - `RatePerSec==0` 的 key：连续请求不因限流被拒（走既有 403/200 等路径）。
  - 未知 key：仍 404，且不进限流器（不建桶）。

## 门禁

`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer`；集成编译检查 `go test -c -tags=integration -o /dev/null ./...`。

## 任务拆分

3 个 task（ratelimit 与 policy 字段相互独立；signer 依赖前两者）：
1. `internal/ratelimit`：`Limiter` + `Allow` 令牌桶 + fail-closed + 测试。
2. `internal/policy`：Config 新增 `RatePerSec`/`RateBurst` + 一个"不影响 Evaluate"断言。
3. `cmd/signer`：`handleSignL1` 加 limiter 参数 + 闸门；`newMux` 内部构造 Limiter 注入（公开签名不变）+ 429 测试 + 全量门禁。
