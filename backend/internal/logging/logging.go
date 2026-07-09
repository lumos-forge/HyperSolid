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
// SpanContext API and never depends on the OTel provider. Because attributes are added
// to the record before delegating, they land at the inner handler's current group
// scope (see New).
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
// correlation applied to every record. Trace attributes (trace_id/span_id) are added
// at the logger's current group scope; keep trace-correlated loggers ungrouped (do not
// wrap the returned logger with WithGroup) so trace_id/span_id appear at the top level
// for downstream log→trace joins.
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
