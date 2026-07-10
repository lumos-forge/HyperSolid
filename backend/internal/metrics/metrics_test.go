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

func TestObserveReconcileStep(t *testing.T) {
	before := testutil.ToFloat64(reconcileSteps.WithLabelValues("ok"))
	ObserveReconcileStep("ok")
	ObserveReconcileStep("ok")
	if got := testutil.ToFloat64(reconcileSteps.WithLabelValues("ok")) - before; got != 2 {
		t.Fatalf("ok step delta = %v, want 2", got)
	}
	beforeErr := testutil.ToFloat64(reconcileSteps.WithLabelValues("error"))
	ObserveReconcileStep("error")
	if got := testutil.ToFloat64(reconcileSteps.WithLabelValues("error")) - beforeErr; got != 1 {
		t.Fatalf("error step delta = %v, want 1", got)
	}
}

func TestObserveReap(t *testing.T) {
	before := testutil.ToFloat64(reconcileReaps.WithLabelValues("canceled"))
	ObserveReap("canceled")
	ObserveReap("canceled")
	ObserveReap("rejected")
	if got := testutil.ToFloat64(reconcileReaps.WithLabelValues("canceled")) - before; got != 2 {
		t.Fatalf("canceled reap delta = %v, want 2", got)
	}
	if got := testutil.ToFloat64(reconcileReaps.WithLabelValues("rejected")); got < 1 {
		t.Fatalf("rejected reap = %v, want >= 1", got)
	}
}

func TestSetReconcileLeader(t *testing.T) {
	SetReconcileLeader(true)
	if got := testutil.ToFloat64(reconcileLeader); got != 1 {
		t.Fatalf("leader gauge = %v, want 1", got)
	}
	SetReconcileLeader(false)
	if got := testutil.ToFloat64(reconcileLeader); got != 0 {
		t.Fatalf("leader gauge = %v, want 0", got)
	}
	if !strings.Contains(scrape(t), "hypersolid_reconcile_leader") {
		t.Fatalf("exposition missing reconcile_leader gauge")
	}
}

func TestObserveReconcileStepDuration(t *testing.T) {
	ObserveReconcileStepDuration(0.02)
	ObserveReconcileStepDuration(0.05)
	if !strings.Contains(scrape(t), "hypersolid_reconcile_step_duration_seconds_count") {
		t.Fatalf("exposition missing reconcile step duration histogram")
	}
}

func TestObserveReconcileHL(t *testing.T) {
	ObserveReconcileHL("open", 0.01)
	ObserveReconcileHL("fills", 0.03)
	ObserveReconcileHL("status", 0.02)
	body := scrape(t)
	for _, call := range []string{"open", "fills", "status"} {
		if !strings.Contains(body, `hypersolid_reconcile_hl_request_duration_seconds_count{call="`+call+`"}`) {
			t.Fatalf("exposition missing hl duration for call=%s:\n%s", call, body)
		}
	}
}

func TestObserveBudgetDenial(t *testing.T) {
	before := BudgetDenialValue(BudgetIPRate)
	ObserveBudgetDenial(BudgetIPRate)
	ObserveBudgetDenial(BudgetIPRate)
	if got := BudgetDenialValue(BudgetIPRate) - before; got != 2 {
		t.Fatalf("ip_rate delta = %v, want 2", got)
	}

	beforeKey := BudgetDenialValue(BudgetKeyRate)
	ObserveBudgetDenial(BudgetKeyRate)
	if got := BudgetDenialValue(BudgetKeyRate) - beforeKey; got != 1 {
		t.Fatalf("key_rate delta = %v, want 1", got)
	}

	// Exposition must expose the labeled series once incremented.
	body := scrape(t)
	if !strings.Contains(body, `hypersolid_budget_denials_total{budget="ip_rate"}`) {
		t.Fatalf("missing ip_rate series in exposition:\n%s", body)
	}
	if !strings.Contains(body, `hypersolid_budget_denials_total{budget="key_rate"}`) {
		t.Fatalf("missing key_rate series in exposition:\n%s", body)
	}
}

func TestBudgetDenialValueUnknownIsZero(t *testing.T) {
	if got := BudgetDenialValue("address_cap"); got < 0 {
		t.Fatalf("address_cap value = %v, want >= 0", got)
	}
}
