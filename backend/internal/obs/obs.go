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
