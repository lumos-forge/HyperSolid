// Package obs wires Sentry crash/panic reporting for the signer service. Like
// internal/tracing, it is opt-in and fail-safe: with no SENTRY_DSN configured,
// Setup installs nothing and reporting is a safe no-op, so a missing or
// unreachable Sentry never affects signing. It reports crashes only (panics);
// error-level problems are covered by internal/logging.
package obs

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
// It is a safe no-op when Sentry is uninitialized: CurrentHub().Recover returns
// nil without a bound client.
func reportPanic(ctx context.Context, name string, rec interface{}) {
	sentry.WithScope(func(scope *sentry.Scope) {
		scope.SetTag("route", name)
		if sc := trace.SpanContextFromContext(ctx); sc.HasTraceID() {
			scope.SetTag("trace_id", sc.TraceID().String())
		}
		sentry.CurrentHub().Recover(rec)
	})
}

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
