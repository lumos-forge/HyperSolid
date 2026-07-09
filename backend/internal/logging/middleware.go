package logging

import (
	"log/slog"
	"net/http"
	"time"
)

// statusRecorder captures the status code written by a handler (defaults to 200 when
// the handler never calls WriteHeader).
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// Middleware wraps next, emitting exactly one structured access-log record per request
// via the default logger: method, route (=name), status, and duration_ms. It logs at
// Warn for 5xx responses and Info otherwise. trace_id/span_id are injected by the
// default handler from the request context (the outer tracing middleware has already
// placed the server span there). It records no request/response body. If next panics,
// the request is logged with status 500 and the panic is re-raised.
func Middleware(name string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		defer func() {
			p := recover()
			if p != nil {
				rec.code = http.StatusInternalServerError
			}
			level := slog.LevelInfo
			if rec.code >= 500 {
				level = slog.LevelWarn
			}
			slog.Default().LogAttrs(r.Context(), level, "http request",
				slog.String("method", r.Method),
				slog.String("route", name),
				slog.Int("status", rec.code),
				slog.Float64("duration_ms", float64(time.Since(start).Microseconds())/1000),
			)
			if p != nil {
				panic(p)
			}
		}()
		next(rec, r)
	}
}
