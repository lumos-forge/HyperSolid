package obs

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSetupNoDSNIsNoOp(t *testing.T) {
	t.Setenv("SENTRY_DSN", "")
	flush, err := Setup()
	if err != nil {
		t.Fatalf("Setup() err = %v, want nil", err)
	}
	if flush == nil {
		t.Fatal("Setup() flush = nil, want callable no-op")
	}
	flush(50 * time.Millisecond) // must not panic
	if enabled() {
		t.Fatal("enabled() = true with empty SENTRY_DSN, want false")
	}
}

func TestWriteErrShape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeErr(rec, http.StatusInternalServerError, "internal error")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body.Error != "internal error" {
		t.Fatalf("error = %q, want %q", body.Error, "internal error")
	}
}

func TestMiddlewarePassThrough(t *testing.T) {
	called := false
	h := Middleware("healthz", func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if !called {
		t.Fatal("inner handler not called")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestMiddlewareRecoversPanicWrites500(t *testing.T) {
	t.Setenv("SENTRY_DSN", "") // reporting disabled; must still recover + 500
	h := Middleware("sign_l1", func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})
	rec := httptest.NewRecorder()
	// Must not propagate the panic out of the middleware.
	h(rec, httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body.Error != "internal error" {
		t.Fatalf("error = %q, want %q", body.Error, "internal error")
	}
}
