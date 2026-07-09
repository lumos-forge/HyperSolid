# M10-obs-3：reconciler 延迟直方图设计（Go signer）

日期：2026-07-09
状态：已批准

## 背景

M10-obs 已给自动对账器上了三个领域指标：`hypersolid_reconcile_steps_total{outcome}`（#49）、`_reaps_total{target}`、`_leader`（gauge）。但缺**延迟维度**——计数器只说「发生了多少」，无法回答「整轮 step 有多慢/是否在退化」「哪个 HL info 调用是瓶颈」。本切片补两个直方图，复用 `internal/metrics`（专用 registry + `/metrics`）与 reconciler 的 `Observer` 注入模式（reconciler 保持零 prometheus 依赖）。

## 目标

在同一专用 registry 新增 2 个直方图，经 `Observer` 上报：

| 指标 | 类型 | 标签 | 含义 |
| --- | --- | --- | --- |
| `hypersolid_reconcile_step_duration_seconds` | Histogram（DefBuckets）| （无）| 一轮 `step()` 的总耗时（仅已执行的 step，跳过的不计）|
| `hypersolid_reconcile_hl_request_duration_seconds` | HistogramVec（DefBuckets）| `call` | 每次 HL info 往返耗时；call ∈ `open`/`fills`/`status` |

**非目标（YAGNI）**：step-duration 不加 outcome 标签（聚合 cycle 延迟即可）；不做 tracing/span（OTel 追踪另属后续）；不改现有计数器/gauge。

## 架构

### 1. `internal/metrics`（2 直方图 + 2 函数）

在现有 reconciler collector 之后新增：
```go
var reconcileStepDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
	Name:    "hypersolid_reconcile_step_duration_seconds",
	Help:    "auto-reconciler full step latency.",
	Buckets: prometheus.DefBuckets,
})

var reconcileHLDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "hypersolid_reconcile_hl_request_duration_seconds",
	Help:    "auto-reconciler HL info request latency by call.",
	Buckets: prometheus.DefBuckets,
}, []string{"call"})
```
在 `init()` 的 `reg.MustRegister(...)` 追加这两个。新增函数：
```go
// ObserveReconcileStepDuration records one full reconciler step's latency in seconds.
func ObserveReconcileStepDuration(seconds float64) { reconcileStepDuration.Observe(seconds) }

// ObserveReconcileHL records one HL info request's latency by call ("open"/"fills"/"status").
func ObserveReconcileHL(call string, seconds float64) { reconcileHLDuration.WithLabelValues(call).Observe(seconds) }
```
普通 Histogram 在首次 Observe 前不导出行；HistogramVec 首次带标签 Observe 前同理。

### 2. `internal/reconciler`（Observer 扩 2 方法 + step 埋点）

`Observer` 接口追加：
```go
	// StepDuration records one executed step's total latency in seconds.
	StepDuration(seconds float64)
	// HLRequest records one HL info request's latency by call ("open"/"fills"/"status").
	HLRequest(call string, seconds float64)
```
`nopObserver` 追加：
```go
func (nopObserver) StepDuration(float64)     {}
func (nopObserver) HLRequest(string, float64) {}
```

`step` 埋点（不改控制流/语义）：
- **整轮耗时**：函数开头（leader 检查之前）加 `start := time.Now()`；在**已执行路径的 defer**（现记 ok/error 处）追加一行 `r.obs.StepDuration(time.Since(start).Seconds())`。skipped 路径在 defer 注册前 return，故不记 duration（符合「只记真正执行的 step」）。
- **HL 往返**：3 个调用点各包一层计时，**在检查 err 之前 observe**（失败/超时的耗时也要看）：
```go
		tOpen := time.Now()
		open, err := r.client.OpenCloids(ctx, a.Address)
		r.obs.HLRequest("open", time.Since(tOpen).Seconds())
		if err != nil {
			return err
		}
		tFills := time.Now()
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		r.obs.HLRequest("fills", time.Since(tFills).Seconds())
		if err != nil {
			return err
		}
```
reap 循环内的 OrderStatus：
```go
			tStatus := time.Now()
			res, err := r.client.OrderStatus(ctx, a.Address, o.Cloid)
			r.obs.HLRequest("status", time.Since(tStatus).Seconds())
			if err != nil {
				return err
			}
```

### 3. `cmd/signer` `metricsObserver`（2 适配方法）

```go
func (metricsObserver) StepDuration(s float64)           { metrics.ObserveReconcileStepDuration(s) }
func (metricsObserver) HLRequest(call string, s float64) { metrics.ObserveReconcileHL(call, s) }
```
现有 `var _ reconciler.Observer = metricsObserver{}` 编译期强制实现新方法——无需新 cmd/signer 测试（build/vet 即门禁）。

## 关键取舍

- **两个直方图都做**（每 step + HL 往返，用户明确点名），正交且内聚于 reconciler 延迟观测。
- **HL 计时含失败调用**：超时/错误的耗时正是退化信号，故在检查 err 前 observe。
- **reconciler 用真实 `time.Now()`**：无需注入时钟；测试用 fake Observer 断言「记了哪个 label、记了几次」而非精确耗时（避免时间 flaky）。
- **解耦不变**：reconciler 仍零 prometheus 依赖；metrics 不 import reconciler；唯一装配点 `cmd/signer`。

## 测试

- **`internal/metrics`**：`ObserveReconcileStepDuration`/`ObserveReconcileHL` 后 `/metrics` exposition 含 `hypersolid_reconcile_step_duration_seconds_count` 与 `hypersolid_reconcile_hl_request_duration_seconds_count{call="open"}` 等（沿用切片 1 httpDuration 的 exposition 断言法）；`-count=2` 幂等。
- **`internal/reconciler`**（扩展 fake Observer 记录 `stepDurations []float64` 与 `hlCalls []string`）：
  - leader 执行 step：记 `StepDuration` 恰 1 次；`hlCalls` 含 `"open"` 与 `"fills"`。
  - 触发 reap 的 step（某 cloid 不在 open/fills 且 OrderStatus Found）：`hlCalls` 含 `"status"`。
  - 被 gate 拦截的 skipped step：`stepDurations` 为空、`hlCalls` 为空（未查 HL）。
- **`cmd/signer`**：编译期接口检查即覆盖（metricsObserver 必须实现两新方法）；全量 build/vet 通过。

## 门禁

`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer`；集成编译检查 `go test -c -tags=integration -o /dev/null ./...`。

## 任务拆分

3 个 task（metrics 与 reconciler 相互独立；cmd/signer 依赖前两者）：
1. `internal/metrics`：2 直方图 + 2 函数 + 测试。
2. `internal/reconciler`：Observer +StepDuration/HLRequest、nopObserver、step 埋点（defer 记 duration + 3 HL 计时）+ 测试。
3. `cmd/signer`：`metricsObserver` 2 适配方法 + 全量门禁。
