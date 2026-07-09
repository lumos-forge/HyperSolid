package tracing

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
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
	prevTP := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetTracerProvider(prevTP)
		otel.SetTextMapPropagator(prevProp)
	})
	shutdown, err := Setup(context.Background())
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown must be non-nil")
	}
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

func TestSetupToleratesMalformedResourceAttributes(t *testing.T) {
	var logBuf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://localhost:4318")
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "not-a-valid-pair") // no '=' → partial resource error
	prevTP := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetTracerProvider(prevTP)
		otel.SetTextMapPropagator(prevProp)
	})
	shutdown, err := Setup(context.Background())
	if err != nil {
		t.Fatalf("Setup must not error on malformed resource attrs: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown must be non-nil")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}

	if !strings.Contains(logBuf.String(), "partial resource") {
		t.Fatalf("expected a partial-resource warning, got %q", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), `"level":"WARN"`) {
		t.Fatalf("expected WARN level for partial-resource warning, got %q", logBuf.String())
	}
}
