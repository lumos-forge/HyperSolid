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

var reconcileSteps = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_reconcile_steps_total",
	Help: "auto-reconciler step outcomes.",
}, []string{"outcome"})

var reconcileReaps = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_reconcile_reaps_total",
	Help: "reap-pass ledger transitions applied by target status.",
}, []string{"target"})

var reconcileLeader = prometheus.NewGauge(prometheus.GaugeOpts{
	Name: "hypersolid_reconcile_leader",
	Help: "1 when this instance's auto-reconciler holds leadership and polls HL, else 0.",
})

func init() {
	reg.MustRegister(httpRequests, httpDuration, reconcileSteps, reconcileReaps, reconcileLeader)
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
// response. If next panics, the request is recorded with status 500 and the
// panic is re-raised so the server's per-connection recovery still applies.
func Middleware(endpoint string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		defer func() {
			p := recover()
			if p != nil {
				rec.code = http.StatusInternalServerError
			}
			ObserveHTTP(endpoint, rec.code, time.Since(start).Seconds())
			if p != nil {
				panic(p)
			}
		}()
		next(rec, r)
	}
}

// ObserveReconcileStep counts one auto-reconciler step by outcome:
// "ok", "error", or "skipped".
func ObserveReconcileStep(outcome string) {
	reconcileSteps.WithLabelValues(outcome).Inc()
}

// ObserveReap counts one reap-pass ledger transition actually applied, by target
// status (e.g. "canceled", "rejected", "filled", "open").
func ObserveReap(target string) {
	reconcileReaps.WithLabelValues(target).Inc()
}

// SetReconcileLeader sets the reconciler leadership gauge (1 when this instance
// polls HL, 0 otherwise).
func SetReconcileLeader(isLeader bool) {
	if isLeader {
		reconcileLeader.Set(1)
		return
	}
	reconcileLeader.Set(0)
}
