# M10-obs 切片 2：reconciler 领域指标设计

日期：2026-07-08
状态：已批准

## 背景

M10-obs 切片 1（PR #48）为 signer 补齐了 HTTP 层 Prometheus 指标（请求量/状态码/延迟）。但自动对账器（`internal/reconciler`）作为后台轮询循环，其领域行为在线上仍不可观测：无法回答「对账循环在跑吗？」「本实例是不是当前 leader？」「每 tick reap 了多少单、各终态多少？」。本切片补齐这三类 reconciler 领域指标。

`internal/reconciler` 目前是纯只读域包（只依赖 `hlinfo` + `ledger`，不依赖 prometheus）。为保持解耦与可测，采用**注入 Observer 接口**方案：reconciler 定义 `Observer` 接口并通过 functional Option 注入（默认 no-op）；`cmd/signer` 写一个适配器把 Observer 回调转调 `internal/metrics` 的包级函数。`reconciler` 与 `metrics` 互不 import，唯一装配点是二进制 `cmd/signer`。

## 目标

在同一专用 registry 上新增 3 个 series，覆盖 reconciler 的三类领域行为：

| 指标 | 类型 | 标签 | 含义 |
| --- | --- | --- | --- |
| `hypersolid_reconcile_steps_total` | Counter | `outcome` | 每次 `step` 完成计一次；outcome ∈ `ok`/`error`/`skipped` |
| `hypersolid_reconcile_reaps_total` | Counter | `target` | reap 通道实际应用的终态推进；target ∈ `canceled`/`rejected`/`filled`/`open` |
| `hypersolid_reconcile_leader` | Gauge | （无） | 1=本实例 reconciler 持有 leadership 并轮询 HL；0=否 |

`outcome` 值定义：
- `skipped`：被 leader gate 拦截（非 leader，本 tick 不查 HL）。
- `error`：`step` 返回基础设施错误（HL 查询或 ledger 基础设施）。
- `ok`：完成一次完整 poll+reconcile 通道（其中被吞掉的良性 per-cloid 拒绝不影响 outcome）。

**非目标（YAGNI）**：不加限流/预算指标；不为「推进通道」（open/filled 的常规 advance）单独计数——本切片只按用户明确要求的 reap-by-target/step/leader 三项。

## 架构

### 1. `internal/metrics`（新增 3 collector + 3 函数）

在现有专用 `reg` 上注册：

```go
var reconcileSteps = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_reconcile_steps_total",
	Help: "auto-reconciler step outcomes.",
}, []string{"outcome"})

var reconcileReaps = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_reconcile_reaps_total",
	Help: "reap-pass ledger transitions applied by target status.",
}, []string{"target"})

var reconcileLeader = prometheus.NewGauge(prometheus.GaugeOpts{
	Name: "hypersolid_reconcile_leader",
	Help: "1 when this instance's auto-reconciler holds leadership and polls HL, else 0.",
})
```

三者随现有 `httpRequests`/`httpDuration` 一并在 `init()` 里 `reg.MustRegister(...)`。

新增包级函数：

```go
// ObserveReconcileStep counts one reconciler step by outcome ("ok"/"error"/"skipped").
func ObserveReconcileStep(outcome string) { reconcileSteps.WithLabelValues(outcome).Inc() }

// ObserveReap counts one reap-pass ledger transition applied, by target status.
func ObserveReap(target string) { reconcileReaps.WithLabelValues(target).Inc() }

// SetReconcileLeader sets the reconciler leadership gauge (1 leader, 0 not).
func SetReconcileLeader(isLeader bool) {
	if isLeader {
		reconcileLeader.Set(1)
	} else {
		reconcileLeader.Set(0)
	}
}
```

普通 Gauge 注册即导出 `hypersolid_reconcile_leader 0`，故 `/metrics` 始终可见该 series（即使内存模式未启动 reconciler）；两个 CounterVec 在首次带标签观测前不导出任何行（标准行为）。

### 2. `internal/reconciler`（Observer 接口 + 注入 + 埋点）

```go
// Observer receives reconciler telemetry. The default (nopObserver) discards all,
// so the reconciler has no hard dependency on any metrics backend.
type Observer interface {
	// ReconcileStep records one completed step by outcome: "ok", "error", or "skipped".
	ReconcileStep(outcome string)
	// Reap records one reap-pass transition actually applied, by target status.
	Reap(target ledger.Status)
	// LeaderState reports whether this instance currently holds reconciler leadership.
	LeaderState(isLeader bool)
}

type nopObserver struct{}

func (nopObserver) ReconcileStep(string)     {}
func (nopObserver) Reap(ledger.Status)       {}
func (nopObserver) LeaderState(bool)         {}
```

- `Reconciler` 结构新增 `obs Observer` 字段；`New` 默认 `obs: nopObserver{}`。
- `WithObserver(obs Observer) Option`：注入非 nil 时替换默认（nil 传入应保持 nopObserver，防止后续 panic）。
- 常量：`outcomeOK = "ok"`、`outcomeError = "error"`、`outcomeSkipped = "skipped"`。

`step` 改造（签名改命名返回 `(err error)` 以便 defer）：

```go
func (r *Reconciler) step(ctx context.Context) (err error) {
	leader := r.isLeader == nil || r.isLeader()
	r.obs.LeaderState(leader)
	if r.isLeader != nil && !leader {
		r.obs.ReconcileStep(outcomeSkipped)
		return nil // not the leader; another instance polls
	}
	defer func() {
		if err != nil {
			r.obs.ReconcileStep(outcomeError)
		} else {
			r.obs.ReconcileStep(outcomeOK)
		}
	}()
	// ... 现有 Orphans/分组/anchor/open+fills advance/reap 通道体 ...
}
```

skipped 早返回发生在 defer 注册之前，故不会与 defer 双计。

`reconcileOne` 改为返回 `(applied bool, err error)`，区分「实际应用」与「良性吞掉」：

```go
func (r *Reconciler) reconcileOne(ctx context.Context, keyID, cloid string, target ledger.Status) (bool, error) {
	if _, err := r.led.Reconcile(ctx, keyID, cloid, target); err != nil {
		if errors.Is(err, ledger.ErrUnknownIntent) || errors.Is(err, ledger.ErrInvalidTransition) {
			return false, nil // benign: not our order / stale-or-idempotent-invalid
		}
		return false, err
	}
	return true, nil
}
```

- 推进通道（open/filled advance）：`if _, err := r.reconcileOne(...); err != nil { return err }`——忽略 applied，不计数。
- reap 通道：`applied, err := r.reconcileOne(...); if err != nil { return err }; if applied { r.obs.Reap(target) }`。

### 3. `cmd/signer`（适配器 + 装配）

```go
// metricsObserver adapts reconciler telemetry onto the metrics package.
type metricsObserver struct{}

func (metricsObserver) ReconcileStep(outcome string)  { metrics.ObserveReconcileStep(outcome) }
func (metricsObserver) Reap(target ledger.Status)     { metrics.ObserveReap(string(target)) }
func (metricsObserver) LeaderState(isLeader bool)     { metrics.SetReconcileLeader(isLeader) }
```

`buildHandler` 里创建 reconciler 处追加 Option：

```go
rec := reconciler.New(client, led, cfg.reconcileAccounts,
	reconciler.WithLeaderGate(isLeader),
	reconciler.WithObserver(metricsObserver{}))
```

## 关键取舍

- **reap 计数含极少见幂等重计**：`applied` 判定为「Reconcile 未返回错误」，包含幂等自转移（如 orderStatus=open 且 ledger 已 open → `open→open` 返回 nil）。终态 reap（canceled/rejected/filled）推进后即离开非终态集，下一 tick 不再出现在 Orphans，天然只计一次；唯一可能重计的是 `target=open` 的幂等边——这属 HL 不一致（orderStatus 报 open 但 OpenCloids 漏报）的罕见自愈场景，对观测计数可接受，不引入 ledger 接口返回 prior-status 的更大改动。
- **leader gauge 语义**：明确为「reconciler 是否在本实例活跃轮询」。内存单实例模式未配置 reconciler 时该 gauge 恒为 0（无 LeaderState 调用），help 文案已界定，不与租约 leadership 混淆。
- **解耦优先**：宁可让 `cmd/signer` 多写一个 3 方法适配器，也不让 `reconciler` 依赖 prometheus 或 `metrics` 反向依赖 `reconciler`。

## 测试

- **`internal/reconciler`**：新增 fake Observer 记录调用，验证——
  - leader step：`LeaderState(true)` + `ReconcileStep("ok")`。
  - 被 gate 拦截的非 leader step：`LeaderState(false)` + `ReconcileStep("skipped")`，且**不查 HL**（fake client 计数为 0）。
  - HL 查询报错的 step：`ReconcileStep("error")`。
  - reap 应用终态：`Reap(<target>)` 且 target 正确；被吞掉的 `ErrInvalidTransition` reap **不**记 `Reap`。
- **`internal/metrics`**：用 `testutil.ToFloat64` 增量断言 `ObserveReconcileStep`/`ObserveReap` 递增正确 series；`SetReconcileLeader(true/false)` → gauge 绝对值 1/0。测试 `-count=2` 幂等。
- **`cmd/signer`**：`/metrics` exposition 含 `hypersolid_reconcile_leader`（Gauge 注册即导出，可断言存在）。

## 门禁

`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer`；集成编译检查 `go test -c -tags=integration -o /dev/null ./...`。

## 任务拆分

3 个 task（metrics 与 reconciler 相互独立；signer 依赖前两者）：
1. `internal/metrics`：3 collector + 3 函数 + 测试。
2. `internal/reconciler`：Observer 接口 + WithObserver + step/reconcileOne 埋点 + 测试。
3. `cmd/signer`：适配器 + 装配 + `/metrics` 断言测试。
