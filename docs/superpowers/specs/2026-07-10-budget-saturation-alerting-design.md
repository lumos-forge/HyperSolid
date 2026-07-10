# 临界统一降级并告警 —— signer 配额饱和可观测 + 告警

- 日期：2026-07-10
- 里程碑：M10（可观测 / 限频预算）收尾项之一
- 语言：Go（`backend/internal/metrics`、`backend/cmd/signer`）+ Prometheus 规则（`backend/ops/slo`）
- 状态：设计已批准（用户不在场，采纳推荐方案 A），待实现

## 1. 背景与问题

spec §6.3 line 210：「每用户速率预算 + 撤单合并 + 挂单数上限 + scheduleCancel 触发计数；**临界进降级模式并告警**」。其中撤单合并 / 挂单上限 / scheduleCancel 死手已在 agentic 引擎（server/ TS）落地（#51/#52/#53）。剩余 signer 侧的「临界降级并告警」。

signer 当前对配额超限是**硬拒绝**（fail-closed）：
- key 令牌桶超限 → 429「rate limit exceeded」（`backend/cmd/signer/main.go` `handleSignL1`）
- per-(owner,IP) 令牌桶超限 → 429「ip rate limit exceeded」
- 地址日 notional 额度超限 → 403「address daily cap exceeded」

`metrics.Middleware` 已按 HTTP 状态码计数（`hypersolid_http_requests_total{endpoint,code}`），但：
- 429 同时来自 key 速率与 IP 速率两类预算；403 同时来自 policy 拒绝与地址额度两类原因——HTTP code **无法区分是哪个预算在饱和**。
- 没有针对「配额饱和 = 系统进入受限/降级регим」的**告警规则**。

「降级」对一个 **reject-first、无状态**签名器而言：客户端在 429 时按 §4.1 自动回退直连 HL（降级已由客户端承担）；后端的职责是把「预算饱和」这一受限regime**显式暴露并告警**，让运维在硬拒绝主导之前介入（排查异常客户端 / 滥用 / 需调高额度）。

## 2. 范围与非目标

**在范围内**

- 新增 signer 指标 `hypersolid_budget_denials_total{budget}`，按预算维度（key_rate / ip_rate / address_cap）计数配额拒绝。
- 在 `handleSignL1` 三个预算拒绝点埋点（纯 instrumentation，零签名行为变更）。
- Prometheus recording + alert 规则：配额饱和比率 + 多窗口（长+短）告警，复用现有 `ops/slo` promtool CI job。
- promtool 单元测试；README 文档；路线图更新。

**非目标（明确排除）**

- 不引入 in-signer 行为降级 / 负载脱落 / 软阈值改签名行为（方案 B）——与 reject-first 无状态签名器定位相悖、且改动签名关键路径、风险高。
- 不引入响应级降级提示（Retry-After 头等，方案 C）——客户端 429→直连 HL 已覆盖降级路径。
- 不改任何限频/额度的**判定逻辑**或阈值——仅加埋点与告警。
- 不覆盖 policy 拒绝（403 policy 是 reject-first 策略引擎的正常拒绝，非预算饱和），不覆盖 404/405/400。

## 3. Part 1 — signer 配额拒绝指标

### 3.1 指标定义（`backend/internal/metrics/metrics.go`）

```go
var budgetDenials = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_budget_denials_total",
	Help: "signer sign_l1 requests denied by a rate/quota budget, by budget kind.",
}, []string{"budget"})
```

注册进现有专用 registry（`reg.MustRegister(..., budgetDenials)`）。

```go
// Budget denial kinds. A small closed set keeps label cardinality bounded.
const (
	BudgetKeyRate     = "key_rate"      // per-key token bucket (429)
	BudgetIPRate      = "ip_rate"       // per-(owner,IP) token bucket (429)
	BudgetAddressCap  = "address_cap"   // per-owner-address daily notional cap (403)
	BudgetKeyDailyCap = "key_daily_cap" // per-key daily notional cap (403)
)

// ObserveBudgetDenial counts one sign_l1 request denied by the named budget.
func ObserveBudgetDenial(budget string) {
	budgetDenials.WithLabelValues(budget).Inc()
}
```

### 3.2 埋点（`backend/cmd/signer/main.go` `handleSignL1`）

在既有拒绝点，写 429/403 之前各加一次计数（判定逻辑不变）：

- IP 速率拒绝（所有 `writeErr(w, 429, "ip rate limit exceeded")` 路径，含 owner 冲突 / owner 非法 / IPRatePerSec==0 / 令牌桶 Allow 失败）→ `metrics.ObserveBudgetDenial(metrics.BudgetIPRate)`。
- key 速率拒绝（`!keyLimiter.Allow(...)` → 429「rate limit exceeded」）→ `metrics.ObserveBudgetDenial(metrics.BudgetKeyRate)`。
- 地址日额度拒绝（两处预检 `writeErr(w, 403, "address daily cap exceeded")`：`AddressDailyMaxNotionalUsdc != 0 && !ownerOK` 与 `OwnerAddressBudgetConflict`；以及 ledger 授权返回 `ledger.ErrAddressDailyCap` 映射的 403）→ `metrics.ObserveBudgetDenial(metrics.BudgetAddressCap)`。
- 每-key 日额度拒绝（ledger 授权返回 `singlewriter.ErrDailyCap` 映射的 403「daily cap exceeded」）→ `metrics.ObserveBudgetDenial(metrics.BudgetKeyDailyCap)`。

**明确排除**（非预算饱和，不计数）：`policy.Evaluate` 拒绝（403，reject-first 策略正常拒绝）、`singlewriter.ErrInvalidNotional`（403，NaN/负数校验失败）、`singlewriter.ErrFenced`（409，leader/并发）、`ErrCloidReuse`（409）、`ErrMissingCloid`（400）、404/405/400/5xx。

> 埋点粒度：与预算 HTTP 拒绝一一对应（每个预算拒绝点恰好一次计数、随后 return）。为避免遗漏与重复，前置的令牌桶/预检拒绝通过 handler 内小 helper（`denyBudget(w, code, msg, budget)`：先计数、再 `writeErr`，调用方随后 return）收敛；ledger 授权后的 `ErrAddressDailyCap` / `singlewriter.ErrDailyCap` 分支在各自 403 映射处计数。

### 3.3 与现有 HTTP 指标的关系

`hypersolid_http_requests_total{endpoint="sign_l1"}` 仍记录全部请求（含被拒），作为告警分母；`hypersolid_budget_denials_total` 作为分子按预算拆分。两者独立、不重复扣（budget 指标只在预算拒绝分支加，policy/404/400 等不加）。

## 4. Part 2 — 告警规则（`backend/ops/slo`）

复用现有 `ops/slo` 文件与 CI `slo` job（`promtool check rules recording.yml alerts.yml` + `promtool test rules`），新增独立命名的组，与 SLO 规则并存但语义分离（指标名前缀 `budget:`，告警名 `BudgetSaturation*`）。

### 4.1 recording.yml 新增组 `budget_saturation`

`denial_ratio = 被预算拒绝的 sign_l1 速率 / 全部 sign_l1 速率`，落在 [0,1]。四个窗口（与 SLO 对齐，供多窗口告警）：

```yaml
  - name: budget_saturation
    rules:
      - record: budget:denial_ratio:rate5m
        expr: (sum(rate(hypersolid_budget_denials_total[5m])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[5m]))
      - record: budget:denial_ratio:rate30m
        expr: (sum(rate(hypersolid_budget_denials_total[30m])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[30m]))
      - record: budget:denial_ratio:rate1h
        expr: (sum(rate(hypersolid_budget_denials_total[1h])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[1h]))
      - record: budget:denial_ratio:rate6h
        expr: (sum(rate(hypersolid_budget_denials_total[6h])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[6h]))
```

> 分母 `sum(rate(...sign_l1...))` 已含被拒请求（`metrics.Middleware` 记录每个请求，包括 429/403）。分子跨 budget 求和 = 总配额拒绝比。若某窗口无 sign 流量则分母为 0 → 结果 absent（无 series），告警不误触发。

### 4.2 alerts.yml 新增组 `budget_alerts`

多窗口（长窗口为主 + 短窗口确认仍在发生），与 SLO 告警同构；两条 series 无共享标签，用 `and on()` 匹配单一标量：

```yaml
  - name: budget_alerts
    rules:
      - alert: BudgetSaturationCritical
        expr: budget:denial_ratio:rate1h > 0.5 and on() budget:denial_ratio:rate5m > 0.5
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "signer budget saturation critical"
          description: "Over 50% of sign_l1 requests are being denied by rate/quota budgets (1h and 5m both > 50%). The signer is in a heavily throttled regime — investigate abusive/misconfigured clients or raise budgets. Page."
      - alert: BudgetSaturationHigh
        expr: budget:denial_ratio:rate6h > 0.2 and on() budget:denial_ratio:rate30m > 0.2
        for: 2m
        labels:
          severity: ticket
        annotations:
          summary: "signer budget saturation high"
          description: "Over 20% of sign_l1 requests are being denied by rate/quota budgets (6h and 30m both > 20%). Budgets are frequently saturating — open a ticket to investigate."
```

> 阈值取舍：Critical 用 1h+5m 的 50%（严重且持续的受限，多为滥用/严重误配）→ page；High 用 6h+30m 的 20%（预算频繁触顶）→ ticket。`for: 2m` 抑制抖动。多窗口在事件缓解后能快速 clear（短窗口回落即不再满足合取）。

### 4.3 tests 新增用例

- `tests/recording_test.yml`：给定 `hypersolid_budget_denials_total{budget="ip_rate"}` 与 `hypersolid_http_requests_total{endpoint="sign_l1",code=...}` 输入序列，断言 `budget:denial_ratio:rate5m` 等于预期比值（注意 promtool 浮点**精确**比较，必要时用全精度值）。
- `tests/alerts_test.yml`：
  - 健康（全 200，无 denial）→ 无 `BudgetSaturation*`。
  - 20%~50%（如 30 denial + 70 ok /min → ratio 0.3）→ 仅 `BudgetSaturationHigh`（ticket），不触 Critical。
  - >50%（如 60 denial + 40 ok /min → ratio 0.6）→ `BudgetSaturationHigh` + `BudgetSaturationCritical` 同时触发。

## 5. Part 3 — 文档

- `backend/ops/slo/README.md`：新增「Budget saturation（配额饱和）」小节，说明指标 `hypersolid_budget_denials_total{budget}`、`budget:denial_ratio:rate*` 语义、两条告警阈值与处置建议。
- `docs/BACKEND-ARCHITECTURE.md`：M10 行状态与 §6.3/§12 措辞，把「临界统一降级」从待做移入落地，注明指标 + 多窗口告警 + PR 号；`internal/metrics` 模块树注释补充配额拒绝指标。

## 6. 测试与验证

**Go**（`backend/`）：
```bash
cd backend && \
  go test ./internal/metrics/ ./cmd/signer/ && \
  go test -race ./internal/metrics/ ./cmd/signer/ && \
  go vet ./internal/metrics/ ./cmd/signer/ && \
  go build ./...
```

**Prometheus 规则**（本地需 promtool ≥3.13）：
```bash
cd backend/ops/slo && \
  promtool check rules recording.yml alerts.yml && \
  cd tests && promtool test rules recording_test.yml alerts_test.yml
```
CI `slo` job 自动覆盖（文件清单不变）。

**Go 测试点**：
- `metrics` 包：`ObserveBudgetDenial` 三种 budget 计数正确、`/metrics` 暴露 `hypersolid_budget_denials_total{budget="key_rate|ip_rate|address_cap"}` series（用现有 `testutil.ToFloat64` + scrape 断言模式）。
- `cmd/signer`：现有的 429/403 拒绝测试基础上，断言对应 `hypersolid_budget_denials_total{budget=...}` 计数递增（通过 metrics 包的可导出读取 helper 或直接 scrape `/metrics`）。至少覆盖：key 速率 429、IP 速率 429、地址额度 403、每-key 日额度 403 各自打对 budget 标签；policy 403 / 无效 notional 403 / 404 / 400 **不**增 budget 计数。

## 7. 与现有代码的关系

- 指标风格对齐 `internal/metrics`（专用 registry、`hypersolid_` 前缀、`Observe*` 导出函数、closed-set 标签）。
- 告警风格对齐 `backend/ops/slo`（多窗口长+短、`and on(...)`、page/ticket 双档、`for: 2m`、promtool 测试）。
- 埋点位置对齐 `handleSignL1` 既有 `writeErr` 拒绝分支，零判定逻辑改动。

## 8. 未来工作（本次不做）

- 若需按 budget 分别告警（而非合并比率），可加 `budget` 标签维度的 recording/alert（当前合并比率 + 按 budget 拆分的计数指标已足够诊断）。
- Grafana 仪表盘（配额拒绝按 budget 的时间序列）——独立运维工件。
- 若未来引入 in-signer 优先级调度/负载脱落，再评估方案 B。
