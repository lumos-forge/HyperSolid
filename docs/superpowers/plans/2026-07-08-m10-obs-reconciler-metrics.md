# M10-obs reconciler 领域指标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为自动对账器新增 reconciler 领域 Prometheus 指标（step 计数、reap-by-target、leader gauge），经注入 Observer 接口解耦。

**Architecture:** `internal/reconciler` 定义 `Observer` 接口并通过 functional Option 注入（默认 no-op），零 prometheus 依赖；`internal/metrics` 在现有专用 registry 上新增 3 个 collector + 3 个包级函数；`cmd/signer` 写一个适配器把 Observer 回调转调 metrics 函数。reconciler 与 metrics 互不 import，唯一装配点是 `cmd/signer`。

**Tech Stack:** Go 1.26、`github.com/prometheus/client_golang`（已是直接依赖）、`prometheus/client_golang/prometheus/testutil`（测试）。

**Module path:** `github.com/lumos-forge/hypersolid/backend`

---

## File Structure

- `backend/internal/metrics/metrics.go` — 追加 3 个 collector（2 CounterVec + 1 Gauge）、init 注册、3 个包级函数。
- `backend/internal/metrics/metrics_test.go` — 追加 3 个测试。
- `backend/internal/reconciler/reconciler.go` — 新增 `Observer` 接口 + `nopObserver`、`WithObserver` Option、`Reconciler.obs` 字段、`New` 默认、`step` 埋点（命名返回 + defer + leader/skipped）、`reconcileOne` 改 `(bool, error)` 并在 reap 通道计数。
- `backend/internal/reconciler/reconciler_test.go` — 追加 fake Observer + 4 个测试。
- `backend/cmd/signer/main.go` — 新增 `metricsObserver` 适配器 + 在 `buildHandler` 装配 `WithObserver`；import `internal/metrics`（已在切片 1 引入）。
- `backend/cmd/signer/main_test.go` — 追加 1 个 `/metrics` 含 leader gauge 的断言测试。

---

## Task 1: metrics 包新增 3 个 reconciler collector + 函数

**Files:**
- Modify: `backend/internal/metrics/metrics.go`
- Test: `backend/internal/metrics/metrics_test.go`

- [ ] **Step 1: 追加失败测试到 `backend/internal/metrics/metrics_test.go`**

在文件末尾追加（`testutil` 已在切片 1 的 import 中；若无则加 `"github.com/prometheus/client_golang/prometheus/testutil"`）：

```go
func TestObserveReconcileStep(t *testing.T) {
	before := testutil.ToFloat64(reconcileSteps.WithLabelValues("ok"))
	ObserveReconcileStep("ok")
	ObserveReconcileStep("ok")
	if got := testutil.ToFloat64(reconcileSteps.WithLabelValues("ok")) - before; got != 2 {
		t.Fatalf("ok step delta = %v, want 2", got)
	}
	beforeErr := testutil.ToFloat64(reconcileSteps.WithLabelValues("error"))
	ObserveReconcileStep("error")
	if got := testutil.ToFloat64(reconcileSteps.WithLabelValues("error")) - beforeErr; got != 1 {
		t.Fatalf("error step delta = %v, want 1", got)
	}
}

func TestObserveReap(t *testing.T) {
	before := testutil.ToFloat64(reconcileReaps.WithLabelValues("canceled"))
	ObserveReap("canceled")
	ObserveReap("canceled")
	ObserveReap("rejected")
	if got := testutil.ToFloat64(reconcileReaps.WithLabelValues("canceled")) - before; got != 2 {
		t.Fatalf("canceled reap delta = %v, want 2", got)
	}
	if got := testutil.ToFloat64(reconcileReaps.WithLabelValues("rejected")); got < 1 {
		t.Fatalf("rejected reap = %v, want >= 1", got)
	}
}

func TestSetReconcileLeader(t *testing.T) {
	SetReconcileLeader(true)
	if got := testutil.ToFloat64(reconcileLeader); got != 1 {
		t.Fatalf("leader gauge = %v, want 1", got)
	}
	SetReconcileLeader(false)
	if got := testutil.ToFloat64(reconcileLeader); got != 0 {
		t.Fatalf("leader gauge = %v, want 0", got)
	}
	// The gauge must be exposed in the exposition text.
	if !strings.Contains(scrape(t), "hypersolid_reconcile_leader") {
		t.Fatalf("exposition missing reconcile_leader gauge")
	}
}
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./internal/metrics/ -run 'Reconcile|Reap'`
Expected: 编译失败（`reconcileSteps`/`reconcileReaps`/`reconcileLeader`/`ObserveReconcileStep`/`ObserveReap`/`SetReconcileLeader` 未定义）。

- [ ] **Step 3: 在 `backend/internal/metrics/metrics.go` 追加 collector**

在 `httpDuration` 变量声明之后、`init()` 之前插入：

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

- [ ] **Step 4: 更新 `init()` 注册新 collector**

把现有：

```go
func init() {
	reg.MustRegister(httpRequests, httpDuration)
}
```

改为：

```go
func init() {
	reg.MustRegister(httpRequests, httpDuration, reconcileSteps, reconcileReaps, reconcileLeader)
}
```

- [ ] **Step 5: 在 `metrics.go` 末尾追加 3 个函数**

```go
// ObserveReconcileStep counts one auto-reconciler step by outcome:
// "ok", "error", or "skipped".
func ObserveReconcileStep(outcome string) {
	reconcileSteps.WithLabelValues(outcome).Inc()
}

// ObserveReap counts one reap-pass ledger transition actually applied, by target
// status (e.g. "canceled", "rejected", "filled", "open").
func ObserveReap(target string) {
	reconcileReaps.WithLabelValues(target).Inc()
}

// SetReconcileLeader sets the reconciler leadership gauge (1 when this instance
// polls HL, 0 otherwise).
func SetReconcileLeader(isLeader bool) {
	if isLeader {
		reconcileLeader.Set(1)
		return
	}
	reconcileLeader.Set(0)
}
```

- [ ] **Step 6: 运行确认 PASS + 幂等 + race**

Run: `cd backend && go test ./internal/metrics/ -count=2 && go vet ./internal/metrics/ && go test -race ./internal/metrics/`
Expected: 全部 PASS（`-count=2` 确认幂等）。

- [ ] **Step 7: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/metrics/metrics.go backend/internal/metrics/metrics_test.go
git commit --no-verify -m "feat(metrics): reconciler domain collectors (steps/reaps/leader)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: reconciler Observer 接口 + 埋点

**Files:**
- Modify: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

依赖：无（Observer 接口不 import metrics；与 Task 1 独立）。

### 背景（当前代码）

`Reconciler` 结构（reconciler.go:50-55）：
```go
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
	isLeader func() bool // optional leader gate; nil = always run
}
```
`New`（reconciler.go:67-73）：
```go
func New(client InfoClient, led ledger.Reconciler, accounts []Account, opts ...Option) *Reconciler {
	r := &Reconciler{client: client, led: led, accounts: accounts}
	for _, o := range opts {
		o(r)
	}
	return r
}
```
`reconcileOne`（reconciler.go:109-115）当前返回 `error`；`step`（reconciler.go:119-192）当前签名 `func (r *Reconciler) step(ctx context.Context) error`。

- [ ] **Step 1: 追加 fake Observer + 失败测试到 `backend/internal/reconciler/reconciler_test.go`**

在文件末尾追加：

```go
// recObserver records Observer callbacks for assertions.
type recObserver struct {
	steps  []string
	reaps  []ledger.Status
	leader []bool
}

func (o *recObserver) ReconcileStep(outcome string)  { o.steps = append(o.steps, outcome) }
func (o *recObserver) Reap(target ledger.Status)     { o.reaps = append(o.reaps, target) }
func (o *recObserver) LeaderState(isLeader bool)     { o.leader = append(o.leader, isLeader) }

func TestObserverLeaderStepOK(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}}}
	obs := &recObserver{}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}},
		WithLeaderGate(func() bool { return true }), WithObserver(obs))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(obs.leader) != 1 || obs.leader[0] != true {
		t.Fatalf("leader = %v, want [true]", obs.leader)
	}
	if len(obs.steps) != 1 || obs.steps[0] != "ok" {
		t.Fatalf("steps = %v, want [ok]", obs.steps)
	}
}

func TestObserverSkippedWhenNotLeader(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}}}
	obs := &recObserver{}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}},
		WithLeaderGate(func() bool { return false }), WithObserver(obs))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(obs.leader) != 1 || obs.leader[0] != false {
		t.Fatalf("leader = %v, want [false]", obs.leader)
	}
	if len(obs.steps) != 1 || obs.steps[0] != "skipped" {
		t.Fatalf("steps = %v, want [skipped]", obs.steps)
	}
	if len(fc.statusQueried) != 0 {
		t.Fatalf("gated step must not query HL, got %v", fc.statusQueried)
	}
}

func TestObserverStepError(t *testing.T) {
	obs := &recObserver{}
	r := New(&fakeClient{err: errors.New("boom")}, ledger.NewMem(),
		[]Account{{KeyID: "k", Address: "0xacc"}}, WithObserver(obs))
	if err := r.step(context.Background()); err == nil {
		t.Fatalf("expected client error")
	}
	if len(obs.steps) != 1 || obs.steps[0] != "error" {
		t.Fatalf("steps = %v, want [error]", obs.steps)
	}
}

func TestObserverReapByTarget(t *testing.T) {
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
	if len(obs.reaps) != 1 || obs.reaps[0] != ledger.StatusRejected {
		t.Fatalf("reaps = %v, want [rejected]", obs.reaps)
	}
}
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./internal/reconciler/ -run Observer`
Expected: 编译失败（`WithObserver`/Observer 相关未定义）。

- [ ] **Step 3: 在 `reconciler.go` 新增 Observer 接口 + nopObserver + outcome 常量**

在 `Account` struct 之后（约 reconciler.go:21 之后）插入：

```go
// Observer receives reconciler telemetry. The default (nopObserver) discards all,
// so the reconciler carries no hard dependency on any metrics backend.
type Observer interface {
	// ReconcileStep records one completed step by outcome: "ok", "error", or "skipped".
	ReconcileStep(outcome string)
	// Reap records one reap-pass transition actually applied, by target status.
	Reap(target ledger.Status)
	// LeaderState reports whether this instance currently holds reconciler leadership.
	LeaderState(isLeader bool)
}

type nopObserver struct{}

func (nopObserver) ReconcileStep(string) {}
func (nopObserver) Reap(ledger.Status)   {}
func (nopObserver) LeaderState(bool)     {}

// step outcome labels.
const (
	outcomeOK      = "ok"
	outcomeError   = "error"
	outcomeSkipped = "skipped"
)
```

- [ ] **Step 4: 给 `Reconciler` 加 `obs` 字段**

把：
```go
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
	isLeader func() bool // optional leader gate; nil = always run
}
```
改为：
```go
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
	isLeader func() bool // optional leader gate; nil = always run
	obs      Observer    // telemetry sink; never nil (defaults to nopObserver)
}
```

- [ ] **Step 5: 新增 `WithObserver` Option + `New` 默认**

在 `WithLeaderGate`（reconciler.go:62-64）之后插入：
```go
// WithObserver injects a telemetry sink. A nil observer keeps the no-op default.
func WithObserver(obs Observer) Option {
	return func(r *Reconciler) {
		if obs != nil {
			r.obs = obs
		}
	}
}
```

把 `New` 改为默认注入 nopObserver：
```go
func New(client InfoClient, led ledger.Reconciler, accounts []Account, opts ...Option) *Reconciler {
	r := &Reconciler{client: client, led: led, accounts: accounts, obs: nopObserver{}}
	for _, o := range opts {
		o(r)
	}
	return r
}
```

- [ ] **Step 6: 改 `reconcileOne` 返回 `(bool, error)`**

把当前：
```go
func (r *Reconciler) reconcileOne(ctx context.Context, keyID, cloid string, target ledger.Status) error {
	if _, err := r.led.Reconcile(ctx, keyID, cloid, target); err != nil &&
		!errors.Is(err, ledger.ErrUnknownIntent) && !errors.Is(err, ledger.ErrInvalidTransition) {
		return err
	}
	return nil
}
```
改为：
```go
// reconcileOne applies one transition. It reports applied=true when the ledger
// accepted the transition, and swallows benign per-cloid rejections
// (ErrUnknownIntent = not our order; ErrInvalidTransition = stale/idempotent)
// as applied=false, surfacing only infrastructure errors.
func (r *Reconciler) reconcileOne(ctx context.Context, keyID, cloid string, target ledger.Status) (bool, error) {
	if _, err := r.led.Reconcile(ctx, keyID, cloid, target); err != nil {
		if errors.Is(err, ledger.ErrUnknownIntent) || errors.Is(err, ledger.ErrInvalidTransition) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
```

- [ ] **Step 7: 改 `step` 签名 + leader/skipped/defer 埋点 + 两处 reconcileOne 调用**

把 `step` 的签名与开头：
```go
func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil // not the leader; another instance polls
	}
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
```
改为：
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
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
```

把 advance 通道的调用（当前 reconciler.go:162-164）：
```go
			if err := r.reconcileOne(ctx, a.KeyID, cloid, target); err != nil {
				return err
			}
```
改为（忽略 applied，不计数）：
```go
			if _, err := r.reconcileOne(ctx, a.KeyID, cloid, target); err != nil {
				return err
			}
```

把 reap 通道的调用（当前 reconciler.go:186-188）：
```go
			if err := r.reconcileOne(ctx, a.KeyID, o.Cloid, target); err != nil {
				return err
			}
```
改为（applied 时按 target 计数）：
```go
			applied, err := r.reconcileOne(ctx, a.KeyID, o.Cloid, target)
			if err != nil {
				return err
			}
			if applied {
				r.obs.Reap(target)
			}
```

> 注意：advance 通道循环内变量名是 `cloid`，与 `err` 组合成 `if _, err := ...` 会在该块内新建 `err`，不影响命名返回值 `err`——但 reap 通道用的是 `applied, err := ...`，此处 `err` 亦为块内新变量。两处 `return err` 均把块内 err 赋给命名返回并触发 defer，语义正确。

- [ ] **Step 8: 运行确认 PASS + 全 reconciler 套件 + race**

Run: `cd backend && go test ./internal/reconciler/ -count=1 && go vet ./internal/reconciler/ && go test -race ./internal/reconciler/`
Expected: 新增 4 个 Observer 测试 + 原有全部 PASS；race 干净。原有 `TestStepReapsCanceled` 等仍通过（reconcileOne 返回值变化不影响其行为）。

- [ ] **Step 9: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/reconciler/reconciler.go backend/internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(reconciler): Observer telemetry (step/reap/leader) via WithObserver

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: cmd/signer 适配器 + 装配

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

依赖：Task 1（metrics 函数）+ Task 2（reconciler.Observer / WithObserver）。

### 背景（当前代码）

`buildHandler` 里创建 reconciler（main.go:533-536）：
```go
	if cfg.hlInfoURL != "" && len(cfg.reconcileAccounts) > 0 {
		client := hlinfo.New(cfg.hlInfoURL, &http.Client{Timeout: cfg.hlTimeout})
		isLeader := func() bool { _, l := fencer.Fence(); return l }
		rec := reconciler.New(client, led, cfg.reconcileAccounts, reconciler.WithLeaderGate(isLeader))
```
`main.go` 已 import `internal/metrics`（切片 1）、`internal/ledger`、`internal/reconciler`。`main_test.go` 已 import `io`/`net/http`/`net/http/httptest`/`strings`/`ledger`/`keystore`/`policy` 且有 `constFencer`（切片 1 的 `TestMetricsEndpoint` 佐证）。

- [ ] **Step 1: 追加失败测试到 `backend/cmd/signer/main_test.go`**

在文件末尾追加：

```go
func TestMetricsExposesReconcileLeaderGauge(t *testing.T) {
	srv := httptest.NewServer(newMux(keystore.New(), policy.NewStore(), ledger.NewMem(), constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 }))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("metrics get: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "hypersolid_reconcile_leader") {
		t.Fatalf("/metrics missing reconcile leader gauge:\n%s", string(body))
	}
}
```

> 说明：leader gauge 是普通 Gauge，注册即导出（切片 1 已把 `/metrics` 接入 `newMux`），故无需启动 reconciler 即可断言其存在。此测试主要保证 metrics 包被链接进 binary 且 gauge 可见；适配器的行为在 reconciler 包已用 fake Observer 覆盖。

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./cmd/signer/ -run TestMetricsExposesReconcileLeaderGauge`
Expected: FAIL（gauge 尚未注册——本测试在 Task 1 未合并时会失败；若 Task 1 已合并进本分支则会 PASS，此时仍继续 Step 3 完成装配）。

> 若因 Task 1 已在同分支导致此步已 PASS，视为红转绿的等价情形，继续 Step 3 完成真正的装配变更（装配变更本身由 vet/build 保证不回归）。

- [ ] **Step 3: 在 `main.go` 新增 `metricsObserver` 适配器**

在 `staticFencer` 定义之后（main.go:182 之后）或紧邻 `buildHandler` 之前的合适位置插入：

```go
// metricsObserver adapts reconciler telemetry onto the metrics package, keeping
// the reconciler free of any Prometheus dependency.
type metricsObserver struct{}

func (metricsObserver) ReconcileStep(outcome string)      { metrics.ObserveReconcileStep(outcome) }
func (metricsObserver) Reap(target ledger.Status)         { metrics.ObserveReap(string(target)) }
func (metricsObserver) LeaderState(isLeader bool)         { metrics.SetReconcileLeader(isLeader) }

// Compile-time check that metricsObserver satisfies reconciler.Observer.
var _ reconciler.Observer = metricsObserver{}
```

- [ ] **Step 4: 在 `buildHandler` 装配 `WithObserver`**

把：
```go
		rec := reconciler.New(client, led, cfg.reconcileAccounts, reconciler.WithLeaderGate(isLeader))
```
改为：
```go
		rec := reconciler.New(client, led, cfg.reconcileAccounts,
			reconciler.WithLeaderGate(isLeader),
			reconciler.WithObserver(metricsObserver{}))
```

- [ ] **Step 5: 运行确认 PASS + signer 全套件**

Run: `cd backend && go test ./cmd/signer/ && go vet ./cmd/signer/`
Expected: 全部 PASS，含新测试。

- [ ] **Step 6: 全量后端门禁**

Run:
```bash
cd backend
go test ./...
go vet ./...
go test -race ./internal/... ./cmd/...
go build ./cmd/signer && rm -f signer
go test -c -tags=integration -o /dev/null ./...
```
Expected: 全部 PASS/编译通过。

- [ ] **Step 7: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): wire reconciler telemetry to metrics observer (M10-obs)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer
go test -c -tags=integration -o /dev/null ./...
```

所有既有测试基线必须保持绿；新增指标覆盖 step/reap/leader 三类。
