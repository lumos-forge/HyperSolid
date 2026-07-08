# M10-obs · signer HTTP 指标 + /metrics（Prometheus）— 第一片

日期：2026-07-08
状态：已批准，待实现
所属：M10 可观测 / 限频预算（docs/BACKEND-ARCHITECTURE.md）；M5 签名核 + M6 意图账本已落地

## 背景

M5 签名核 + M6 意图账本（PR #28–#47）让 signer 服务成为 agentic 关键路径（sign/reconcile/orphans
+ 后台自动对账）。承接真实负载前需**可观测**：各端点请求量、错误率、延迟。本子项目（M10-obs
第一片）给 signer 加 Prometheus HTTP 指标 + `/metrics` 端点，纯插桩不改行为。

## 目标

- 新 `internal/metrics` 包：专用 registry + HTTP 请求计数 + 延迟直方图 + promhttp `Handler`。
- HTTP 中间件按端点插桩（状态码 + 延迟）。
- signer 的 `/v1/sign/l1`、`/v1/reconcile`、`/v1/orphans`、`/v1/digest/l1` 经中间件；新增 `/metrics` 路由。

## 技术选型

`github.com/prometheus/client_golang`（scrape 式、`/metrics` 文本端点；OTel 目前仅间接依赖、未直接使用，
Prometheus 更轻更直接）。指标注册在**专用 `prometheus.Registry`**（非全局 default），便于测试隔离。

## E’’’1 `internal/metrics`

```go
package metrics

import (
	"net/http"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// reg is a dedicated registry (not the global default) so metrics are isolated
// and the exposition endpoint is self-contained/testable.
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

// ObserveHTTP records one served request: its endpoint label, HTTP status code,
// and duration in seconds.
func ObserveHTTP(endpoint string, code int, seconds float64) {
	httpRequests.WithLabelValues(endpoint, strconv.Itoa(code)).Inc()
	httpDuration.WithLabelValues(endpoint).Observe(seconds)
}

// Handler serves the Prometheus text exposition for the dedicated registry.
func Handler() http.Handler {
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}
```

（`import "strconv"`、`"time"` 视需要。）

HTTP 中间件（同包）：

```go
// statusRecorder captures the status code written by a handler (default 200).
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// Middleware wraps next, recording request count (by status code) and latency
// under the given endpoint label.
func Middleware(endpoint string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		next(rec, r)
		ObserveHTTP(endpoint, rec.code, time.Since(start).Seconds())
	}
}
```

测试（`internal/metrics/*_test.go`）：
- `ObserveHTTP("sign", 200, 0.01)` ×N → `Handler()` 经 httptest 抓取 → body 含
  `hypersolid_http_requests_total{code="200",endpoint="sign"} N` 与 `hypersolid_http_request_duration_seconds_count{endpoint="sign"} N`。
- `Middleware` 包一个写 409 的 handler → 调用后 `Handler` 输出含 `code="409"` 计数（`statusRecorder` 捕获状态码）。
- 未写 WriteHeader 的 handler（默认 200）→ 记为 code 200。

## E’’’2 `cmd/signer` 接线

`newMux` 里把四个 `/v1/*` 路由用中间件包裹并新增 `/metrics`：

```go
	mux.HandleFunc("/healthz", healthz)
	mux.Handle("/metrics", metrics.Handler())
	mux.HandleFunc("/v1/digest/l1", metrics.Middleware("digest", handleDigestL1))
	mux.HandleFunc("/v1/sign/l1", metrics.Middleware("sign", handleSignL1(ks, policies, led, fencer, nowMs)))
	mux.HandleFunc("/v1/reconcile", metrics.Middleware("reconcile", handleReconcile(led)))
	mux.HandleFunc("/v1/orphans", metrics.Middleware("orphans", handleOrphans(led)))
```

- `handleSignL1(...)`/`handleReconcile(led)`/`handleOrphans(led)` 返回 `http.HandlerFunc`，`handleDigestL1`
  是 `http.HandlerFunc`——均可被 `metrics.Middleware(label, fn)` 包裹。
- `/healthz` 保持原样不插桩；`/metrics` 用 `mux.Handle`（非 HandleFunc）挂 `metrics.Handler()`。
- `import` 追加 `internal/metrics`。签名/对账逻辑与响应字节完全不变（中间件仅旁路观测）。

测试（`cmd/signer/main_test.go`）：
- `TestMetricsEndpoint`：`newMux`（in-memory）→ httptest → 打 `/v1/reconcile`（bad json，得 400）几次 →
  GET `/metrics` → 断言 body 含 `hypersolid_http_requests_total{code="400",endpoint="reconcile"}` 且计数 ≥ 打的次数。
- 既有 sign/reconcile/orphans/golden 用例不受影响（中间件透明）。

## 非目标（YAGNI）

- 不做 reconciler 域指标（reap-by-target / step 计数 / leader gauge）——= M10-obs 后续片。
- 不做 traces / 结构化日志 / OTel 导出；不做 SLO 定义；不做限频（= M10-rate）。
- `/metrics` 不鉴权（内部抓取，与现有端点姿态一致）。

## 验收门

- `cd backend && go mod tidy`（把 prometheus/client_golang 从 indirect 提为 direct）
- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./...`
