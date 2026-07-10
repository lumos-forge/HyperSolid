package obs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/lumos-forge/hypersolid/backend/internal/tracing"
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

// mockTransport implements sentry.Transport, recording captured events.
type mockTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (m *mockTransport) Configure(sentry.ClientOptions)        {}
func (m *mockTransport) Flush(time.Duration) bool              { return true }
func (m *mockTransport) FlushWithContext(context.Context) bool { return true }
func (m *mockTransport) Close()                                {}
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
		panic(errors.New("kaboom"))
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

// TestTracingOuterObsInnerCapturesTraceID proves the production nesting: with
// tracing (otelhttp) OUTSIDE and obs INSIDE, obs recovers a panic on the span-
// enriched context, so the trace_id tag is populated. This is the arrangement in
// cmd/signer newMux; obs outermost would read the un-enriched original context
// and never set trace_id.
func TestTracingOuterObsInnerCapturesTraceID(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() {
		otel.SetTracerProvider(prev)
		_ = tp.Shutdown(context.Background())
	})

	mt := initMockSentry(t)

	h := tracing.Middleware("sign_l1", Middleware("sign_l1", func(http.ResponseWriter, *http.Request) {
		panic(errors.New("boom"))
	}))
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil))

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
	tid := events[0].Tags["trace_id"]
	if tid == "" || tid == "00000000000000000000000000000000" {
		t.Fatalf("trace_id tag = %q, want a real trace id (obs must sit INSIDE tracing to see the span)", tid)
	}
	if events[0].Tags["route"] != "sign_l1" {
		t.Fatalf("route tag = %q, want sign_l1", events[0].Tags["route"])
	}
}

// TestConcurrentPanicsPreserveOwnTags guards the per-panic hub clone: each
// concurrent panic carries a distinct route + trace_id and every captured event
// must keep its OWN (route, trace_id) pair. A shared global scope stack would
// cross-contaminate tags under concurrency.
func TestConcurrentPanicsPreserveOwnTags(t *testing.T) {
	mt := initMockSentry(t)

	const n = 24
	want := make(map[string]string, n) // route -> trace_id
	for i := 0; i < n; i++ {
		var tid trace.TraceID
		tid[0] = byte(i + 1)
		want[fmt.Sprintf("route-%d", i)] = tid.String()
	}

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var tid trace.TraceID
			tid[0] = byte(i + 1)
			var sid trace.SpanID
			sid[0] = byte(i + 1)
			sc := trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid})
			ctx := trace.ContextWithSpanContext(context.Background(), sc)
			route := fmt.Sprintf("route-%d", i)
			h := Middleware(route, func(http.ResponseWriter, *http.Request) {
				panic(errors.New(route))
			})
			rec := httptest.NewRecorder()
			h(rec, httptest.NewRequest(http.MethodPost, "/x", nil).WithContext(ctx))
			if rec.Code != http.StatusInternalServerError {
				t.Errorf("status = %d, want 500", rec.Code)
			}
		}(i)
	}
	wg.Wait()

	if !sentry.Flush(3 * time.Second) {
		t.Fatal("sentry flush timed out")
	}
	events := mt.captured()
	if len(events) != n {
		t.Fatalf("captured %d events, want %d", len(events), n)
	}
	seen := make(map[string]bool, n)
	for _, ev := range events {
		route := ev.Tags["route"]
		wantTID, ok := want[route]
		if !ok {
			t.Fatalf("unexpected route tag %q", route)
		}
		if ev.Tags["trace_id"] != wantTID {
			t.Fatalf("route %s: trace_id = %q, want %q (scope contamination)", route, ev.Tags["trace_id"], wantTID)
		}
		if seen[route] {
			t.Fatalf("route %s captured more than once", route)
		}
		seen[route] = true
	}
	if len(seen) != n {
		t.Fatalf("saw %d distinct routes, want %d", len(seen), n)
	}
}
