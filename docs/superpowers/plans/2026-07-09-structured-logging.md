# Structured Logging + Trace Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the signer backend's stdlib `log` with structured `log/slog`, auto-enrich records with `trace_id`/`span_id` from the active span context, and emit a per-request access log for business routes — with zero new dependencies.

**Architecture:** A new `internal/logging` package provides `New`/`Setup` (a JSON slog logger wrapped by a trace-correlating `slog.Handler`) and an access-log `Middleware`. `internal/reconciler` and `internal/tracing` switch from `log` to `slog`; `cmd/signer` installs the default logger and wraps business routes with the access-log middleware. Correlation is by the `trace_id` field, read via the stable `otel/trace` API — no OTLP logs pipeline.

**Tech Stack:** Go 1.26, stdlib `log/slog`, `go.opentelemetry.io/otel/trace` (already direct, stable v1.41.0).

**Reference spec:** `docs/superpowers/specs/2026-07-09-structured-logging-design.md`

**Baseline gate (must stay green after every task):**
`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer`

---

### Task 1: `internal/logging` — trace-correlating slog logger

Create the logging package foundation: a JSON slog logger wrapped by a handler that injects `trace_id`/`span_id` from the record context, plus level-from-env config and default installation.

**Files:**
- Create: `backend/internal/logging/logging.go`
- Test: `backend/internal/logging/logging_test.go`

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/logging/logging_test.go`:

```go
package logging

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/trace"
)

// ctxWithSpan returns a context carrying a valid (fabricated) span context.
func ctxWithSpan(tid, sid string) context.Context {
	traceID, _ := trace.TraceIDFromHex(tid)
	spanID, _ := trace.SpanIDFromHex(sid)
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	return trace.ContextWithSpanContext(context.Background(), sc)
}

func TestNewInjectsTraceIDs(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf, slog.LevelInfo)
	ctx := ctxWithSpan("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331")
	logger.InfoContext(ctx, "hello")
	out := buf.String()
	if !strings.Contains(out, `"trace_id":"0af7651916cd43dd8448eb211c80319c"`) {
		t.Fatalf("missing trace_id in %q", out)
	}
	if !strings.Contains(out, `"span_id":"b7ad6b7169203331"`) {
		t.Fatalf("missing span_id in %q", out)
	}
}

func TestNewNoSpanNoTraceID(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf, slog.LevelInfo)
	logger.Info("hello") // background ctx, no span
	if strings.Contains(buf.String(), "trace_id") {
		t.Fatalf("unexpected trace_id in %q", buf.String())
	}
}

func TestNewRespectsLevel(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf, slog.LevelWarn)
	logger.Info("dropped")
	logger.Warn("kept")
	out := buf.String()
	if strings.Contains(out, "dropped") {
		t.Fatalf("info should be dropped at warn level: %q", out)
	}
	if !strings.Contains(out, "kept") {
		t.Fatalf("warn should be kept: %q", out)
	}
}

func TestLevelFromEnv(t *testing.T) {
	cases := map[string]slog.Level{
		"":        slog.LevelInfo,
		"debug":   slog.LevelDebug,
		"DEBUG":   slog.LevelDebug,
		"warn":    slog.LevelWarn,
		"warning": slog.LevelWarn,
		"error":   slog.LevelError,
		"bogus":   slog.LevelInfo,
	}
	for in, want := range cases {
		t.Setenv("LOG_LEVEL", in)
		if got := levelFromEnv(); got != want {
			t.Errorf("levelFromEnv(%q) = %v, want %v", in, got, want)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/logging/ 2>&1 | head`
Expected: build failure — package `logging` does not exist / `undefined: New`.

- [ ] **Step 3: Implement the package**

Create `backend/internal/logging/logging.go`:

```go
// Package logging provides structured (slog) logging for the signer service with
// automatic trace correlation: a handler wrapper enriches every record that carries
// an active span context with trace_id/span_id, so logs join to traces by field. It
// adds no dependencies beyond the standard library and the stable otel/trace API, and
// does not require the OTel provider to be installed.
package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"

	"go.opentelemetry.io/otel/trace"
)

// traceHandler wraps a slog.Handler, adding trace_id/span_id attributes drawn from the
// record's context when it carries a valid span. It reads only the stable otel/trace
// SpanContext API and never depends on the OTel provider.
type traceHandler struct {
	inner slog.Handler
}

func (h traceHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h traceHandler) Handle(ctx context.Context, rec slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		rec.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return h.inner.Handle(ctx, rec)
}

func (h traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return traceHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h traceHandler) WithGroup(name string) slog.Handler {
	return traceHandler{inner: h.inner.WithGroup(name)}
}

// New returns a JSON slog.Logger writing to w at the given minimum level, with trace
// correlation applied to every record.
func New(w io.Writer, level slog.Level) *slog.Logger {
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})
	return slog.New(traceHandler{inner: base})
}

// levelFromEnv maps LOG_LEVEL (case-insensitive debug/info/warn/error) to a slog.Level,
// defaulting to Info on empty or unknown values.
func levelFromEnv() slog.Level {
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Setup builds the process logger from LOG_LEVEL, installs it as the slog default, and
// returns it.
func Setup() *slog.Logger {
	logger := New(os.Stdout, levelFromEnv())
	slog.SetDefault(logger)
	return logger
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/logging/ 2>&1 | tail -3`
Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/logging`

- [ ] **Step 5: gofmt + commit**

```bash
cd backend && gofmt -w internal/logging/logging.go internal/logging/logging_test.go
git add internal/logging/logging.go internal/logging/logging_test.go
git commit --no-verify -m "feat(logging): trace-correlating slog logger (New/Setup)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `internal/logging` — access-log Middleware

Add a middleware that emits exactly one structured access-log line per request (method, route, status, duration_ms), Warn on 5xx, always running (even on panic).

**Files:**
- Create: `backend/internal/logging/middleware.go`
- Test: `backend/internal/logging/middleware_test.go`

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/logging/middleware_test.go`:

```go
package logging

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// installDefault swaps the slog default for a buffer-backed logger, restored on cleanup.
func installDefault(t *testing.T, w *bytes.Buffer) {
	t.Helper()
	prev := slog.Default()
	slog.SetDefault(New(w, slog.LevelInfo))
	t.Cleanup(func() { slog.SetDefault(prev) })
}

func TestMiddlewareLogsAccessLine(t *testing.T) {
	var buf bytes.Buffer
	installDefault(t, &buf)
	h := Middleware("sign_l1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil))
	out := buf.String()
	for _, want := range []string{
		`"msg":"http request"`, `"method":"POST"`, `"route":"sign_l1"`,
		`"status":200`, `"duration_ms":`, `"level":"INFO"`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("access log missing %s in %q", want, out)
		}
	}
}

func TestMiddlewareWarnsOn5xx(t *testing.T) {
	var buf bytes.Buffer
	installDefault(t, &buf)
	h := Middleware("reconcile", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/reconcile", nil))
	out := buf.String()
	if !strings.Contains(out, `"level":"WARN"`) || !strings.Contains(out, `"status":500`) {
		t.Fatalf("expected WARN + status 500, got %q", out)
	}
}

func TestMiddlewareInjectsTraceIDWithSpan(t *testing.T) {
	var buf bytes.Buffer
	installDefault(t, &buf)
	h := Middleware("digest_l1", func(w http.ResponseWriter, _ *http.Request) {})
	req := httptest.NewRequest(http.MethodPost, "/v1/digest/l1", nil)
	ctx := ctxWithSpan("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331") // helper in logging_test.go
	h(httptest.NewRecorder(), req.WithContext(ctx))
	if !strings.Contains(buf.String(), `"trace_id":"0af7651916cd43dd8448eb211c80319c"`) {
		t.Fatalf("access log missing trace_id: %q", buf.String())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/logging/ -run TestMiddleware 2>&1 | head`
Expected: build failure — `undefined: Middleware`.

- [ ] **Step 3: Implement the middleware**

Create `backend/internal/logging/middleware.go`:

```go
package logging

import (
	"log/slog"
	"net/http"
	"time"
)

// statusRecorder captures the status code written by a handler (defaults to 200 when
// the handler never calls WriteHeader).
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// Middleware wraps next, emitting exactly one structured access-log record per request
// via the default logger: method, route (=name), status, and duration_ms. It logs at
// Warn for 5xx responses and Info otherwise. trace_id/span_id are injected by the
// default handler from the request context (the outer tracing middleware has already
// placed the server span there). It records no request/response body. If next panics,
// the request is logged with status 500 and the panic is re-raised.
func Middleware(name string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		defer func() {
			p := recover()
			if p != nil {
				rec.code = http.StatusInternalServerError
			}
			level := slog.LevelInfo
			if rec.code >= 500 {
				level = slog.LevelWarn
			}
			slog.Default().LogAttrs(r.Context(), level, "http request",
				slog.String("method", r.Method),
				slog.String("route", name),
				slog.Int("status", rec.code),
				slog.Int64("duration_ms", time.Since(start).Milliseconds()),
			)
			if p != nil {
				panic(p)
			}
		}()
		next(rec, r)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/logging/ 2>&1 | tail -3`
Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/logging`

- [ ] **Step 5: gofmt + commit**

```bash
cd backend && gofmt -w internal/logging/middleware.go internal/logging/middleware_test.go
git add internal/logging/middleware.go internal/logging/middleware_test.go
git commit --no-verify -m "feat(logging): per-request access-log middleware (Warn on 5xx)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `internal/reconciler` — slog step-error log with trace_id

Switch the reconciler from `log` to `log/slog`, and log step errors from within the step span so they carry the step's `trace_id`.

**Files:**
- Modify: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/reconciler/reconciler_test.go`. Add these imports to that file's import block if not already present: `"bytes"`, `"log/slog"`, `"strings"`, `"github.com/lumos-forge/hypersolid/backend/internal/logging"`, `"go.opentelemetry.io/otel/trace"`.

```go
// spanTracer is a fake reconciler.Tracer that injects a fixed valid span context.
type spanTracer struct{ tid, sid string }

func (s spanTracer) StartStep(ctx context.Context) (context.Context, func()) {
	traceID, _ := trace.TraceIDFromHex(s.tid)
	spanID, _ := trace.SpanIDFromHex(s.sid)
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	return trace.ContextWithSpanContext(ctx, sc), func() {}
}

func TestStepLogsErrorWithTraceID(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(logging.New(&buf, slog.LevelInfo))
	defer slog.SetDefault(prev)

	boom := errors.New("boom")
	tr := spanTracer{tid: "0af7651916cd43dd8448eb211c80319c", sid: "b7ad6b7169203331"}
	r := New(&fakeClient{err: boom}, ledger.NewMem(),
		[]Account{{KeyID: "k", Address: "0xacc"}}, WithTracer(tr))
	if err := r.step(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("want boom, got %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `"msg":"reconcile step failed"`) {
		t.Fatalf("missing error log: %q", out)
	}
	if !strings.Contains(out, `"trace_id":"0af7651916cd43dd8448eb211c80319c"`) {
		t.Fatalf("missing trace_id: %q", out)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/reconciler/ -run TestStepLogsErrorWithTraceID 2>&1 | tail -8`
Expected: FAIL — no `"reconcile step failed"` log line (step doesn't log yet).

- [ ] **Step 3: Switch the reconciler to slog and log the step error in-span**

In `backend/internal/reconciler/reconciler.go`:

Change the import `"log"` to `"log/slog"`.

In `step`, update the existing deferred observer block to also log the error (the block currently reads as shown; add the `slog.ErrorContext` line):

```go
	defer func() {
		r.obs.StepDuration(time.Since(start).Seconds())
		if err != nil {
			r.obs.ReconcileStep(outcomeError)
			slog.ErrorContext(ctx, "reconcile step failed", "error", err)
		} else {
			r.obs.ReconcileStep(outcomeOK)
		}
	}()
```

In `Run`, replace the `log.Printf` logging of step errors:

```go
		case <-t.C:
			_ = r.step(ctx) // errors are transient (logged in step, retried next tick)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./internal/reconciler/ 2>&1 | tail -3`
Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/reconciler`

- [ ] **Step 5: Verify the reconciler stays OTel-free (production deps)**

Run: `cd backend && go list -deps ./internal/reconciler/ | grep -c opentelemetry`
Expected: `0` (the otel/trace import is test-only, not a production dependency).

- [ ] **Step 6: gofmt + commit**

```bash
cd backend && gofmt -w internal/reconciler/reconciler.go internal/reconciler/reconciler_test.go
git add internal/reconciler/reconciler.go internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(reconciler): log step errors via slog with the step trace_id

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: `internal/tracing` — setup warnings via slog

Replace the two setup-time `log.Printf` calls with `slog.Warn`.

**Files:**
- Modify: `backend/internal/tracing/tracing.go`
- Test: `backend/internal/tracing/tracing_test.go`

- [ ] **Step 1: Extend the existing failing test**

In `backend/internal/tracing/tracing_test.go`, add imports `"bytes"`, `"log/slog"`, `"strings"` to the import block if not present. Then extend `TestSetupToleratesMalformedResourceAttributes` to capture and assert the warning. Add the following at the START of that test (before it calls `Setup`):

```go
	var logBuf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })
```

And add this assertion at the END of that same test (after `shutdown` is called):

```go
	if !strings.Contains(logBuf.String(), "partial resource") {
		t.Fatalf("expected a partial-resource warning, got %q", logBuf.String())
	}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/tracing/ -run TestSetupToleratesMalformedResourceAttributes 2>&1 | tail -8`
Expected: FAIL — no "partial resource" text in the captured slog buffer (the code still uses `log.Printf`, which writes to the stdlib logger, not the slog buffer).

- [ ] **Step 3: Swap the two warnings to slog**

In `backend/internal/tracing/tracing.go`:

Change the import `"log"` to `"log/slog"`.

Replace the exporter-init warning:

```go
		slog.Warn("tracing exporter init failed, tracing disabled", "error", err)
```

Replace the partial-resource warning:

```go
		slog.Warn("tracing partial resource, continuing", "error", err)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/tracing/ 2>&1 | tail -3`
Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/tracing`

- [ ] **Step 5: gofmt + commit**

```bash
cd backend && gofmt -w internal/tracing/tracing.go internal/tracing/tracing_test.go
git add internal/tracing/tracing.go internal/tracing/tracing_test.go
git commit --no-verify -m "feat(tracing): emit setup warnings via slog

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: `cmd/signer` — install default logger + access-log business routes

Install the structured logger, replace `log.*` with slog, and wrap business routes with the access-log middleware.

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/cmd/signer/main_test.go`. Add these imports to that file's import block if not already present: `"bytes"`, `"log/slog"`, `"strings"`, `"github.com/lumos-forge/hypersolid/backend/internal/logging"`.

```go
func TestBusinessRouteEmitsAccessLog(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(logging.New(&buf, slog.LevelInfo))
	defer slog.SetDefault(prev)

	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/v1/digest/l1") // GET → 405, still an access log
	if err != nil {
		t.Fatalf("GET /v1/digest/l1: %v", err)
	}
	_ = resp.Body.Close()

	out := buf.String()
	if !strings.Contains(out, `"msg":"http request"`) || !strings.Contains(out, `"route":"digest_l1"`) {
		t.Fatalf("expected a digest_l1 access log, got %q", out)
	}
}

func TestHealthzEmitsNoAccessLog(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(logging.New(&buf, slog.LevelInfo))
	defer slog.SetDefault(prev)

	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	_ = resp.Body.Close()

	if strings.Contains(buf.String(), `"msg":"http request"`) {
		t.Fatalf("healthz must not emit an access log, got %q", buf.String())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./cmd/signer/ -run 'AccessLog' 2>&1 | tail -8`
Expected: FAIL — no `http request` access log (business routes not yet wrapped with `logging.Middleware`).

- [ ] **Step 3: Import logging + switch main.go to slog**

In `backend/cmd/signer/main.go`:

Change the import `"log"` to `"log/slog"`, and add to the `internal/...` import group:

```go
	"github.com/lumos-forge/hypersolid/backend/internal/logging"
```

At the very top of `run()`, before `tracing.Setup(ctx)`, install the default logger (so tracing's own setup warnings flow through it):

```go
	logging.Setup()
```

Replace the four `log.*` calls in `run()`:
- the `buildHandler` error `log.Print(err)` → `slog.Error("build handler", "error", err)`
- the `net.Listen` error `log.Print(err)` → `slog.Error("listen", "error", err)`
- the `serve` error `log.Print(err)` → `slog.Error("serve", "error", err)`
- the listening line `log.Printf("signer service listening on %s (db=%t)", cfg.addr, cfg.databaseURL != "")` → `slog.Info("signer listening", "addr", cfg.addr, "db", cfg.databaseURL != "")`

- [ ] **Step 4: Add the access-log middleware to business routes in `newMux`**

In `newMux`, add a `loggedRoute` helper next to the existing `route` helper, and switch the four business routes to it (leave `/healthz` on `route` and `/metrics` unchanged):

```go
	mux := http.NewServeMux()
	route := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, metrics.Middleware(name, h))
	}
	loggedRoute := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, logging.Middleware(name, metrics.Middleware(name, h)))
	}
	mux.HandleFunc("/healthz", route("healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	mux.HandleFunc("/v1/digest/l1", loggedRoute("digest_l1", handleDigestL1))
	limiter := ratelimit.New(nowMs)
	mux.HandleFunc("/v1/sign/l1", loggedRoute("sign_l1", handleSignL1(ks, policies, led, fencer, nowMs, limiter)))
	mux.HandleFunc("/v1/reconcile", loggedRoute("reconcile", handleReconcile(led)))
	mux.HandleFunc("/v1/orphans", loggedRoute("orphans", handleOrphans(led)))
	mux.Handle("/metrics", metrics.Handler())
	return mux
```

- [ ] **Step 5: Run the new tests + the full signer suite**

Run: `cd backend && go test ./cmd/signer/ 2>&1 | tail -5`
Expected: PASS — both new access-log tests pass and all pre-existing route/tracing tests stay green.

- [ ] **Step 6: gofmt + commit**

```bash
cd backend && gofmt -w cmd/signer/main.go cmd/signer/main_test.go && \
go vet ./cmd/signer/ && go build ./cmd/signer && rm -f signer
git add cmd/signer/main.go cmd/signer/main_test.go
git commit --no-verify -m "feat(signer): install slog default + access-log business routes

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
Expected: all green.

- [ ] **Reconciler stays OTel-free (production deps):**

```bash
cd backend && go list -deps ./internal/reconciler/ | grep -c opentelemetry
```
Expected: `0`.

- [ ] **No stray stdlib `log` imports remain in the changed files:**

```bash
cd backend && grep -rn '"log"' cmd/signer/main.go internal/reconciler/reconciler.go internal/tracing/tracing.go
```
Expected: no matches.
