# Structured Logging + Trace Correlation (Go signer backend) — Design

**Date:** 2026-07-09
**Status:** Approved
**Scope:** Replace the signer backend's stdlib `log` with structured `log/slog`, correlate log records with the active trace, and emit a per-request access log for business routes.

## 1. Goal

Introduce structured logging (`log/slog`) across the `backend/` signer, with automatic
`trace_id`/`span_id` enrichment from the request/step context, and a per-request
structured access log for business routes. Logs correlate to traces purely by the
`trace_id` field (a collector / Loki / backend joins them) — **no OTLP logs pipeline
and zero new dependencies**.

## 2. Motivation

The signer emits traces (#60) and Prometheus metrics but logs through stdlib `log`
(8 unstructured `log.Printf`/`log.Print` sites). Unstructured logs can't be filtered,
leveled, or joined to a trace. This is the natural completion of the M10 observability
arc: structured, leveled JSON logs whose records carry the `trace_id` of the active
span, so a log line can be tied to its trace and vice versa. It also advances the
"签名意图全量留痕供审计" (auditable signing trail) goal by giving each business request
a structured, trace-correlated access log line.

## 3. Design Principles

- **Zero new dependencies.** Use stdlib `log/slog` for the logger and the already-direct,
  stable `go.opentelemetry.io/otel/trace` API to read the span context from `ctx`. The
  pre-stable (v0.x) OTel Logs SDK / OTLP-logs exporter is deliberately NOT adopted.
- **Correlation via context.** Enrichment happens in a `slog.Handler` wrapper that reads
  `trace.SpanContextFromContext(ctx)`; application code just logs with a context-aware
  call (`slog.InfoContext(ctx, …)` / `logger.LogAttrs(ctx, …)`). Reading the span context
  does NOT require the OTel provider to be installed.
- **Core packages stay backend-free.** `internal/reconciler` switches from `log` to
  `log/slog` (still stdlib) and must NOT import `go.opentelemetry.io/otel` — the trace_id
  injection is performed by the handler wired in `cmd/signer`, not by the reconciler.
- **No secrets in logs.** The access log records only method, route, status, and
  duration — never request/response bodies, query strings, keys, or signatures.
- **Standard configuration.** Log level from `LOG_LEVEL` (debug/info/warn/error, default
  info).

## 4. Architecture

### 4.1 `internal/logging` (new package, parallel to `internal/tracing` / `internal/metrics`)

**`logging.go`**

- **`New(w io.Writer, level slog.Level) *slog.Logger`** — builds a `slog.NewJSONHandler(w,
  &slog.HandlerOptions{Level: level})` wrapped by `traceHandler`, returning a
  `slog.New(...)` logger. Pure and testable (writer + level injected).

- **`traceHandler` (internal `slog.Handler` wrapper)** — fields: `inner slog.Handler`.
  Implements:
  - `Enabled(ctx, level) bool` → `inner.Enabled(ctx, level)`.
  - `Handle(ctx, rec slog.Record) error` → if `sc := trace.SpanContextFromContext(ctx)`
    is valid, `rec.AddAttrs(slog.String("trace_id", sc.TraceID().String()),
    slog.String("span_id", sc.SpanID().String()))`; then `return inner.Handle(ctx, rec)`.
    When ctx carries no valid span, no attributes are added (no error).
  - `WithAttrs(attrs) slog.Handler` → `&traceHandler{inner: inner.WithAttrs(attrs)}`.
  - `WithGroup(name) slog.Handler` → `&traceHandler{inner: inner.WithGroup(name)}`.

- **`Setup() *slog.Logger`** — reads `LOG_LEVEL` (via `levelFromEnv`), calls
  `New(os.Stdout, level)`, `slog.SetDefault(logger)`, and returns the logger.

- **`levelFromEnv() slog.Level`** — maps `LOG_LEVEL` (case-insensitive
  debug/info/warn/error) to the `slog.Level`; default `slog.LevelInfo` on empty/unknown.

**`middleware.go`**

- **`Middleware(name string, next http.HandlerFunc) http.HandlerFunc`** — wraps a route:
  captures start time and a `statusRecorder` (defaulting to 200), calls `next`, then emits
  exactly one access log via `slog.Default().LogAttrs(r.Context(), level, "http request",
  slog.String("method", r.Method), slog.String("route", name), slog.Int("status",
  rec.code), slog.Int64("duration_ms", time.Since(start).Milliseconds()))`. `level` is
  `slog.LevelWarn` when `rec.code >= 500`, else `slog.LevelInfo`. `trace_id`/`span_id` are
  injected automatically by the default handler from `r.Context()` (the outer
  `tracing.Middleware` has already placed the server span there). Uses a private
  `statusRecorder` (mirrors the one in `internal/metrics`).

### 4.2 `internal/reconciler` — switch to slog, log step errors with the step span

- Replace the `"log"` import with `"log/slog"`.
- In `step()`, the existing deferred block (which records `StepDuration`/`ReconcileStep`)
  closes over the span-carrying `ctx` and runs before `endSpan()` (LIFO), so the span is
  still active there. Add, in the `if err != nil` branch:
  ```go
  slog.ErrorContext(ctx, "reconcile step failed", "error", err)
  ```
  This carries the step's `trace_id`.
- In `Run()`, remove the `if err := r.step(ctx); err != nil { log.Printf(...) }` logging;
  call `_ = r.step(ctx)` (step now logs its own error; step errors remain transient /
  retried next tick). Keep the surrounding comment about transient errors.
- The reconciler remains OTel-free: it calls `slog.ErrorContext`, and the handler wired in
  `cmd/signer` performs the trace_id injection. (`go list -deps ./internal/reconciler/ |
  grep -c opentelemetry` must stay 0.)

### 4.3 `internal/tracing` — setup warnings via slog

- Replace the two setup-time `log.Printf` calls (exporter-init failure; partial-resource)
  with `slog.Warn(...)` (structured; no ctx → no trace_id, which is correct for
  startup-time warnings). Remove the now-unused `"log"` import; add `"log/slog"`.

### 4.4 `cmd/signer/main.go` — wire logging

- In `run()`, call `logging.Setup()` at the very top (before `tracing.Setup(ctx)`), so
  even tracing's setup warnings flow through the structured logger.
- Replace the `log.*` calls with slog:
  - startup: `slog.Info("signer listening", "addr", cfg.addr, "db", cfg.databaseURL != "")`
  - `buildHandler` error: `slog.Error("build handler", "error", err)`
  - bind error: `slog.Error("listen", "error", err)`
  - serve error: `slog.Error("serve", "error", err)`
  - Remove the `"log"` import; add `"log/slog"`.
- In `newMux`, keep the existing `route` helper (tracing + metrics, no access log) for
  `/healthz`, and add a `loggedRoute` helper for business routes:
  ```go
  loggedRoute := func(name string, h http.HandlerFunc) http.HandlerFunc {
      return tracing.Middleware(name, logging.Middleware(name, metrics.Middleware(name, h)))
  }
  ```
  Wire `digest_l1`, `sign_l1`, `reconcile`, `orphans` via `loggedRoute`; `healthz` stays on
  `route`; `/metrics` unchanged.

## 5. Data Flow (correlated request)

`POST /v1/sign/l1` → `tracing.Middleware` creates server span (trace_id `T`) and puts it in
the request context → `logging.Middleware` runs the inner chain, then logs
`{"level":"INFO","msg":"http request","method":"POST","route":"sign_l1","status":200,
"duration_ms":3,"trace_id":"T","span_id":"S"}` → `metrics.Middleware` records → handler.
The access log's `trace_id` equals the trace's, enabling a join. A reconciler step failure
logs `{"level":"ERROR","msg":"reconcile step failed","error":"…","trace_id":"…",
"span_id":"…"}` with the step span's ids.

## 6. Error Handling / Robustness

- `slog` writing to stdout never fails the business path (a failed stdout write is dropped
  silently by the handler).
- `traceHandler`: a ctx with no valid span adds no attributes and returns no error; slog
  always supplies a non-nil ctx.
- No secrets: the access log carries only method/route/status/duration.
- Level is configurable; default `info` (no debug spam).

## 7. Testing

- **`internal/logging`** (`logging_test.go`, `middleware_test.go`):
  - `traceHandler` via `New(buf, LevelInfo)`: log with a ctx built by
    `trace.ContextWithSpanContext(ctx, trace.NewSpanContext(trace.SpanContextConfig{
    TraceID: <fixed>, SpanID: <fixed>, TraceFlags: trace.FlagsSampled}))` → assert the JSON
    line contains `"trace_id":"<fixed>"` and `"span_id":"<fixed>"`. Logging without a span
    → assert neither key present.
  - `levelFromEnv` / `New` level: a `New(buf, LevelWarn)` logger drops an Info record and
    keeps a Warn record; `levelFromEnv` maps "debug"/"warn"/unknown correctly.
  - `Middleware`: install a capturing default logger (`slog.SetDefault(New(buf,
    LevelInfo))`, restored via cleanup); run a request → assert exactly one line with
    `method`, `route`, `status`, `duration_ms`. A handler writing 500 → assert
    `"level":"WARN"`. A request whose ctx carries a span → assert `trace_id` present.
- **`internal/reconciler`** (extend `reconciler_test.go`):
  - Install a capturing default logger; run a `step` with a fake client returning an error
    and a fake tracer that puts a valid SpanContext into the returned ctx → assert the
    captured output contains `"msg":"reconcile step failed"` and the injected `trace_id`.
  - Confirm the package has no OTel dependency (existing invariant).
- **`cmd/signer`** (extend `main_test.go`):
  - Existing route/tracing tests stay green.
  - With a capturing default logger installed, a request to a business route (e.g.
    `/v1/sign/l1` or `/v1/digest/l1`) emits one `"msg":"http request"` line with the right
    `route`; a request to `/healthz` emits no access log.

## 8. Out of Scope (YAGNI)

- OTLP logs pipeline (`otelslog` bridge + `otlplog` exporter + `sdk/log`) — all pre-stable
  v0.x; deferred until the OTel Logs signal stabilizes.
- Log sampling / rate limiting.
- Request/response body logging.
- Per-endpoint audit fields (keyId/cloid) — a future targeted log inside `handleSignL1`.
- `healthz` / `metrics` access logs (probe noise).

## 9. Dependencies

**None added.** Uses stdlib `log/slog` and the already-direct, stable
`go.opentelemetry.io/otel/trace`.

## 10. Verification Gate

`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... &&
go build ./cmd/signer && rm -f signer` plus `go test -c -tags=integration -o /dev/null
./...`; and `go list -deps ./internal/reconciler/ | grep -c opentelemetry` == 0.
