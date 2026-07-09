package logging

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// installDefault swaps the slog default for a buffer-backed logger, restored on cleanup.
func installDefault(t *testing.T, w *bytes.Buffer) {
	t.Helper()
	prev := slog.Default()
	slog.SetDefault(New(w, slog.LevelInfo))
	t.Cleanup(func() { slog.SetDefault(prev) })
}

func TestMiddlewareLogsAccessLine(t *testing.T) {
	var buf bytes.Buffer
	installDefault(t, &buf)
	h := Middleware("sign_l1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/sign/l1", nil))
	out := buf.String()
	for _, want := range []string{
		`"msg":"http request"`, `"method":"POST"`, `"route":"sign_l1"`,
		`"status":200`, `"duration_ms":`, `"level":"INFO"`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("access log missing %s in %q", want, out)
		}
	}
}

func TestMiddlewareWarnsOn5xx(t *testing.T) {
	var buf bytes.Buffer
	installDefault(t, &buf)
	h := Middleware("reconcile", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/reconcile", nil))
	out := buf.String()
	if !strings.Contains(out, `"level":"WARN"`) || !strings.Contains(out, `"status":500`) {
		t.Fatalf("expected WARN + status 500, got %q", out)
	}
}

func TestMiddlewareInjectsTraceIDWithSpan(t *testing.T) {
	var buf bytes.Buffer
	installDefault(t, &buf)
	h := Middleware("digest_l1", func(w http.ResponseWriter, _ *http.Request) {})
	req := httptest.NewRequest(http.MethodPost, "/v1/digest/l1", nil)
	ctx := ctxWithSpan("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331") // helper in logging_test.go
	h(httptest.NewRecorder(), req.WithContext(ctx))
	if !strings.Contains(buf.String(), `"trace_id":"0af7651916cd43dd8448eb211c80319c"`) {
		t.Fatalf("access log missing trace_id: %q", buf.String())
	}
}
