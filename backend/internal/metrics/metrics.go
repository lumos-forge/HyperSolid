// Package metrics exposes Prometheus instrumentation for the signer service on a
// dedicated registry (isolated from the global default). It provides an HTTP
// middleware recording per-endpoint request counts (by status code) and latency,
// plus a Handler serving the exposition endpoint.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var reg = prometheus.NewRegistry()

var httpRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_http_requests_total",
	Help: "signer HTTP requests by endpoint and status code.",
}, []string{"endpoint", "code"})

var httpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "hypersolid_http_request_duration_seconds",
	Help:    "signer HTTP request latency by endpoint.",
	Buckets: prometheus.DefBuckets,
}, []string{"endpoint"})

func init() {
	reg.MustRegister(httpRequests, httpDuration)
}

// ObserveHTTP records one served request: endpoint label, HTTP status code, and
// duration in seconds.
func ObserveHTTP(endpoint string, code int, seconds float64) {
	httpRequests.WithLabelValues(endpoint, strconv.Itoa(code)).Inc()
	httpDuration.WithLabelValues(endpoint).Observe(seconds)
}

// Handler serves the Prometheus text exposition for the dedicated registry.
func Handler() http.Handler {
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}

// statusRecorder captures the status code written by a handler (defaults to 200
// when the handler never calls WriteHeader).
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// Middleware wraps next, recording request count (by status code) and latency
// under the given endpoint label. It is transparent — it does not alter the
// response.
func Middleware(endpoint string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		next(rec, r)
		ObserveHTTP(endpoint, rec.code, time.Since(start).Seconds())
	}
}
