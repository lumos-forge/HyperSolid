# OpenTelemetry Tracing (Go signer backend) — Design

**Date:** 2026-07-09
**Status:** Approved
**Scope:** Boundary-only distributed tracing for the `backend/` signer service.

## 1. Goal

Add OpenTelemetry (OTel) distributed tracing to the Go signer backend, instrumenting
only the **boundaries** — inbound HTTP requests, outbound Hyperliquid `/info` calls,
and each auto-reconciler step. Pure-logic packages (`hl` digest, `policy`,
single-writer internals) stay uninstrumented. When no OTLP collector is configured,
tracing is a global no-op with zero overhead and never affects business logic.

## 2. Motivation

The backend already exposes Prometheus metrics (`internal/metrics`) for HTTP latency,
reconciler steps, and HL call latency. Metrics answer "how many / how slow in
aggregate" but not "what happened in *this* request / *this* reconcile tick, and where
did the time go across the outbound HL calls". Distributed tracing closes that gap:
a single trace ties an inbound request (or a reconcile step) to its child outbound HL
calls with per-span latency, status, and error attribution. This is the natural
observability capstone after the M10 metrics arc.

## 3. Design Principles

- **Boundary instrumentation only.** Spans live at I/O edges (HTTP server, HL client,
  reconciler step), never inside pure functions.
- **Core packages stay backend-free.** `internal/reconciler` must not import
  `go.opentelemetry.io/otel`. Instrumentation is injected via a tiny local interface —
  consistent with the existing `reconciler.Observer` / `WithObserver` seam.
- **Fail-safe telemetry.** A missing, misconfigured, or unreachable collector must
  never crash the signer, block a request, or hang shutdown. Telemetry degrades to
  no-op; it never degrades the signing service.
- **Standard configuration.** Honor the standard OTel environment variables
  (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
  `OTEL_SDK_DISABLED`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`,
  `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`) so ops wires it the usual way.

## 4. Architecture

### 4.1 `internal/tracing` (new package) — the only OTel-coupled unit besides `cmd/signer`

Owns all OTel SDK wiring and exposes a small surface the entrypoint composes.

**`Setup(ctx context.Context) (shutdown func(context.Context) error, err error)`**
- Determines whether tracing is enabled: enabled iff an OTLP endpoint is configured
  (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` non-empty)
  **and** `OTEL_SDK_DISABLED` is not `"true"`.
- **Disabled path (default):** installs no provider — the global OTel `TracerProvider`
  remains the built-in no-op. Returns a no-op `shutdown` (`func(context.Context) error {
  return nil }`) and `nil` error. Zero overhead, no network, no failure.
- **Enabled path:** builds an `otlptracehttp` exporter, a `sdktrace.NewTracerProvider`
  with:
  - `WithBatcher(exporter)` — async batching so the request path never blocks on export.
  - `WithResource(...)` — a resource merged from `resource.Default()` +
    `resource.FromEnv()` + explicit `service.name = "hypersolid-signer"` (overridable via
    `OTEL_SERVICE_NAME`).
  - `WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(ratio)))` where `ratio`
    comes from `OTEL_TRACES_SAMPLER_ARG` (default `1.0`; a parse failure falls back to
    `1.0`).
  Then `otel.SetTracerProvider(tp)` and
  `otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))`.
  Returns `tp.Shutdown` as the flush hook.
- **Misconfiguration is fail-safe:** if the enabled path errors while building the
  exporter/provider, `Setup` logs a warning and returns a no-op shutdown + `nil` error
  (the signer keeps running with tracing off). A telemetry-setup failure must not abort
  `run()`.

**`Middleware(name string, next http.HandlerFunc) http.HandlerFunc`**
- Wraps a route with `otelhttp.NewHandler(http.HandlerFunc(next), name)`: extracts inbound
  W3C `traceparent` (via the global propagator), starts a server span named `name`,
  records `http.*` attributes, and marks the span an error on 5xx. Transparent to the
  response body. Composable with `metrics.Middleware`.

**`NewStepTracer() reconciler.Tracer`** *(adapter; see 4.2)*
- Implements `StartStep(ctx) (context.Context, func())` as
  `otel.Tracer("hypersolid/reconciler").Start(ctx, "reconcile.step")`, returning the
  span-carrying context plus a `func()` that calls `span.End()`.

**`HLTransport(base http.RoundTripper) http.RoundTripper`**
- Returns `otelhttp.NewTransport(base)`. Wrapping the HL info client's transport makes
  each outbound `/info` POST emit a **client** span nested under the current context span
  (i.e. under the reconciler step span) and injects `traceparent` into the request
  headers. (HL does not honor the header, but the client span still captures URL, status,
  and latency locally.)

### 4.2 `internal/reconciler` — minimal injected seam (stays OTel-free)

Mirror the existing `Observer` pattern:

```go
// Tracer starts a span for one executed reconcile step. The default (nopTracer)
// returns ctx unchanged and a no-op end func, so the reconciler carries no hard
// dependency on any tracing backend.
type Tracer interface {
	// StartStep begins a step span, returning a context carrying the span and a
	// func that ends it. Implementations must never return a nil context or nil func.
	StartStep(ctx context.Context) (context.Context, func())
}

type nopTracer struct{}

func (nopTracer) StartStep(ctx context.Context) (context.Context, func()) {
	return ctx, func() {}
}

// WithTracer injects a step-span tracer. A nil tracer keeps the no-op default.
func WithTracer(t Tracer) Option {
	return func(r *Reconciler) {
		if t != nil {
			r.tracer = t
		}
	}
}
```

- `Reconciler` gains a `tracer Tracer` field, defaulted to `nopTracer{}` in `New`.
- In `step(ctx)`, **after the leader gate passes** (so skipped ticks create no empty
  span), wrap the working body:
  ```go
  ctx, endSpan := r.tracer.StartStep(ctx)
  defer endSpan()
  ```
  and pass this `ctx` to all `r.client.*` calls (already the case). This nests HL client
  spans under the step span.
- The `defer` that records `StepDuration` / `ReconcileStep` (Observer) stays; span and
  metrics are independent. Ordering: the span is started after `StepDuration`'s `start :=
  time.Now()` and the leader gate; `endSpan()` runs inside the same deferred unwinding.

### 4.3 `internal/hlinfo` — unchanged

No edits. The `otelhttp` transport is injected at construction time in `cmd/signer`
(`&http.Client{..., Transport: tracing.HLTransport(http.DefaultTransport)}`). The pure
read-only client package keeps zero telemetry imports.

### 4.4 `cmd/signer/main.go` — wiring

- `run()`: near the top, `shutdown, _ := tracing.Setup(ctx)` (error is already folded to
  no-op inside Setup); arrange for `shutdown` to run on exit with a bounded timeout so an
  unreachable collector can't hang process exit:
  ```go
  defer func() {
  	sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
  	defer cancel()
  	_ = shutdown(sc)
  }()
  ```
- Route wiring in `newMux`: wrap each route tracing-outermost so the server span covers
  the whole request:
  `mux.HandleFunc("/v1/sign/l1", tracing.Middleware("sign_l1", metrics.Middleware("sign_l1", handleSignL1(...))))`
  (same for `healthz`, `digest_l1`, `reconcile`, `orphans`). `/metrics` stays untraced.
- HL info client: `hlinfo.New(cfg.hlInfoURL, &http.Client{Timeout: cfg.hlTimeout, Transport: tracing.HLTransport(http.DefaultTransport)})`.
- Reconciler: add `reconciler.WithTracer(tracing.NewStepTracer())` alongside the existing
  `WithObserver(metricsObserver{})`.

## 5. Data Flow (traced)

- **Inbound:** `POST /v1/sign/l1` → `otelhttp` extracts/creates server span `sign_l1` →
  handler executes within that span's context.
- **Reconciler tick:** ticker fires → `step()` passes leader gate → step span
  `reconcile.step` starts → `OpenCloids` / `FillsByCloidSince` / `OrderStatus` each emit
  an `otelhttp` **client** span (`HTTP POST` to HL `/info`) nested under the step span,
  tagged with URL, status code, and latency. When the collector is enabled, a trace
  backend shows the step fanning out to its HL calls.

## 6. Error Handling / Fail-Safe

- **No collector configured** → global no-op tracer; zero cost; no startup failure.
- **Collector down at runtime** → `BatchSpanProcessor` buffers and drops/retries
  asynchronously; the request/reconcile path never blocks or errors on export.
- **Setup misconfiguration** (bad endpoint, exporter build error) → logged warning +
  degrade to no-op; `run()` continues. Telemetry never takes down the signer.
- **Shutdown** flushes with a 5s bounded timeout so exit isn't hung by an unreachable
  collector.

## 7. Sampling & Resource

- Sampler: `ParentBased(TraceIDRatioBased(ratio))`, `ratio` from `OTEL_TRACES_SAMPLER_ARG`
  (default `1.0`). Since export is opt-in, full sampling by default is safe; ops can dial
  it down.
- Resource: `service.name=hypersolid-signer` plus whatever `OTEL_RESOURCE_ATTRIBUTES` /
  `OTEL_SERVICE_NAME` provide (e.g. `deployment.environment`, `service.version`).

## 8. Testing

- **`internal/tracing`** (new `tracing_test.go`), using `sdktrace` +
  `tracetest.NewInMemoryExporter` wired into a local `TracerProvider` for assertions
  (not the global one):
  - `Middleware` creates a span named after the route for a served request; a handler
    that writes 500 marks the span status `Error`.
  - `NewStepTracer().StartStep(ctx)` starts a `reconcile.step` span, returns a context
    whose `trace.SpanFromContext` is recording, and its end func ends the span (a
    recorder shows exactly one ended span).
  - `Setup` with no endpoint env returns a non-nil no-op `shutdown` and `nil` error, and
    installs no exporter (the global provider records nothing — verified by starting a
    span via `otel.Tracer` and asserting the local recorder captured none / the returned
    shutdown is a no-op). `shutdown(ctx)` is safe to call and returns nil.
  - `Setup` with a syntactically-valid stub endpoint returns a callable `shutdown` and
    `nil` error (provider constructed).
- **`internal/reconciler`** (extend `reconciler_test.go`), using a fake `Tracer`:
  - A fake recording `StartStep` calls + end-func invocations: one executed `step`
    invokes `StartStep` exactly once and calls the returned end func.
  - A leader-gated reconciler whose `isLeader()` is false does **not** call `StartStep`
    (skipped ticks create no span).
  - The `nopTracer` default (no `WithTracer`) does not panic and leaves behavior
    unchanged.
- **No new integration test.** The OTLP-export wire path is covered by the construction
  test; there is no collector in unit CI.

## 9. Out of Scope (YAGNI)

- Trace–log correlation (injecting `trace_id`/`span_id` into the stdlib `log` output).
  The backend uses stdlib `log`; structured logging is a separate effort. Future.
- Spans inside pure packages (`hl` digest, `policy`, single-writer internals). Boundary
  spans first; deepen later if a trace shows an opaque gap.
- gRPC OTLP. HTTP (`otlptracehttp`) is chosen for simplicity and firewall-friendliness.
- Metrics↔trace exemplars.

## 10. Dependencies

Add (all at v1.41.0, matching the existing `go.opentelemetry.io/otel` core):
- `go.opentelemetry.io/otel/sdk`
- `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp`

Promote from indirect → direct:
- `go.opentelemetry.io/otel`
- `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` (v0.60.0)

## 11. Verification Gate

`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer` plus
`go test -c -tags=integration -o /dev/null ./...`. CI runs backend/mobile/server jobs.
