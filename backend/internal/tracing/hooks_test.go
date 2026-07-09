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
