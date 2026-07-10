# sentry-go 崩溃/panic 上报 —— `internal/obs`

- 日期：2026-07-10
- 里程碑：M10（可观测 / 限频预算）收尾项之一
- 语言：Go（`backend/internal/obs`）
- 状态：设计已批准，待实现

## 1. 背景与目的

架构文档（§12 / BACKEND-ARCHITECTURE.md line 126）规划 `internal/obs` 承载 Sentry 崩溃上报，目前尚未落地（「obs/ # sentry（待做…）」）。spec §12 line 262 明确「Sentry 崩溃」。本设计交付 signer 的崩溃/panic 上报：进程逃逸 panic 与 per-request handler panic 都被捕获、留痕到 Sentry，并保证签名服务在 Sentry 缺失/不可达时零影响。

与既有观测单元（`internal/tracing`、`internal/logging`）保持同构：**opt-in、fail-safe、env 驱动**，核心包不感知 obs，仅 `cmd/signer` 接线。

## 2. 范围与非目标

**在范围内**

- `obs.Setup()`：opt-in 初始化 sentry-go（`SENTRY_DSN` 门控），返回 flush 供退出前刷盘。
- `obs.Middleware(name, next)`：HTTP panic 恢复中间件，上报后写 500 JSON，不 re-panic。
- `obs.Recover()`：main 层 `defer` 兜底，捕获逃逸 panic、上报、flush 后 re-panic 保留原崩溃行为。
- 零敏感泄漏：`SendDefaultPII=false` + `BeforeSend` 剔除 `event.Request`；事件只含路由名、trace_id、panic 值、堆栈。
- trace 关联：panic 事件打 `trace_id` tag（取自 OTel span context），对齐仓库既有 trace_id/span_id 关联惯例。

**非目标（明确排除）**

- 不转发 error 级别日志到 Sentry（error 已由 `internal/logging` slog JSON + trace 关联覆盖）。
- 不启用 sentry 自带 tracing/performance（`TracesSampleRate=0`；分布式追踪归 OTel）。
- 不提供业务侧手动 `CaptureException` 公开 API（YAGNI；需要时后续再加）。
- 不上报任何请求体/请求头/query（签名服务安全硬约束）。

## 3. 依赖

新增：`github.com/getsentry/sentry-go`（官方 Go SDK，生产级）。加入 `backend/go.mod`。

## 4. API 表面

```go
// Package obs wires Sentry crash/panic reporting for the signer service. Like
// internal/tracing, it is opt-in and fail-safe: with no SENTRY_DSN configured,
// Setup installs nothing and every hook is a no-op, so a missing or unreachable
// Sentry never affects signing. It reports crashes only (panics); error-level
// problems are covered by internal/logging.
package obs

import (
	"net/http"
	"time"
)

// Setup initializes the global Sentry hub when SENTRY_DSN is set, returning a
// flush function to call before exit (drains buffered events, bounded by the
// given timeout). With no DSN, or on an init failure, it logs a warning and
// returns a no-op flush plus a nil error — telemetry never aborts the signer.
//
// Reads SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_RELEASE. Sets SendDefaultPII=false
// and TracesSampleRate=0 (tracing is OTel's job). Installs a BeforeSend hook that
// strips event.Request so no request body/headers/query can leak.
func Setup() (flush func(time.Duration), err error)

// Middleware is a hand-written panic-recovery HTTP middleware (matching the shape
// of tracing.Middleware / logging.Middleware). It defers a recover(); on a panic
// it reports the value to Sentry — tagged with the route name and the request's
// OTel trace_id — then writes a 500 JSON response and returns WITHOUT re-panicking,
// so the API behaves consistently with other 500 paths. When Sentry is disabled it
// still recovers and writes the 500 (a panicking handler must never leak an empty
// or partial response), it simply reports nothing.
func Middleware(name string, next http.HandlerFunc) http.HandlerFunc

// Recover is for a deferred call in main: it recovers a panic that escaped to the
// top of the process, reports it to Sentry, flushes, and then re-panics so the
// original crash behavior (stack print, non-zero exit) is preserved. With Sentry
// disabled it is a thin pass-through that still re-panics. It is a no-op when there
// is no panic in flight.
func Recover()
```

## 5. 行为细节

### 5.1 opt-in 门控（对齐 tracing）

```go
func enabled() bool { return os.Getenv("SENTRY_DSN") != "" }
```

`Setup` 首行 `if !enabled() { return noopFlush, nil }`，其中 `noopFlush := func(time.Duration) {}`。参照 `internal/tracing/tracing.go` 的 `enabled()` / `noopShutdown`。

### 5.2 sentry.Init 选项

```go
err := sentry.Init(sentry.ClientOptions{
	Dsn:              os.Getenv("SENTRY_DSN"),
	Environment:      os.Getenv("SENTRY_ENVIRONMENT"),
	Release:          os.Getenv("SENTRY_RELEASE"),
	SendDefaultPII:   false,
	TracesSampleRate: 0,
	BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
		event.Request = nil // never leak request body/headers/query from a signing service
		return event
	},
})
```

init 失败 → `slog.Warn("sentry init failed, crash reporting disabled", "error", err)` 并返回 `noopFlush, nil`（fail-safe，永不致命）。成功 → 返回 `sentry.Flush`。

### 5.3 panic 中间件

```go
func Middleware(name string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				reportPanic(r.Context(), name, rec)
				writeErr(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next(w, r)
	}
}
```

`reportPanic` 直接执行（无需 `enabled()` 守卫）——当 Sentry 未初始化时 `sentry.CurrentHub().Recover` 因无 client 而安全 no-op（`Hub.Recover` 在 `client==nil` 时返回 nil）：

```go
sentry.WithScope(func(scope *sentry.Scope) {
	scope.SetTag("route", name)
	if sc := trace.SpanContextFromContext(ctx); sc.HasTraceID() {
		scope.SetTag("trace_id", sc.TraceID().String())
	}
	sentry.CurrentHub().Recover(rec) // captures the panic value + stack; no-op when uninitialized
})
```

> 为何不在 `reportPanic` 里守 `enabled()`：sentry-go 未 Init 时全局 hub 无 client，`WithScope`/`Recover` 均为安全 no-op；不加守卫可让中间件在测试中通过注入 mock transport 的 `sentry.Init` 直接被验证，无需依赖 `SENTRY_DSN` 环境变量。`enabled()` 只用于 `Setup` 决定是否 Init。

- 复用 signer 既有 `writeErr` 的 JSON 风格（`{"error":"internal error"}` + 500）。obs 包内定义等价的私有 `writeErr`（obs 不依赖 cmd/signer；见 §6）。
- 不 re-panic：net/http 收不到 panic，响应为受控 500。

### 5.4 main 层 Recover

```go
func Recover() {
	if rec := recover(); rec != nil {
		sentry.CurrentHub().Recover(rec)   // no-op when uninitialized
		sentry.Flush(2 * time.Second)      // no-op/immediate when uninitialized
		panic(rec)                         // preserve original crash semantics
	}
}
```

### 5.5 接线（cmd/signer/main.go）

- 在 `run()` 内、紧邻 `logging.Setup()` / `tracing.Setup(ctx)` 处：

```go
flushSentry, _ := obs.Setup()
defer flushSentry(2 * time.Second)
```

- 中间件放到链**最外层**，兜住内层所有 panic。`newMux` 的两个包装器：

```go
route := func(name string, h http.HandlerFunc) http.HandlerFunc {
	return obs.Middleware(name, tracing.Middleware(name, metrics.Middleware(name, h)))
}
loggedRoute := func(name string, h http.HandlerFunc) http.HandlerFunc {
	return obs.Middleware(name, tracing.Middleware(name, logging.Middleware(name, metrics.Middleware(name, h))))
}
```

- （可选，进程逃逸兜底）`run()` 顶部不放 `defer obs.Recover()`，因为 net/http 已按请求恢复 panic；`Recover()` 的价值在于**非 HTTP goroutine**（如 reconciler 循环）的兜底。M10 阶段 reconciler 已有自身错误处理，故本次仅**提供** `Recover()` API + 测试，接线到 reconciler 循环留待其需要时；不在 `main` 强制 `defer obs.Recover()`（HTTP 路径由中间件覆盖，main 直接 panic 本就会崩溃留栈）。

> 设计取舍：`Recover()` 作为可复用兜底 API 交付并测试，但本 PR 不在 main 顶层强插，避免与 net/http 既有恢复语义重叠、也不改变现有退出码路径。中间件覆盖全部 HTTP handler panic，已满足「崩溃留痕」的核心目标。

## 6. 包边界

- `obs` 不 import `cmd/signer`（避免环）。500 响应用 obs 内私有 `writeErr(w, code, msg)`，与 signer 的 `writeErr` 输出格式一致（`Content-Type: application/json` + `{"error":"..."}`）。
- `obs` import：`net/http`、`os`、`time`、`log/slog`、`github.com/getsentry/sentry-go`、`go.opentelemetry.io/otel/trace`。
- 对齐 `internal/tracing` 对 OTel 的依赖方式（tracing 已 import `go.opentelemetry.io/otel/trace` 家族）。

## 7. 测试计划（TDD，`obs_test.go`）

1. **DSN 空 → 全 no-op**：`Setup()` 返回可调用 flush（不 panic）、`enabled()`=false；`Middleware` 正常透传非 panic 请求。
2. **panic 中间件写 500 且不 re-panic**（DSN 空亦然）：handler `panic("boom")` → 响应 500 + `{"error":"internal error"}`，测试不 panic 逃逸。
3. **panic 被上报且 scrub 生效**：用 `sentry.Init` 注入 mock `Transport`（记录 `SendEvent` 收到的 `*sentry.Event`）→ 触发 panic → 断言捕获到 1 个事件、`event.Request == nil`、tags 含 `route` 与 `trace_id`（用带 span context 的请求）、`event.Exception` 非空。
4. **BeforeSend 独立单测**：构造带 `Request` 的 event，过 `BeforeSend` 后 `Request == nil`。
5. **Recover 无 panic → no-op**；**有 panic → 捕获后 re-panic**：`func(){ defer obs.Recover(); panic("x") }()` 用外层 `recover()` 断言 re-panic 值为 "x"。
6. **并发中间件无竞态**：多 goroutine 并发打 panic 请求，`go test -race` 无竞态、每个响应都是 500。

> Mock transport：`sentry.ClientOptions{Transport: mock}` 会被 sentry-go 直接采用（`setupTransport` 对非 nil 自定义 Transport 一律保留，即便 DSN 为空也不回退 noopTransport，故测试无需真实 DSN/网络）。mock 需实现 sentry-go `Transport` 接口的 4 个方法：`Configure(ClientOptions)`、`SendEvent(*Event)`、`Flush(time.Duration) bool`、`FlushWithContext(context.Context) bool`；`SendEvent` 记录收到的 `*sentry.Event` 供断言。注意：因测试会用自定义 Transport 调 `sentry.Init` 装配全局 hub，测试需在 `t.Cleanup` 中 `sentry.Init(sentry.ClientOptions{})` 复位，避免污染后续测试的全局 hub。

## 8. 验证命令

```bash
cd backend && \
  go test ./internal/obs/ ./cmd/signer/ && \
  go test -race ./internal/obs/ ./cmd/signer/ && \
  go vet ./internal/obs/ ./cmd/signer/ && \
  go build ./...
```

## 9. 与现有代码的关系

- 形态对齐 `internal/tracing`（opt-in `enabled()`、fail-safe 降级 no-op、env 驱动、Setup 返回收尾函数）。
- 中间件对齐 `internal/{tracing,logging,metrics}.Middleware(name, next)` 签名，插入链最外层。
- trace_id 取用对齐 `internal/logging` 的 `trace.SpanContextFromContext`。
- go.mod 依赖新增，参照现有 OTel 依赖块。

## 10. 未来工作（本次不做）

- 把 `obs.Recover()` 接到 reconciler / 后台 goroutine 循环兜底（当这些循环需要崩溃留痕时）。
- error 级别事件转发（若运营需要在 Sentry 聚合 error）。
- sentry-go 与 OTel 的 span link（sentry performance，当前 `TracesSampleRate=0` 关闭）。
