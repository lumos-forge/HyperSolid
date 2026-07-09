# OTel Tracing (Go signer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-safe OpenTelemetry boundary tracing to the Go signer — inbound HTTP server spans, outbound HL `/info` client spans, and per-reconcile-step spans — with zero overhead when no collector is configured.

**Architecture:** A new `internal/tracing` package owns all OTel SDK wiring (Setup/Middleware/StepTracer/HLTransport). `internal/reconciler` gains a tiny injected `Tracer` seam (no OTel import), mirroring its existing `Observer`. `internal/hlinfo` is untouched — its transport is wrapped at construction in `cmd/signer`. When no OTLP endpoint is set, the global no-op tracer is used and nothing is exported.

**Tech Stack:** Go 1.26, `go.opentelemetry.io/otel` (SDK v1.41.0), `otlptracehttp` exporter, `contrib/.../otelhttp` (v0.60.0), `sdk/trace/tracetest` for tests.

**Reference spec:** `docs/superpowers/specs/2026-07-09-otel-tracing-design.md`

**Baseline gate (must stay green after every task):**
`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer`

---

### Task 1: reconciler `Tracer` seam (no OTel import)

Add an injected step-span tracer to the reconciler, defaulting to no-op, and wrap the executed step body. Mirrors the existing `Observer` / `WithObserver` pattern. The reconciler package must NOT import any OTel module.

**Files:**
- Modify: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/reconciler/reconciler_test.go`:

```go
// fakeTracer records StartStep/end-func invocations for assertions.
type fakeTracer struct {
	starts int
	ends   int
}

func (f *fakeTracer) StartStep(ctx context.Context) (context.Context, func()) {
	f.starts++
	return ctx, func() { f.ends++ }
}

func TestStepStartsAndEndsSpan(t *testing.T) {
	led := ledger.NewMem()
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}}
	ft := &fakeTracer{}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}}, WithTracer(ft))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if ft.starts != 1 || ft.ends != 1 {
		t.Fatalf("want 1 start / 1 end, got %d / %d", ft.starts, ft.ends)
	}
}

func TestStepSkippedDoesNotStartSpan(t *testing.T) {
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}}
	ft := &fakeTracer{}
	r := New(fc, ledger.NewMem(), []Account{{KeyID: "k", Address: "0xacc"}},
		WithLeaderGate(func() bool { return false }), WithTracer(ft))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if ft.starts != 0 {
		t.Fatalf("skipped step must not start a span, got %d", ft.starts)
	}
}

func TestNilTracerKeepsNopDefault(t *testing.T) {
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}}
	// WithTracer(nil) must not override the nop default nor panic at step time.
	r := New(fc, ledger.NewMem(), []Account{{KeyID: "k", Address: "0xacc"}}, WithTracer(nil))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/reconciler/ -run 'Span|NopDefault' 2>&1 | head`
Expected: compile failure — `undefined: WithTracer`.

- [ ] **Step 3: Add the Tracer interface, nop default, option, and field**

In `backend/internal/reconciler/reconciler.go`, immediately after the `nopObserver` method block (the lines ending with `func (nopObserver) HLRequest(string, float64) {}`), add:

```go

// Tracer starts a span for one executed reconcile step. The default (nopTracer)
// returns ctx unchanged and a no-op end func, so the reconciler carries no hard
// dependency on any tracing backend.
type Tracer interface {
	// StartStep begins a step span, returning a context carrying the span and a
	// func that ends it. Implementations must never return a nil context or func.
	StartStep(ctx context.Context) (context.Context, func())
}

type nopTracer struct{}

func (nopTracer) StartStep(ctx context.Context) (context.Context, func()) {
	return ctx, func() {}
}
```

Add the field to the `Reconciler` struct (after the `obs Observer` line):

```go
	obs      Observer    // telemetry sink; never nil (defaults to nopObserver)
	tracer   Tracer      // step-span tracer; never nil (defaults to nopTracer)
```

Add the option (place it next to `WithObserver`):

```go
// WithTracer injects a step-span tracer. A nil tracer keeps the no-op default.
func WithTracer(t Tracer) Option {
	return func(r *Reconciler) {
		if t != nil {
			r.tracer = t
		}
	}
}
```

Set the default in `New` — change the `&Reconciler{...}` literal to include `tracer: nopTracer{}`:

```go
	r := &Reconciler{client: client, led: led, accounts: accounts, obs: nopObserver{}, tracer: nopTracer{}}
```

- [ ] **Step 4: Wrap the executed step body with the span**

In `step`, immediately after the leader-skip early return (the block `if r.isLeader != nil && !leader { r.obs.ReconcileStep(outcomeSkipped); return nil }`) and BEFORE the existing `defer func() { r.obs.StepDuration... }()`, insert:

```go
	ctx, endSpan := r.tracer.StartStep(ctx)
	defer endSpan()
```

(The reassigned `ctx` flows into every downstream `r.led.*` / `r.client.*` call, nesting HL client spans under the step span. Defers are LIFO, so `endSpan()` runs after the Observer defer — the span covers the metrics recording too.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/reconciler/ 2>&1 | tail -3`
Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/reconciler`

- [ ] **Step 6: Verify no OTel import leaked in**

Run: `cd backend && go list -deps ./internal/reconciler/ | grep -c opentelemetry`
Expected: `0`

- [ ] **Step 7: Commit**

```bash
cd backend && git add internal/reconciler/reconciler.go internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(reconciler): injected step-span Tracer seam (no OTel dep)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `internal/tracing` — Setup (fail-safe provider) + deps

Add the OTel SDK/exporter dependencies and the `Setup` entrypoint: no-op by default, an OTLP-batched provider when an endpoint is configured, degrading to no-op on any setup error.

**Files:**
- Create: `backend/internal/tracing/tracing.go`
- Create: `backend/internal/tracing/tracing_test.go`
- Modify: `backend/go.mod`, `backend/go.sum` (via `go get`)

- [ ] **Step 1: Add the dependencies**

Run:
```bash
cd backend && \
go get go.opentelemetry.io/otel/sdk@v1.41.0 && \
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.41.0
```
Expected: `go.mod`/`go.sum` updated; command exits 0.

- [ ] **Step 2: Write the failing tests**

Create `backend/internal/tracing/tracing_test.go`:

```go
package tracing

import (
	"context"
	"testing"
	"time"
)

func TestSetupDisabledByDefault(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_SDK_DISABLED", "")
	shutdown, err := Setup(context.Background())
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown must be non-nil")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("noop shutdown: %v", err)
	}
}

func TestSetupDisabledWhenSDKDisabled(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://localhost:4318")
	t.Setenv("OTEL_SDK_DISABLED", "true")
	shutdown, err := Setup(context.Background())
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestSetupEnabledBuildsProvider(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://localhost:4318")
	t.Setenv("OTEL_SDK_DISABLED", "")
	shutdown, err := Setup(context.Background())
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown must be non-nil")
	}
	// Shutdown must return promptly even with an unreachable collector (nothing
	// buffered) and must not error.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestSampleRatio(t *testing.T) {
	cases := map[string]float64{"": 1.0, "0.5": 0.5, "0": 0, "bad": 1.0, "2": 1.0, "-1": 1.0}
	for in, want := range cases {
		t.Setenv("OTEL_TRACES_SAMPLER_ARG", in)
		if got := sampleRatio(); got != want {
			t.Errorf("sampleRatio(%q) = %v, want %v", in, got, want)
		}
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/tracing/ 2>&1 | head`
Expected: build failure — package `tracing` has no `Setup` / `sampleRatio`.

- [ ] **Step 4: Implement `Setup` + helpers**

Create `backend/internal/tracing/tracing.go`:

```go
// Package tracing wires OpenTelemetry distributed tracing for the signer service.
// It is the only backend-coupled telemetry unit besides cmd/signer: core packages
// receive instrumentation through small injected seams and never import OTel.
//
// Tracing is opt-in and fail-safe. With no OTLP endpoint configured, Setup installs
// no provider (the global no-op TracerProvider stays), so tracing costs nothing and
// a missing or unreachable collector never affects the signing service.
package tracing

import (
	"context"
	"log"
	"os"
	"strconv"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// noopShutdown is the shutdown returned when tracing is disabled.
func noopShutdown(context.Context) error { return nil }

// enabled reports whether an OTLP traces endpoint is configured and the SDK is not
// explicitly disabled.
func enabled() bool {
	if strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
		return false
	}
	return os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != "" ||
		os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != ""
}

// sampleRatio reads OTEL_TRACES_SAMPLER_ARG as a [0,1] ratio, defaulting to 1.0 on
// absence, parse failure, or out-of-range value.
func sampleRatio() float64 {
	v := os.Getenv("OTEL_TRACES_SAMPLER_ARG")
	if v == "" {
		return 1.0
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 || f > 1 {
		return 1.0
	}
	return f
}

// Setup installs a global OpenTelemetry tracer + propagator when an OTLP endpoint is
// configured, returning a shutdown that flushes buffered spans. When tracing is not
// configured (or the SDK is disabled), it installs nothing and returns a no-op
// shutdown. A setup failure is logged and degraded to no-op — telemetry never aborts
// the signer.
func Setup(ctx context.Context) (func(context.Context) error, error) {
	if !enabled() {
		return noopShutdown, nil
	}
	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		log.Printf("tracing: exporter init failed, tracing disabled: %v", err)
		return noopShutdown, nil
	}
	// service.name defaults to hypersolid-signer; OTEL_SERVICE_NAME /
	// OTEL_RESOURCE_ATTRIBUTES (via WithFromEnv, applied last) override it.
	res, err := resource.New(ctx,
		resource.WithAttributes(attribute.String("service.name", "hypersolid-signer")),
		resource.WithFromEnv(),
	)
	if err != nil {
		res = resource.Default()
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(sampleRatio()))),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))
	return tp.Shutdown, nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/tracing/ 2>&1 | tail -3`
Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/tracing`

- [ ] **Step 6: Tidy modules**

Run: `cd backend && go mod tidy && go build ./... 2>&1 | tail -3`
Expected: no output / exit 0.

- [ ] **Step 7: Commit**

```bash
cd backend && git add internal/tracing/tracing.go internal/tracing/tracing_test.go go.mod go.sum
git commit --no-verify -m "feat(tracing): fail-safe OTel Setup (no-op default, OTLP when configured)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `internal/tracing` — Middleware, StepTracer, HLTransport

Add the three boundary hooks the entrypoint composes.

**Files:**
- Create: `backend/internal/tracing/hooks.go`
- Create: `backend/internal/tracing/hooks_test.go`

- [ ] **Step 1: Add otelhttp as a direct dependency**

Run: `cd backend && go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.60.0`
Expected: exit 0 (already resolved; promotes indirect → direct).

- [ ] **Step 2: Write the failing tests**

Create `backend/internal/tracing/hooks_test.go`:

```go
package tracing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// installRecorder sets a local recording provider as global for the test and
// restores the previous provider on cleanup.
func installRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() { otel.SetTracerProvider(prev) })
	return sr
}

// hasIntAttr reports whether any attribute carries the given int64 value (robust to
// otelhttp/semconv key-name changes across versions).
func hasIntAttr(attrs []attribute.KeyValue, want int64) bool {
	for _, a := range attrs {
		if a.Value.Type() == attribute.INT64 && a.Value.AsInt64() == want {
			return true
		}
	}
	return false
}

func TestMiddlewareCreatesNamedServerSpan(t *testing.T) {
	sr := installRecorder(t)
	h := Middleware("healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))

	spans := sr.Ended()
	if len(spans) != 1 {
		t.Fatalf("want 1 span, got %d", len(spans))
	}
	if spans[0].Name() != "healthz" {
		t.Fatalf("span name = %q, want healthz", spans[0].Name())
	}
}

func TestMiddlewareRecordsStatusOn5xx(t *testing.T) {
	sr := installRecorder(t)
	h := Middleware("sign_l1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil))

	spans := sr.Ended()
	if len(spans) != 1 {
		t.Fatalf("want 1 span, got %d", len(spans))
	}
	if !hasIntAttr(spans[0].Attributes(), 500) {
		t.Fatalf("expected a status-code=500 attribute, got %v", spans[0].Attributes())
	}
}

func TestStepTracerStartsReconcileStepSpan(t *testing.T) {
	sr := installRecorder(t)
	ctx, end := NewStepTracer().StartStep(context.Background())
	if !trace.SpanFromContext(ctx).SpanContext().IsValid() {
		t.Fatal("returned context should carry a valid span")
	}
	end()

	spans := sr.Ended()
	if len(spans) != 1 || spans[0].Name() != "reconcile.step" {
		t.Fatalf("want 1 reconcile.step span, got %+v", spans)
	}
}

func TestHLTransportWrapsBase(t *testing.T) {
	rt := HLTransport(http.DefaultTransport)
	if _, ok := rt.(*otelhttp.Transport); !ok {
		t.Fatalf("HLTransport should return *otelhttp.Transport, got %T", rt)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/tracing/ -run 'Middleware|StepTracer|HLTransport' 2>&1 | head`
Expected: build failure — `undefined: Middleware`, `NewStepTracer`, `HLTransport`.

- [ ] **Step 4: Implement the hooks**

Create `backend/internal/tracing/hooks.go`:

```go
package tracing

import (
	"context"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
)

// Middleware wraps next in an OpenTelemetry HTTP server span named after the route.
// It extracts an inbound W3C traceparent via the global propagator, records http.*
// attributes (including the response status code), and is transparent to the
// response body. With no configured provider the span is a cheap non-recording no-op.
func Middleware(name string, next http.HandlerFunc) http.HandlerFunc {
	return otelhttp.NewHandler(next, name).ServeHTTP
}

// StepTracer implements the reconciler's Tracer seam, starting a "reconcile.step"
// span per executed step using the global tracer (no-op unless Setup ran).
type StepTracer struct{}

// NewStepTracer returns a StepTracer.
func NewStepTracer() StepTracer { return StepTracer{} }

// StartStep begins a reconcile.step span, returning the span-carrying context and a
// func that ends it.
func (StepTracer) StartStep(ctx context.Context) (context.Context, func()) {
	ctx, span := otel.Tracer("hypersolid/reconciler").Start(ctx, "reconcile.step")
	return ctx, func() { span.End() }
}

// HLTransport wraps base so outbound HTTP calls emit client spans nested under the
// caller's context span and inject W3C traceparent headers. A nil base uses
// http.DefaultTransport.
func HLTransport(base http.RoundTripper) http.RoundTripper {
	return otelhttp.NewTransport(base)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/tracing/ 2>&1 | tail -3`
Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/tracing`

- [ ] **Step 6: Commit**

```bash
cd backend && git add internal/tracing/hooks.go internal/tracing/hooks_test.go go.mod go.sum
git commit --no-verify -m "feat(tracing): HTTP Middleware, reconcile step tracer, HL transport wrapper

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: wire tracing into `cmd/signer`

Compose the tracing hooks at the entrypoint: install the provider in `run()`, wrap every route tracing-outermost, wrap the HL client transport, and inject the step tracer.

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/cmd/signer/main_test.go` (add imports `"go.opentelemetry.io/otel"`, `sdktrace "go.opentelemetry.io/otel/sdk/trace"`, and `"go.opentelemetry.io/otel/sdk/trace/tracetest"` to that file's import block):

```go
func TestNewMuxEmitsServerSpan(t *testing.T) {
	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	defer otel.SetTracerProvider(prev)

	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	_ = resp.Body.Close()

	found := false
	for _, s := range sr.Ended() {
		if s.Name() == "healthz" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a 'healthz' server span from newMux, got %d spans", len(sr.Ended()))
	}
}
```

(If `"net/http"` is not already imported in `main_test.go`, add it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./cmd/signer/ -run TestNewMuxEmitsServerSpan 2>&1 | tail -5`
Expected: FAIL — no `healthz` span (routes not yet wrapped with `tracing.Middleware`).

- [ ] **Step 3: Import the tracing package**

In `backend/cmd/signer/main.go`, add to the import block (alongside the other `internal/...` imports):

```go
	"github.com/lumos-forge/hypersolid/backend/internal/tracing"
```

- [ ] **Step 4: Wrap every route tracing-outermost in `newMux`**

Replace the body of `newMux` (the `mux := http.NewServeMux()` through `return mux`) so each route is wrapped `tracing.Middleware(name, metrics.Middleware(name, h))` via a local helper:

```go
	mux := http.NewServeMux()
	route := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, metrics.Middleware(name, h))
	}
	mux.HandleFunc("/healthz", route("healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	mux.HandleFunc("/v1/digest/l1", route("digest_l1", handleDigestL1))
	limiter := ratelimit.New(nowMs)
	mux.HandleFunc("/v1/sign/l1", route("sign_l1", handleSignL1(ks, policies, led, fencer, nowMs, limiter)))
	mux.HandleFunc("/v1/reconcile", route("reconcile", handleReconcile(led)))
	mux.HandleFunc("/v1/orphans", route("orphans", handleOrphans(led)))
	mux.Handle("/metrics", metrics.Handler())
	return mux
```

- [ ] **Step 5: Wrap the HL client transport + inject the step tracer + assert the interface**

In `buildHandler`, change the `hlinfo.New(...)` client construction to wrap the transport:

```go
		client := hlinfo.New(cfg.hlInfoURL, &http.Client{
			Timeout:   cfg.hlTimeout,
			Transport: tracing.HLTransport(http.DefaultTransport),
		})
```

In the same `reconciler.New(...)` call, add the tracer option:

```go
		rec := reconciler.New(client, led, cfg.reconcileAccounts,
			reconciler.WithLeaderGate(isLeader),
			reconciler.WithObserver(metricsObserver{}),
			reconciler.WithTracer(tracing.NewStepTracer()))
```

Add a compile-time assertion next to the existing `var _ reconciler.Observer = metricsObserver{}` line:

```go
var _ reconciler.Tracer = tracing.StepTracer{}
```

- [ ] **Step 6: Install the provider in `run()` with bounded-timeout shutdown**

In `run()`, immediately after `defer stop()`, insert:

```go
	shutdownTracing, _ := tracing.Setup(ctx)
	defer func() {
		sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTracing(sc)
	}()
```

- [ ] **Step 7: Run the new test + the full signer suite**

Run: `cd backend && go test ./cmd/signer/ 2>&1 | tail -5`
Expected: PASS — `TestNewMuxEmitsServerSpan` passes and all pre-existing route tests stay green.

- [ ] **Step 8: Commit**

```bash
cd backend && git add cmd/signer/main.go cmd/signer/main_test.go
git commit --no-verify -m "feat(signer): wire OTel tracing (routes, HL transport, reconcile step)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: reflect tracing in roadmap docs

Flip the "OTel 追踪 待做" markers now that boundary tracing has landed.

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Update `docs/BACKEND-ARCHITECTURE.md` (M10 row)**

Replace the substring:

```
OTel 追踪/日志·SLO·IP/地址级额度统管·WS 分片配额 待做
```

with:

```
OTel 边界追踪（signer：HTTP server span + HL /info client span + reconciler step span，OTLP 导出、opt-in fail-safe，`internal/tracing`）落地；日志·SLO·IP/地址级额度统管·WS 分片配额 待做
```

- [ ] **Step 2: Update `docs/BACKEND-ARCHITECTURE.md` (可观测 §12 line)**

Replace the substring:

```
OTel 追踪/日志·SLO·sentry-go 待做
```

with:

```
OTel 边界追踪（HTTP/HL/reconciler step span，OTLP，opt-in fail-safe）落地；日志·SLO·sentry-go 待做
```

- [ ] **Step 3: Update `docs/BACKEND-ARCHITECTURE.md` (tree obs/ comment)**

Replace the substring:

```
# OTel 追踪/日志·sentry（待做；当前指标用 metrics/ Prometheus）
```

with:

```
# OTel 日志·sentry（待做；追踪见 internal/tracing，指标用 metrics/ Prometheus）
```

- [ ] **Step 4: Update `README.md` (roadmap row)**

Replace the substring:

```
多 AZ、OTel 追踪/日志·SLO、公开上架 待做
```

with:

```
signer OTel 边界追踪(HTTP/HL/reconciler step，OTLP、opt-in fail-safe)落地；多 AZ、OTel 日志·SLO、公开上架 待做
```

- [ ] **Step 5: Verify the old markers are gone**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid && grep -rn "OTel 追踪/日志" docs/BACKEND-ARCHITECTURE.md README.md`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md README.md
git commit --no-verify -m "docs: mark OTel boundary tracing landed in M10 roadmap

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Final Verification (run before opening the PR)

- [ ] **Full backend gate:**

```bash
cd backend && go test ./... && go vet ./... && \
go test -race ./internal/... ./cmd/... && \
go build ./cmd/signer && rm -f signer && \
go test -c -tags=integration -o /dev/null ./...
```
Expected: all green; binary builds and is removed.

- [ ] **Reconciler stays OTel-free:**

```bash
cd backend && go list -deps ./internal/reconciler/ | grep -c opentelemetry
```
Expected: `0`.
