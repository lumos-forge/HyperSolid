# M10-obs signer HTTP 指标 + /metrics 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 signer 加 Prometheus HTTP 指标（每端点请求量/延迟/状态码）+ `/metrics` 端点，纯插桩不改行为。

**Architecture:** 新 `internal/metrics` 包（专用 registry + counter/histogram + `ObserveHTTP` + `Handler` + `Middleware`）；`cmd/signer` 把 `/v1/*` 路由用中间件包裹并挂 `/metrics`。

**Tech Stack:** Go 1.26；`github.com/prometheus/client_golang`（已 `go get`，本计划 `go mod tidy` 提为 direct）；`net/http`。

参考 spec：`docs/superpowers/specs/2026-07-08-m10-obs-http-metrics-design.md`
现状：`cmd/signer/main.go` `newMux`（5 路由：/healthz、/v1/digest/l1=`handleDigestL1`、/v1/sign/l1=`handleSignL1(...)`、/v1/reconcile=`handleReconcile(led)`、/v1/orphans=`handleOrphans(led)`；均为/返回 `http.HandlerFunc`）。prometheus 包已在 go.sum（`go list` 可解析）。

## 文件结构
- `backend/internal/metrics/metrics.go` — NEW：registry + collectors + ObserveHTTP + Handler + Middleware + statusRecorder。
- `backend/internal/metrics/metrics_test.go` — NEW：ObserveHTTP/Middleware/Handler 单测。
- `backend/cmd/signer/main.go` — newMux 中间件包裹 + /metrics 路由 + import。
- `backend/cmd/signer/main_test.go` — /metrics 接线测试。

---

### Task 1: `internal/metrics` 包

**Files:**
- Create: `backend/internal/metrics/metrics.go`
- Test: `backend/internal/metrics/metrics_test.go`

- [ ] **Step 1: 写失败测试 `metrics_test.go`**

```go
package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// scrape returns the /metrics exposition text.
func scrape(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

func TestObserveHTTPCounts(t *testing.T) {
	ObserveHTTP("sign", 200, 0.01)
	ObserveHTTP("sign", 200, 0.02)
	ObserveHTTP("sign", 409, 0.03)
	body := scrape(t)
	if !strings.Contains(body, `hypersolid_http_requests_total{code="200",endpoint="sign"} 2`) {
		t.Fatalf("missing 200x2 count:\n%s", body)
	}
	if !strings.Contains(body, `hypersolid_http_requests_total{code="409",endpoint="sign"} 1`) {
		t.Fatalf("missing 409x1 count:\n%s", body)
	}
	if !strings.Contains(body, `hypersolid_http_request_duration_seconds_count{endpoint="sign"} 3`) {
		t.Fatalf("missing duration count 3:\n%s", body)
	}
}

func TestMiddlewareCapturesStatus(t *testing.T) {
	h := Middleware("reconcile", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/v1/reconcile", nil))
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (middleware must pass through)", rec.Code)
	}
	if !strings.Contains(scrape(t), `hypersolid_http_requests_total{code="400",endpoint="reconcile"} 1`) {
		t.Fatalf("middleware did not record code 400")
	}
}

func TestMiddlewareDefaultStatus200(t *testing.T) {
	h := Middleware("orphans", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`)) // no explicit WriteHeader → 200
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/v1/orphans", nil))
	if !strings.Contains(scrape(t), `hypersolid_http_requests_total{code="200",endpoint="orphans"} 1`) {
		t.Fatalf("default status not recorded as 200")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/metrics/`
Expected: 编译失败（`ObserveHTTP`/`Handler`/`Middleware` 未定义——包尚不存在）。

- [ ] **Step 3: 写 `metrics.go`**

```go
// Package metrics exposes Prometheus instrumentation for the signer service on a
// dedicated registry (isolated from the global default). It provides an HTTP
// middleware recording per-endpoint request counts (by status code) and latency,
// plus a Handler serving the exposition endpoint.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var reg = prometheus.NewRegistry()

var httpRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_http_requests_total",
	Help: "signer HTTP requests by endpoint and status code.",
}, []string{"endpoint", "code"})

var httpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "hypersolid_http_request_duration_seconds",
	Help:    "signer HTTP request latency by endpoint.",
	Buckets: prometheus.DefBuckets,
}, []string{"endpoint"})

func init() {
	reg.MustRegister(httpRequests, httpDuration)
}

// ObserveHTTP records one served request: endpoint label, HTTP status code, and
// duration in seconds.
func ObserveHTTP(endpoint string, code int, seconds float64) {
	httpRequests.WithLabelValues(endpoint, strconv.Itoa(code)).Inc()
	httpDuration.WithLabelValues(endpoint).Observe(seconds)
}

// Handler serves the Prometheus text exposition for the dedicated registry.
func Handler() http.Handler {
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}

// statusRecorder captures the status code written by a handler (defaults to 200
// when the handler never calls WriteHeader).
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// Middleware wraps next, recording request count (by status code) and latency
// under the given endpoint label. It is transparent — it does not alter the
// response.
func Middleware(endpoint string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		next(rec, r)
		ObserveHTTP(endpoint, rec.code, time.Since(start).Seconds())
	}
}
```

- [ ] **Step 4: go mod tidy + 运行确认通过 + vet + race**

Run: `cd backend && go mod tidy && go test ./internal/metrics/ && go vet ./internal/metrics/ && go test -race ./internal/metrics/`
Expected: `go mod tidy` 把 `prometheus/client_golang` 从 indirect 提为 direct（go.mod/go.sum 更新）；测试全 PASS；vet 静默；race 无告警。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/metrics/metrics.go backend/internal/metrics/metrics_test.go backend/go.mod backend/go.sum
git commit --no-verify -m "feat(backend): internal/metrics — Prometheus HTTP middleware + /metrics handler

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `cmd/signer` 接线 middleware + /metrics

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 写失败测试（追加到 `main_test.go` 末尾）**

```go
func TestMetricsEndpoint(t *testing.T) {
	h := newMux(keystore.New(), policy.NewStore(), ledger.NewMem(), constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 })
	srv := httptest.NewServer(h)
	defer srv.Close()
	// drive a few reconcile requests (bad json → 400) through the instrumented route.
	for i := 0; i < 3; i++ {
		res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{bad`))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		res.Body.Close()
	}
	res, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("metrics get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("/metrics status = %d, want 200", res.StatusCode)
	}
	b, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(b), `hypersolid_http_requests_total{code="400",endpoint="reconcile"}`) {
		t.Fatalf("/metrics missing reconcile 400 counter:\n%s", string(b))
	}
}
```

（`main_test.go` 需 import `"io"`——若未 import 则补；`http`/`httptest`/`strings`/`keystore`/`policy`/`ledger` 已在。）

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./cmd/signer/ -run MetricsEndpoint`
Expected: FAIL（`/metrics` 404，或 counter 缺失——尚未接线）。

- [ ] **Step 3: 改 `main.go` — import + newMux 中间件 + /metrics**

在 `main.go` 的 import 块**仅**追加：

```go
	"github.com/lumos-forge/hypersolid/backend/internal/metrics"
```

（`io` 是 Task 2 Step 1 的 **main_test.go** 所需，不是 main.go。）

把 `newMux` 的路由注册段替换为（用中间件包裹 `/v1/*`，新增 `/metrics`；`/healthz` 不变）：

```go
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/metrics", metrics.Handler())
	mux.HandleFunc("/v1/digest/l1", metrics.Middleware("digest", handleDigestL1))
	mux.HandleFunc("/v1/sign/l1", metrics.Middleware("sign", handleSignL1(ks, policies, led, fencer, nowMs)))
	mux.HandleFunc("/v1/reconcile", metrics.Middleware("reconcile", handleReconcile(led)))
	mux.HandleFunc("/v1/orphans", metrics.Middleware("orphans", handleOrphans(led)))
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && go test ./cmd/signer/ -run 'MetricsEndpoint|Sign|Reconcile|Orphans'`
Expected: `TestMetricsEndpoint` + 既有 sign/reconcile/orphans/golden 用例全 PASS（中间件透明，golden 签名字节不变）。

- [ ] **Step 5: 全量门 + 集成编译校验**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer && go test -c -tags=integration -o /dev/null ./...`
Expected: 全 PASS；vet/race 静默；signer 构建成功；集成编译成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): instrument signer HTTP routes + expose /metrics

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- internal/metrics（registry + counter/histogram + ObserveHTTP + Handler + Middleware + statusRecorder）→ Task 1 ✅
- go mod tidy 提 direct 依赖 → Task 1 Step 4 ✅
- cmd/signer 中间件包裹 /v1/* + /metrics 路由 → Task 2 Step 3 ✅
- 测试（ObserveHTTP 计数/中间件状态捕获/默认200；/metrics 端点接线）→ Task 1/2 ✅
- 既有用例不受影响（中间件透明、golden 字节不变）→ Task 2 Step 4 ✅
- 非目标（无 reconciler 域指标/traces/SLO/限频）→ 计划未触及 ✅

**Placeholder scan：** 无 TBD/TODO；代码步骤含完整代码。Task 2 Step 3 对 `io` import 归属（main_test.go 而非 main.go）有明确澄清。

**Type consistency：** `ObserveHTTP(endpoint string, code int, seconds float64)`/`Handler() http.Handler`/`Middleware(endpoint string, next http.HandlerFunc) http.HandlerFunc`/`statusRecorder` 一致；指标名 `hypersolid_http_requests_total{endpoint,code}`/`hypersolid_http_request_duration_seconds{endpoint}` 在 metrics 定义与测试断言一致；`metrics.Handler`/`metrics.Middleware` 与 signer 接线一致；`handleDigestL1`(func) 与 `handleSignL1/Reconcile/Orphans`(返回 HandlerFunc) 均可被 `Middleware` 包裹。
