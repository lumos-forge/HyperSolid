# M10-obs-3 reconciler 延迟直方图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为自动对账器新增两个 Prometheus 延迟直方图（整轮 step 耗时 + 每次 HL info 往返耗时），经 Observer 注入解耦。

**Architecture:** `internal/metrics` 在专用 registry 新增 2 直方图 + 2 函数；`internal/reconciler` 的 `Observer` 加 `StepDuration`/`HLRequest` 两方法并在 `step` 埋点（真实时钟，零 prometheus 依赖）；`cmd/signer` 的 `metricsObserver` 适配器转调 metrics。

**Tech Stack:** Go 1.26、`github.com/prometheus/client_golang`（已直接依赖）、`prometheus/client_golang/prometheus/testutil`（测试）。Module `github.com/lumos-forge/hypersolid/backend`。

---

## File Structure

- `backend/internal/metrics/metrics.go` /（既有）`.test.go` — 2 直方图 + 注册 + 2 函数。
- `backend/internal/reconciler/reconciler.go` /（既有）`.test.go` — Observer +2 方法、nopObserver、step 埋点；测试 recObserver 扩字段 + 新用例。
- `backend/cmd/signer/main.go` — `metricsObserver` +2 适配方法（编译期接口检查强制）。

---

## Task 1: `internal/metrics` — 2 延迟直方图

**Files:**
- Modify: `backend/internal/metrics/metrics.go`
- Test: `backend/internal/metrics/metrics_test.go`

依赖：无。

### 背景（当前 metrics.go）
已有 `reg`、`httpRequests`、`httpDuration`、`reconcileSteps`、`reconcileReaps`、`reconcileLeader`，`init()` 里 `reg.MustRegister(httpRequests, httpDuration, reconcileSteps, reconcileReaps, reconcileLeader)`。测试文件已有 `scrape(t)` helper（返回 /metrics exposition 文本）与 testutil import。

- [ ] **Step 1: 追加失败测试到 `metrics_test.go`**

在文件末尾追加：
```go
func TestObserveReconcileStepDuration(t *testing.T) {
	ObserveReconcileStepDuration(0.02)
	ObserveReconcileStepDuration(0.05)
	if !strings.Contains(scrape(t), "hypersolid_reconcile_step_duration_seconds_count") {
		t.Fatalf("exposition missing reconcile step duration histogram")
	}
}

func TestObserveReconcileHL(t *testing.T) {
	ObserveReconcileHL("open", 0.01)
	ObserveReconcileHL("fills", 0.03)
	ObserveReconcileHL("status", 0.02)
	body := scrape(t)
	for _, call := range []string{"open", "fills", "status"} {
		if !strings.Contains(body, `hypersolid_reconcile_hl_request_duration_seconds_count{call="`+call+`"}`) {
			t.Fatalf("exposition missing hl duration for call=%s:\n%s", call, body)
		}
	}
}
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./internal/metrics/ -run 'ReconcileStepDuration|ReconcileHL'`
Expected: 编译失败（`ObserveReconcileStepDuration`/`ObserveReconcileHL` 未定义）。

- [ ] **Step 3: 在 `metrics.go` 加 2 直方图（放在 `reconcileLeader` 之后、`init()` 之前）**

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

- [ ] **Step 4: 更新 `init()` 注册**

把
```go
	reg.MustRegister(httpRequests, httpDuration, reconcileSteps, reconcileReaps, reconcileLeader)
```
改为
```go
	reg.MustRegister(httpRequests, httpDuration, reconcileSteps, reconcileReaps, reconcileLeader, reconcileStepDuration, reconcileHLDuration)
```

- [ ] **Step 5: 在 `metrics.go` 末尾加 2 函数**

```go
// ObserveReconcileStepDuration records one full reconciler step's latency in seconds.
func ObserveReconcileStepDuration(seconds float64) {
	reconcileStepDuration.Observe(seconds)
}

// ObserveReconcileHL records one HL info request's latency by call ("open"/"fills"/"status").
func ObserveReconcileHL(call string, seconds float64) {
	reconcileHLDuration.WithLabelValues(call).Observe(seconds)
}
```

- [ ] **Step 6: 运行确认 PASS + 幂等 + vet + race**

Run: `cd backend && go test ./internal/metrics/ -count=2 && go vet ./internal/metrics/ && go test -race ./internal/metrics/`
Expected: 全绿（`-count=2` 幂等——exposition 子串断言天然幂等）。

- [ ] **Step 7: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/metrics/metrics.go backend/internal/metrics/metrics_test.go
git commit --no-verify -m "feat(metrics): reconciler step + HL request latency histograms

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `internal/reconciler` — Observer 延迟埋点

**Files:**
- Modify: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

依赖：无（与 Task 1 独立）。

### 背景（当前 reconciler.go）
`Observer` 接口（:25-32）有 `ReconcileStep`/`Reap`/`LeaderState`；`nopObserver`（:34-38）。`step`（:156-）：开头 `leader := ...; r.obs.LeaderState(leader)`；skipped 早返回（:159-162）；已执行路径 defer 记 ok/error（:163-169）；HL 调用点在 :188（OpenCloids）、:192（FillsByCloidSince）、:222（OrderStatus）。测试有 `recObserver{steps,reaps,leader}`（:336-344）。

- [ ] **Step 1: 扩展测试 recObserver + 追加延迟测试到 `reconciler_test.go`**

(a) 把 `recObserver` 结构（:336-340）与方法（:342-344）扩为：
```go
// recObserver records Observer callbacks for assertions.
type recObserver struct {
	steps         []string
	reaps         []ledger.Status
	leader        []bool
	stepDurations []float64
	hlCalls       []string
}

func (o *recObserver) ReconcileStep(outcome string) { o.steps = append(o.steps, outcome) }
func (o *recObserver) Reap(target ledger.Status)    { o.reaps = append(o.reaps, target) }
func (o *recObserver) LeaderState(isLeader bool)    { o.leader = append(o.leader, isLeader) }
func (o *recObserver) StepDuration(seconds float64) { o.stepDurations = append(o.stepDurations, seconds) }
func (o *recObserver) HLRequest(call string, _ float64) { o.hlCalls = append(o.hlCalls, call) }
```
(b) 在文件顶部 import 块加 `"slices"`（若尚未导入）。
(c) 追加 3 个测试到文件末尾：
```go
func TestObserverStepDurationAndHLOnLeaderStep(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}}}
	obs := &recObserver{}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}},
		WithLeaderGate(func() bool { return true }), WithObserver(obs))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(obs.stepDurations) != 1 {
		t.Fatalf("stepDurations = %v, want exactly 1", obs.stepDurations)
	}
	if !slices.Contains(obs.hlCalls, "open") || !slices.Contains(obs.hlCalls, "fills") {
		t.Fatalf("hlCalls = %v, want to contain open+fills", obs.hlCalls)
	}
}

func TestObserverHLStatusOnReap(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{
		open:        map[string]map[string]hlinfo.OpenOrder{"0xacc": {}},
		orderStatus: map[string]hlinfo.OrderStatusResult{"c1": {Status: "rejected", Found: true}},
	}
	obs := &recObserver{}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}}, WithObserver(obs))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if !slices.Contains(obs.hlCalls, "status") {
		t.Fatalf("hlCalls = %v, want to contain status (reap path)", obs.hlCalls)
	}
}

func TestObserverNoLatencyWhenSkipped(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}}}
	obs := &recObserver{}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}},
		WithLeaderGate(func() bool { return false }), WithObserver(obs))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(obs.stepDurations) != 0 || len(obs.hlCalls) != 0 {
		t.Fatalf("skipped step must record no latency: durations=%v hlCalls=%v", obs.stepDurations, obs.hlCalls)
	}
}
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./internal/reconciler/ -run 'StepDuration|HLStatus|NoLatency'`
Expected: 测试可编译但 FAIL —— `recObserver` 有 `StepDuration`/`HLRequest` 方法（Step 1 加）故满足 `Observer`（多出的方法无碍），但 `step` 尚未调用它们，`obs.stepDurations`/`obs.hlCalls` 为空 → 断言 `len==1`/`Contains` 不满足。

- [ ] **Step 3: 扩展 `Observer` 接口 + `nopObserver`（reconciler.go:25-38）**

把接口（:25-32）替换为：
```go
type Observer interface {
	// ReconcileStep records one completed step by outcome: "ok", "error", or "skipped".
	ReconcileStep(outcome string)
	// Reap records one reap-pass transition actually applied, by target status.
	Reap(target ledger.Status)
	// LeaderState reports whether this instance currently holds reconciler leadership.
	LeaderState(isLeader bool)
	// StepDuration records one executed step's total latency in seconds.
	StepDuration(seconds float64)
	// HLRequest records one HL info request's latency by call ("open"/"fills"/"status").
	HLRequest(call string, seconds float64)
}
```
把 `nopObserver` 方法组（:36-38）替换为：
```go
func (nopObserver) ReconcileStep(string)   {}
func (nopObserver) Reap(ledger.Status)     {}
func (nopObserver) LeaderState(bool)       {}
func (nopObserver) StepDuration(float64)   {}
func (nopObserver) HLRequest(string, float64) {}
```

- [ ] **Step 4: 在 `step` 埋点整轮耗时（reconciler.go:156-169）**

把 step 开头 + defer（:156-169）替换为：
```go
func (r *Reconciler) step(ctx context.Context) (err error) {
	start := time.Now()
	leader := r.isLeader == nil || r.isLeader()
	r.obs.LeaderState(leader)
	if r.isLeader != nil && !leader {
		r.obs.ReconcileStep(outcomeSkipped)
		return nil // not the leader; another instance polls
	}
	defer func() {
		r.obs.StepDuration(time.Since(start).Seconds())
		if err != nil {
			r.obs.ReconcileStep(outcomeError)
		} else {
			r.obs.ReconcileStep(outcomeOK)
		}
	}()
```
（`start` 在 leader 检查之前取；skipped 在 defer 注册前 return，故不记 StepDuration。`time` 已在文件导入。）

- [ ] **Step 5: 在 3 个 HL 调用点埋点往返耗时**

(a) OpenCloids（:188-191）——把
```go
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
```
替换为
```go
		tOpen := time.Now()
		open, err := r.client.OpenCloids(ctx, a.Address)
		r.obs.HLRequest("open", time.Since(tOpen).Seconds())
		if err != nil {
			return err
		}
```
(b) FillsByCloidSince（:192-195）——把
```go
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		if err != nil {
			return err
		}
```
替换为
```go
		tFills := time.Now()
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		r.obs.HLRequest("fills", time.Since(tFills).Seconds())
		if err != nil {
			return err
		}
```
(c) OrderStatus（:222-225）——把
```go
			res, err := r.client.OrderStatus(ctx, a.Address, o.Cloid)
			if err != nil {
				return err
			}
```
替换为
```go
			tStatus := time.Now()
			res, err := r.client.OrderStatus(ctx, a.Address, o.Cloid)
			r.obs.HLRequest("status", time.Since(tStatus).Seconds())
			if err != nil {
				return err
			}
```

- [ ] **Step 6: 运行确认 PASS + vet + race**

Run: `cd backend && go test ./internal/reconciler/ -count=1 && go vet ./internal/reconciler/ && go test -race ./internal/reconciler/`
Expected: 新增 3 个延迟测试 + 既有全部 PASS（既有 Observer 测试不受影响——recObserver 新增字段/方法向后兼容）；race 干净。

- [ ] **Step 7: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/reconciler/reconciler.go backend/internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(reconciler): Observer step + HL request latency telemetry

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `cmd/signer` — metricsObserver 适配

**Files:**
- Modify: `backend/cmd/signer/main.go`

依赖：Task 1（metrics 函数）+ Task 2（Observer 新方法）。

### 背景（当前 main.go）
`metricsObserver`（:185-194）实现 `ReconcileStep`/`Reap`/`LeaderState`，并有编译期检查 `var _ reconciler.Observer = metricsObserver{}`（:194）。Task 2 给 `Observer` 加了 2 个方法，故此文件**当前无法编译**，直到补上适配方法。

- [ ] **Step 1: 给 `metricsObserver` 加 2 适配方法（main.go:189-191 之后）**

在
```go
func (metricsObserver) LeaderState(isLeader bool)    { metrics.SetReconcileLeader(isLeader) }
```
之后追加：
```go
func (metricsObserver) StepDuration(s float64)           { metrics.ObserveReconcileStepDuration(s) }
func (metricsObserver) HLRequest(call string, s float64) { metrics.ObserveReconcileHL(call, s) }
```

- [ ] **Step 2: 全量后端门禁**

Run:
```bash
cd backend
go test ./...
go vet ./...
go test -race ./internal/... ./cmd/...
go build ./cmd/signer && rm -f signer
go test -c -tags=integration -o /dev/null ./...
```
Expected: 全部 PASS/编译通过（编译期 `var _ reconciler.Observer = metricsObserver{}` 现已满足）。

- [ ] **Step 3: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go
git commit --no-verify -m "feat(backend): wire reconciler latency telemetry to metrics observer (M10-obs)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer
go test -c -tags=integration -o /dev/null ./...
```

既有测试基线保持绿；新增覆盖：metrics 两直方图 exposition + 幂等；reconciler step-duration（执行记一次、skipped 不记）+ HL open/fills/status 计时；cmd/signer 编译期接口一致。
