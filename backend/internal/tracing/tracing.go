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
	"log/slog"
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
		slog.Warn("tracing exporter init failed, tracing disabled", "error", err)
		return noopShutdown, nil
	}
	// service.name defaults to hypersolid-signer; OTEL_SERVICE_NAME /
	// OTEL_RESOURCE_ATTRIBUTES (via WithFromEnv, applied last) override it.
	res, err := resource.New(ctx,
		resource.WithAttributes(attribute.String("service.name", "hypersolid-signer")),
		resource.WithFromEnv(),
	)
	if err != nil {
		// resource.New returns a usable partial resource alongside the error
		// (e.g. a malformed OTEL_RESOURCE_ATTRIBUTES entry); keep it rather than
		// discarding the configured service.name via resource.Default().
		slog.Warn("tracing partial resource, continuing", "error", err)
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
