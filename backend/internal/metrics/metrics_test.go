package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

func TestObserveHTTPCounts(t *testing.T) {
	ObserveHTTP("sign", 200, 0.01)
	ObserveHTTP("sign", 200, 0.02)
	ObserveHTTP("sign", 409, 0.03)
	body := scrape(t)
	if !strings.Contains(body, `hypersolid_http_requests_total{code="200",endpoint="sign"} 2`) {
		t.Fatalf("missing 200x2 count:\n%s", body)
	}
	if !strings.Contains(body, `hypersolid_http_requests_total{code="409",endpoint="sign"} 1`) {
		t.Fatalf("missing 409x1 count:\n%s", body)
	}
	if !strings.Contains(body, `hypersolid_http_request_duration_seconds_count{endpoint="sign"} 3`) {
		t.Fatalf("missing duration count 3:\n%s", body)
	}
}

func TestMiddlewareCapturesStatus(t *testing.T) {
	h := Middleware("reconcile", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/v1/reconcile", nil))
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (middleware must pass through)", rec.Code)
	}
	if !strings.Contains(scrape(t), `hypersolid_http_requests_total{code="400",endpoint="reconcile"} 1`) {
		t.Fatalf("middleware did not record code 400")
	}
}

func TestMiddlewareDefaultStatus200(t *testing.T) {
	h := Middleware("orphans", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`)) // no explicit WriteHeader → 200
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/v1/orphans", nil))
	if !strings.Contains(scrape(t), `hypersolid_http_requests_total{code="200",endpoint="orphans"} 1`) {
		t.Fatalf("default status not recorded as 200")
	}
}
