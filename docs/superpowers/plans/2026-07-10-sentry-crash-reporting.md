# sentry-go 崩溃/panic 上报 (`internal/obs`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `backend/internal/obs`, an opt-in, fail-safe Sentry crash/panic reporting unit (Setup + panic-recovery HTTP middleware + main-level Recover), and wire it into `cmd/signer` so handler panics are captured with trace_id — with zero request-body/header/query leakage.

**Architecture:** One package `internal/obs` with two files: `obs.go` (Setup, Middleware, Recover, private writeErr + reportPanic) and `obs_test.go`. Mirrors `internal/tracing` (opt-in `enabled()`, fail-safe degrade-to-no-op, env-driven, Setup returns a teardown func). Middleware matches the `func(name string, next http.HandlerFunc) http.HandlerFunc` shape and is placed INSIDE `tracing.Middleware` (but outside logging/metrics) so it reads the otelhttp server span for `trace_id` while still catching handler/logging/metrics panics. `reportPanic` clones the hub per panic for scope isolation. Reporting relies on sentry-go being a safe no-op when uninitialized, so only `Setup` gates on `SENTRY_DSN`.

**Tech Stack:** Go; `github.com/getsentry/sentry-go` v0.47.0 (already added to go.mod as indirect via `go get`; becomes direct once imported); `go.opentelemetry.io/otel/trace` (already a dependency) for trace_id; stdlib `net/http`, `os`, `time`, `log/slog`.

**Reference spec:** `docs/superpowers/specs/2026-07-10-sentry-crash-reporting-design.md`

**Branch:** `feat/sentry-crash-reporting` (already created; spec already committed on it).

**Verified sentry-go v0.47.0 API facts (do not re-derive):**
- `sentry.Init(sentry.ClientOptions{Dsn, Environment, Release, SendDefaultPII, TracesSampleRate, BeforeSend, Transport}) error`.
- `sentry.CurrentHub().Clone() *sentry.Hub`; `hub.ConfigureScope(func(scope *sentry.Scope))`; `scope.SetTag(key, value string)`.
- `hub.Recover(err interface{}) *sentry.EventID` — uses that hub's scope; returns nil (no-op) when no client is bound (uninitialized). Cloning gives per-panic scope isolation (concurrent panics must not share the global scope stack).
- `sentry.Flush(timeout time.Duration) bool`.
- `sentry.Event` has field `Request *sentry.Request` (json `request,omitempty`) and `Exception []sentry.Exception`.
- `BeforeSend func(event *sentry.Event, hint *sentry.EventHint) *sentry.Event`.
- `sentry.Transport` interface has 5 methods: `Flush(time.Duration) bool`, `FlushWithContext(context.Context) bool`, `Configure(sentry.ClientOptions)`, `SendEvent(*sentry.Event)`, `Close()`.
- A non-nil custom `Transport` is honored by `setupTransport` even when `Dsn == ""` (it does NOT fall back to noopTransport), so tests inject a mock transport with no real DSN/network.
- `Hub.Recover(v)` branches on the value: an `error` → `EventFromException` (populates `event.Exception` + stack); a `string`/other → `EventFromMessage` (populates `event.Message`, leaves `Exception` empty). Tests that assert on `event.Exception` must panic with an `error` (e.g. `errors.New(...)`).

---

## File Structure

- Create: `backend/internal/obs/obs.go` — `enabled`, `Setup`, `Middleware`, `Recover`, private `reportPanic`, private `writeErr`.
- Create: `backend/internal/obs/obs_test.go` — all unit + race tests, including a `mockTransport`.
- Modify: `backend/cmd/signer/main.go` — add `obs.Setup()` + `defer flush(...)` in `run()`; insert `obs.Middleware` inside `tracing.Middleware` (outside logging/metrics) in `newMux`.
- Modify: `backend/go.mod` / `backend/go.sum` — `sentry-go` becomes a direct dependency (via `go mod tidy` in Task 1).

---

## Task 1: `obs` package skeleton — `enabled`, `Setup`, private `writeErr`

**Files:**
- Create: `backend/internal/obs/obs.go`
- Create: `backend/internal/obs/obs_test.go`
- Modify: `backend/go.mod`, `backend/go.sum`

- [ ] **Step 1: Write the failing test**

Create `backend/internal/obs/obs_test.go`:

```go
package obs

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSetupNoDSNIsNoOp(t *testing.T) {
	t.Setenv("SENTRY_DSN", "")
	flush, err := Setup()
	if err != nil {
		t.Fatalf("Setup() err = %v, want nil", err)
	}
	if flush == nil {
		t.Fatal("Setup() flush = nil, want callable no-op")
	}
	flush(50 * time.Millisecond) // must not panic
	if enabled() {
		t.Fatal("enabled() = true with empty SENTRY_DSN, want false")
	}
}

func TestWriteErrShape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeErr(rec, http.StatusInternalServerError, "internal error")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body.Error != "internal error" {
		t.Fatalf("error = %q, want %q", body.Error, "internal error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/obs/`
Expected: FAIL — compile error, `undefined: Setup`, `undefined: enabled`, `undefined: writeErr`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/internal/obs/obs.go`:

```go
// Package obs wires Sentry crash/panic reporting for the signer service. Like
// internal/tracing, it is opt-in and fail-safe: with no SENTRY_DSN configured,
// Setup installs nothing and reporting is a safe no-op, so a missing or
// unreachable Sentry never affects signing. It reports crashes only (panics);
// error-level problems are covered by internal/logging.
package obs

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/getsentry/sentry-go"
	"go.opentelemetry.io/otel/trace"
)

// enabled reports whether a Sentry DSN is configured. It gates Setup only;
// reporting hooks rely on sentry-go being a no-op when uninitialized.
func enabled() bool { return os.Getenv("SENTRY_DSN") != "" }

// noopFlush is the flush returned when Sentry is disabled.
func noopFlush(time.Duration) {}

// Setup initializes the global Sentry hub when SENTRY_DSN is set, returning a
// flush function to call before exit. With no DSN, or on an init failure, it logs
// a warning and returns a no-op flush plus a nil error — telemetry never aborts
// the signer. It sets SendDefaultPII=false and TracesSampleRate=0 (tracing is
// OTel's job) and strips event.Request via BeforeSend so no request data leaks.
func Setup() (func(time.Duration), error) {
	if !enabled() {
		return noopFlush, nil
	}
	err := sentry.Init(sentry.ClientOptions{
		Dsn:              os.Getenv("SENTRY_DSN"),
		Environment:      os.Getenv("SENTRY_ENVIRONMENT"),
		Release:          os.Getenv("SENTRY_RELEASE"),
		SendDefaultPII:   false,
		TracesSampleRate: 0,
		BeforeSend:       scrubRequest,
	})
	if err != nil {
		slog.Warn("sentry init failed, crash reporting disabled", "error", err)
		return noopFlush, nil
	}
	return func(d time.Duration) { sentry.Flush(d) }, nil
}

// scrubRequest strips any HTTP request data from an event so a signing service
// never leaks request bodies, headers, or query strings to Sentry.
func scrubRequest(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
	event.Request = nil
	return event
}

// writeErr writes a JSON error response matching the signer's other 5xx paths.
func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// Unused import guard removed in Task 2 when trace is used.
var _ = trace.SpanContextFromContext
```

- [ ] **Step 4: Tidy modules and run the test**

Run:
```bash
cd backend && go mod tidy && go test ./internal/obs/
```
Expected: `go mod tidy` moves `github.com/getsentry/sentry-go` from `// indirect` to a direct require; tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/obs/ backend/go.mod backend/go.sum && \
  git commit -m "feat(obs): sentry Setup + JSON writeErr skeleton (opt-in, fail-safe)"
```

---

## Task 2: `Middleware` — panic recovery writes 500, no re-panic

**Files:**
- Modify: `backend/internal/obs/obs.go`
- Test: `backend/internal/obs/obs_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/obs/obs_test.go`:

```go
func TestMiddlewarePassThrough(t *testing.T) {
	called := false
	h := Middleware("healthz", func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if !called {
		t.Fatal("inner handler not called")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestMiddlewareRecoversPanicWrites500(t *testing.T) {
	t.Setenv("SENTRY_DSN", "") // reporting disabled; must still recover + 500
	h := Middleware("sign_l1", func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})
	rec := httptest.NewRecorder()
	// Must not propagate the panic out of the middleware.
	h(rec, httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body.Error != "internal error" {
		t.Fatalf("error = %q, want %q", body.Error, "internal error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/obs/ -run TestMiddleware`
Expected: FAIL — compile error, `undefined: Middleware`.

- [ ] **Step 3: Write minimal implementation**

In `backend/internal/obs/obs.go`, remove the temporary line `var _ = trace.SpanContextFromContext` and add:

```go
// Middleware is a panic-recovery HTTP middleware matching the shape of
// tracing.Middleware / logging.Middleware. On a panic it reports the value to
// Sentry (tagged with the route name and the request's OTel trace_id), writes a
// 500 JSON response, and returns WITHOUT re-panicking so the API stays consistent
// with other 500 paths. A panicking handler must never leak an empty or partial
// response; when Sentry is disabled it still recovers and writes the 500.
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

// reportPanic captures a recovered panic to Sentry with route + trace_id tags.
// It clones the hub so concurrent panics don't contaminate each other's tags via
// the process-global scope stack. It is a safe no-op when Sentry is uninitialized:
// Hub.Recover returns nil without a bound client.
func reportPanic(ctx context.Context, name string, rec interface{}) {
	hub := sentry.CurrentHub().Clone()
	hub.ConfigureScope(func(scope *sentry.Scope) {
		scope.SetTag("route", name)
		if sc := trace.SpanContextFromContext(ctx); sc.HasTraceID() {
			scope.SetTag("trace_id", sc.TraceID().String())
		}
	})
	hub.Recover(rec)
}
```

Add `"context"` to the import block so it reads:

```go
import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/getsentry/sentry-go"
	"go.opentelemetry.io/otel/trace"
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/obs/`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/obs/obs.go backend/internal/obs/obs_test.go && \
  git commit -m "feat(obs): panic-recovery Middleware (recover -> report -> 500, no re-panic)"
```

---

## Task 3: mock transport — verify capture, scrubbing, and tags

**Files:**
- Test: `backend/internal/obs/obs_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/obs/obs_test.go`:

```go
import statements to add at top of file: "context", "sync",
"github.com/getsentry/sentry-go",
"go.opentelemetry.io/otel/trace".
```

First, update the test file's import block to:

```go
import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"go.opentelemetry.io/otel/trace"
)
```

Then append:

```go
// mockTransport implements sentry.Transport, recording captured events.
type mockTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (m *mockTransport) Configure(sentry.ClientOptions)        {}
func (m *mockTransport) Flush(time.Duration) bool                 { return true }
func (m *mockTransport) FlushWithContext(context.Context) bool    { return true }
func (m *mockTransport) Close()                                   {}
func (m *mockTransport) SendEvent(e *sentry.Event) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, e)
}
func (m *mockTransport) captured() []*sentry.Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*sentry.Event, len(m.events))
	copy(out, m.events)
	return out
}

// initMockSentry installs a Sentry client with a mock transport and BeforeSend
// scrubbing, then restores a clean hub on cleanup. A non-nil custom transport is
// honored even without a DSN.
func initMockSentry(t *testing.T) *mockTransport {
	t.Helper()
	mt := &mockTransport{}
	if err := sentry.Init(sentry.ClientOptions{
		Transport:      mt,
		SendDefaultPII: false,
		BeforeSend:     scrubRequest,
	}); err != nil {
		t.Fatalf("sentry.Init(mock) err = %v", err)
	}
	t.Cleanup(func() { _ = sentry.Init(sentry.ClientOptions{}) })
	return mt
}

func TestMiddlewareReportsPanicScrubbedAndTagged(t *testing.T) {
	mt := initMockSentry(t)

	// Build a request carrying an OTel span context so trace_id is tagged.
	traceID := trace.TraceID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10}
	spanID := trace.SpanID{0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18}
	sc := trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID})
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	h := Middleware("sign_l1", func(http.ResponseWriter, *http.Request) {
		panic(errors.New("kaboom")) // error → event.Exception; a string would map to Message
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil).WithContext(ctx)
	h(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !sentry.Flush(2 * time.Second) {
		t.Fatal("sentry flush timed out")
	}
	events := mt.captured()
	if len(events) != 1 {
		t.Fatalf("captured %d events, want 1", len(events))
	}
	ev := events[0]
	if ev.Request != nil {
		t.Fatalf("event.Request = %+v, want nil (scrubbed)", ev.Request)
	}
	if len(ev.Exception) == 0 {
		t.Fatal("event.Exception empty, want the panic captured")
	}
	if ev.Tags["route"] != "sign_l1" {
		t.Fatalf("tags[route] = %q, want sign_l1", ev.Tags["route"])
	}
	if ev.Tags["trace_id"] != traceID.String() {
		t.Fatalf("tags[trace_id] = %q, want %q", ev.Tags["trace_id"], traceID.String())
	}
}

func TestScrubRequestDropsRequest(t *testing.T) {
	ev := &sentry.Event{Request: &sentry.Request{URL: "http://x/y", Data: "secret-body"}}
	out := scrubRequest(ev, nil)
	if out.Request != nil {
		t.Fatalf("Request = %+v, want nil after scrub", out.Request)
	}
}
```

Note: remove the now-duplicate earlier import block edits — the file has a single import block; ensure it matches the block shown above (Task 1 and Task 2 test additions used only `encoding/json`, `net/http`, `net/http/httptest`, `testing`, `time`; this task widens it to include `context`, `sync`, `sentry`, and `trace`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/obs/ -run 'TestMiddlewareReportsPanic|TestScrubRequest'`
Expected: PASS. Both behaviors (`reportPanic` capture + `scrubRequest`) already exist from Tasks 1–2; this task adds the mock-transport verification. If either FAILS, fix `reportPanic`/`scrubRequest` until green. (This is a characterization/verification task: the value is proving capture reaches the transport, scrubbing nils Request, and tags are set.)

- [ ] **Step 3: (no production change expected)**

Only touch `obs.go` if Step 2 revealed a defect (e.g. tags not set, Request not nil).

- [ ] **Step 4: Run full package test**

Run: `cd backend && go test ./internal/obs/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/obs/obs_test.go && \
  git commit -m "test(obs): mock-transport capture, Request scrubbing, route+trace_id tags"
```

---

## Task 4: `Recover` — main-level panic capture then re-panic

**Files:**
- Modify: `backend/internal/obs/obs.go`
- Test: `backend/internal/obs/obs_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/obs/obs_test.go`:

```go
func TestRecoverNoPanicIsNoOp(t *testing.T) {
	// Calling Recover with no panic in flight must do nothing and not panic.
	func() {
		defer Recover()
	}()
}

func TestRecoverRepanicsAfterReporting(t *testing.T) {
	mt := initMockSentry(t)
	var got interface{}
	func() {
		defer func() { got = recover() }() // catch the re-panic
		defer Recover()
		panic("escaped")
	}()
	if got != "escaped" {
		t.Fatalf("re-panic value = %v, want %q", got, "escaped")
	}
	if !sentry.Flush(2 * time.Second) {
		t.Fatal("sentry flush timed out")
	}
	if n := len(mt.captured()); n != 1 {
		t.Fatalf("captured %d events, want 1", n)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/obs/ -run TestRecover`
Expected: FAIL — compile error, `undefined: Recover`.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/internal/obs/obs.go`, after `reportPanic`:

```go
// Recover is for a deferred call at the top of a goroutine (e.g. main or a
// background loop). It recovers a panic that escaped, reports it to Sentry,
// flushes, and re-panics so the original crash behavior (stack print, non-zero
// exit) is preserved. It is a no-op when there is no panic in flight, and the
// report/flush are safe no-ops when Sentry is uninitialized.
func Recover() {
	if rec := recover(); rec != nil {
		sentry.CurrentHub().Recover(rec)
		sentry.Flush(2 * time.Second)
		panic(rec)
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/obs/`
Expected: PASS (all obs tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/obs/obs.go backend/internal/obs/obs_test.go && \
  git commit -m "feat(obs): Recover for goroutine-top panic capture then re-panic"
```

---

## Task 5: concurrency test (`-race`)

**Files:**
- Test: `backend/internal/obs/obs_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/obs/obs_test.go`:

```go
func TestMiddlewareConcurrentPanics(t *testing.T) {
	initMockSentry(t)
	h := Middleware("sign_l1", func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			h(rec, httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil))
			if rec.Code != http.StatusInternalServerError {
				t.Errorf("status = %d, want 500", rec.Code)
			}
		}()
	}
	wg.Wait()
}
```

- [ ] **Step 2: Run test under the race detector**

Run: `cd backend && go test -race ./internal/obs/ -run TestMiddlewareConcurrentPanics`
Expected: PASS with no `DATA RACE` reports. (The middleware holds no shared mutable state; `reportPanic` clones the hub so each panic uses an isolated scope.)

- [ ] **Step 3: (no production change expected)**

If a race is reported, it would indicate shared state in `obs.go`; the middleware must remain stateless.

- [ ] **Step 4: Run the full package under race**

Run: `cd backend && go test -race ./internal/obs/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/obs/obs_test.go && \
  git commit -m "test(obs): concurrent panic middleware under -race"
```

---

## Task 6: wire `obs` into `cmd/signer`

**Files:**
- Modify: `backend/cmd/signer/main.go`

- [ ] **Step 1: Write the failing test**

Append a test to `backend/cmd/signer/main_test.go` verifying `/healthz` (which uses the non-logged `route` builder) returns 200 through the mux — this guards the outermost `obs.Middleware` wrapper change. Reuse the existing `leaderMux(ks, policies, nowMs)` helper already defined in `main_test.go` (it calls `newMux(ks, policies, ledger.NewMem(), constFencer{...}, nowMs)`):

```go
func TestHealthzThroughObsWrapper(t *testing.T) {
	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), func() int64 { return 0 }))
	defer srv.Close()
	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", res.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("healthz body not JSON: %v", err)
	}
	if body.Status != "ok" {
		t.Fatalf("status = %q, want ok", body.Status)
	}
}
```

All imports used here (`encoding/json`, `net/http`, `net/http/httptest`, `keystore`, `policy`) already exist in `main_test.go`; no import changes needed.

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd backend && go test ./cmd/signer/ -run TestHealthzThroughObsWrapper`
Expected: PASS (the existing `leaderMux`/`newMux` already serve `/healthz`). This test is a guard that must remain green after wrapping routes with `obs.Middleware` in Step 3.

- [ ] **Step 3: Wire obs into main.go**

(a) Add the import. In `backend/cmd/signer/main.go`, add to the internal imports block:

```go
	"github.com/lumos-forge/hypersolid/backend/internal/obs"
```

(b) In `run()`, right after the `tracing.Setup` block's `defer`, add Sentry setup + flush. Locate:

```go
	shutdownTracing, _ := tracing.Setup(ctx)
	defer func() {
		sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTracing(sc)
	}()
```

Immediately after that block, insert:

```go
	flushSentry, _ := obs.Setup()
	defer flushSentry(2 * time.Second)
```

(c) In `newMux`, insert `obs.Middleware` INSIDE `tracing.Middleware` (but outside logging/metrics) so obs reads the otelhttp server span for `trace_id` while still catching handler/logging/metrics panics (logging and metrics recover-then-re-panic). Locate:

```go
	route := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, metrics.Middleware(name, h))
	}
	loggedRoute := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, logging.Middleware(name, metrics.Middleware(name, h)))
	}
```

Replace with:

```go
	route := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, obs.Middleware(name, metrics.Middleware(name, h)))
	}
	loggedRoute := func(name string, h http.HandlerFunc) http.HandlerFunc {
		return tracing.Middleware(name, obs.Middleware(name, logging.Middleware(name, metrics.Middleware(name, h))))
	}
```

- [ ] **Step 4: Run signer tests + vet + build**

Run:
```bash
cd backend && gofmt -w cmd/signer/main.go && \
  go test ./cmd/signer/ ./internal/obs/ && \
  go vet ./cmd/signer/ ./internal/obs/ && \
  go build ./...
```
Expected: all PASS; `go build ./...` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go && \
  git commit -m "feat(signer): wire obs Sentry setup + outermost panic middleware"
```

---

## Task 7: final validation + PR

**Files:** none (validation + PR only)

- [ ] **Step 1: Format, vet, full build, and race test**

Run:
```bash
cd backend && gofmt -l internal/obs/ cmd/signer/ && \
  go test ./internal/obs/ ./cmd/signer/ && \
  go test -race ./internal/obs/ ./cmd/signer/ && \
  go vet ./internal/obs/ ./cmd/signer/ && \
  go build ./...
```
Expected: `gofmt -l` prints nothing (no unformatted files); all tests, race, vet, build pass.

- [ ] **Step 2: Commit any gofmt changes (if any)**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add -A backend/ && \
  git commit -m "chore(obs): gofmt" || echo "nothing to format"
```

- [ ] **Step 3: Update roadmap doc**

In `docs/BACKEND-ARCHITECTURE.md`, update the `obs/` module-tree line and the M10/§12 status wording to mark Sentry crash reporting landed. Locate the line:

```
│   └── obs/                 # sentry（待做；结构化日志见 internal/logging、追踪见 internal/tracing、指标用 metrics/ Prometheus）
```

Replace with:

```
│   └── obs/                 # M10 sentry-go 崩溃/panic 上报（opt-in fail-safe，Setup+panic 中间件+Recover，scrub Request #PR ✅）
```

And in the M10 status cell (line ~34) and §12 bullet (line ~101), append to the landed list: `signer 崩溃上报（sentry-go：opt-in fail-safe，panic 恢复中间件带 trace_id + BeforeSend 剔除 Request，internal/obs）落地`. Remove "sentry-go·" from the remaining-work phrasing so only the OTLP logs pipeline stays pending. (Do a final `grep -n "sentry" docs/BACKEND-ARCHITECTURE.md` to confirm no stale "待做" for sentry remains.)

Commit:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: mark sentry-go 崩溃上报 (internal/obs) landed in M10 roadmap"
```

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/sentry-crash-reporting && \
  gh pr create --title "feat(backend): signer 崩溃上报 internal/obs（sentry-go，M10）" \
    --body "M10 收尾项：signer 崩溃/panic 上报。opt-in fail-safe（SENTRY_DSN 门控，缺失/不可达零影响签名）；panic 恢复中间件（recover→上报带 route+trace_id→写 500 JSON→不 re-panic），插在中间件链最外层兜住内层所有 panic；main 层 Setup+flush。零敏感泄漏：SendDefaultPII=false + BeforeSend 剔除 event.Request（绝不带请求体/头/query）。仅 panic，error 归 slog。Spec: docs/superpowers/specs/2026-07-10-sentry-crash-reporting-design.md"
```
Expected: PR created.

- [ ] **Step 5: After review + green CI, merge**

Per repository workflow, once review passes and CI is green, merge:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §4 API `Setup` → Task 1; `Middleware` → Task 2; `Recover` → Task 4. §5.1 `enabled` gate → Task 1. §5.2 Init options + fail-safe warn → Task 1. §5.3 reportPanic tags + no-op-when-uninit → Tasks 2–3. §5.4 Recover re-panic → Task 4. §5.5 signer wiring (Setup+flush, outermost middleware) → Task 6. §6 private writeErr + no import cycle → Task 1. §7 test plan items 1–6 → Tasks 1–5. §8 validation → Task 7. All covered.
- **Placeholder scan:** every code step has complete, compilable Go. The `var _ = trace.SpanContextFromContext` guard in Task 1 is explicitly removed in Task 2 Step 3.
- **Type consistency:** `Setup() (func(time.Duration), error)`, `Middleware(string, http.HandlerFunc) http.HandlerFunc`, `Recover()`, `reportPanic(context.Context, string, interface{})`, `scrubRequest(*sentry.Event, *sentry.EventHint) *sentry.Event`, `writeErr(http.ResponseWriter, int, string)` are identical across all tasks and match the spec. `mockTransport` implements the exact 4-method `sentry.Transport` interface.
- **Import hygiene:** `obs.go` imports `context, encoding/json, log/slog, net/http, os, time, github.com/getsentry/sentry-go, go.opentelemetry.io/otel/trace`. Task 1 introduces sentry+trace with a temporary `var _` guard for `trace` until Task 2 uses it; `context` is added in Task 2. Test file import block is finalized in Task 3.
- **Wiring risk:** Task 6 Step 1 test (`TestHealthzThroughObsWrapper`) guards the outermost-wrapper change; healthz uses the `route` (non-logged) builder, so wrapping it with `obs.Middleware` is exercised.
