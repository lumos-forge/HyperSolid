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
