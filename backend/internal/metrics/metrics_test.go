package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// scrape returns the /metrics exposition text.
func scrape(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

// reqCount returns the current value of the given counter series.
func reqCount(endpoint, code string) float64 {
	return testutil.ToFloat64(httpRequests.WithLabelValues(endpoint, code))
}

func TestObserveHTTPCounts(t *testing.T) {
	before200 := reqCount("sign", "200")
	before409 := reqCount("sign", "409")
	ObserveHTTP("sign", 200, 0.01)
	ObserveHTTP("sign", 200, 0.02)
	ObserveHTTP("sign", 409, 0.03)
	if got := reqCount("sign", "200") - before200; got != 2 {
		t.Fatalf("200 delta = %v, want 2", got)
	}
	if got := reqCount("sign", "409") - before409; got != 1 {
		t.Fatalf("409 delta = %v, want 1", got)
	}
	// Exposition must expose the histogram series for this endpoint.
	if !strings.Contains(scrape(t), `hypersolid_http_request_duration_seconds_count{endpoint="sign"}`) {
		t.Fatalf("missing duration series for sign")
	}
}

func TestMiddlewareCapturesStatus(t *testing.T) {
	before := reqCount("reconcile", "400")
	h := Middleware("reconcile", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/v1/reconcile", nil))
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (middleware must pass through)", rec.Code)
	}
	if got := reqCount("reconcile", "400") - before; got != 1 {
		t.Fatalf("reconcile 400 delta = %v, want 1", got)
	}
}

func TestMiddlewareDefaultStatus200(t *testing.T) {
	before := reqCount("orphans", "200")
	h := Middleware("orphans", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`)) // no explicit WriteHeader → 200
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/v1/orphans", nil))
	if got := reqCount("orphans", "200") - before; got != 1 {
		t.Fatalf("orphans 200 delta = %v, want 1", got)
	}
}

func TestMiddlewareRecordsPanicAs500(t *testing.T) {
	before := reqCount("panic", "500")
	h := Middleware("panic", func(_ http.ResponseWriter, _ *http.Request) {
		panic("boom")
	})
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("expected panic to propagate")
		}
		if got := reqCount("panic", "500") - before; got != 1 {
			t.Fatalf("panic 500 delta = %v, want 1", got)
		}
	}()
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/x", nil))
}
