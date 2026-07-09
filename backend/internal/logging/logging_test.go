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
