package reconciler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/hlinfo"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
)

// fakeClient serves canned per-address snapshots and can inject an error.
type fakeClient struct {
	open  map[string]map[string]hlinfo.OpenOrder
	fills map[string]map[string]hlinfo.Fill
	err   error
	calls chan struct{} // optional: signal each OpenCloids call
}

func (f *fakeClient) OpenCloids(_ context.Context, user string) (map[string]hlinfo.OpenOrder, error) {
	if f.calls != nil {
		select {
		case f.calls <- struct{}{}:
		default:
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	return f.open[user], nil
}

func (f *fakeClient) FillsByCloid(_ context.Context, user string) (map[string]hlinfo.Fill, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.fills[user], nil
}

func seedSigned(t *testing.T, led *ledger.Mem, keyID, cloid string) {
	t.Helper()
	if _, err := led.Authorize(context.Background(), ledger.Request{KeyID: keyID, Cloid: cloid, Digest: [32]byte{1}, Fence: 1, NowMs: 1_700_000_000_000}); err != nil {
		t.Fatalf("seed %s/%s: %v", keyID, cloid, err)
	}
}

func statusOf(t *testing.T, led *ledger.Mem, cloid string) (ledger.Status, bool) {
	t.Helper()
	orph, _ := led.Orphans(context.Background(), 4_000_000_000_000)
	for _, o := range orph {
		if o.Cloid == cloid {
			return o.Status, true
		}
	}
	return "", false // terminal or absent
}

func TestTargetFor(t *testing.T) {
	open := map[string]hlinfo.OpenOrder{"o": {}}
	fills := map[string]hlinfo.Fill{"f": {}, "o": {}}
	if s, ok := targetFor("o", open, fills); !ok || s != ledger.StatusOpen {
		t.Fatalf("open-precedence = %s,%v", s, ok)
	}
	if s, ok := targetFor("f", open, fills); !ok || s != ledger.StatusFilled {
		t.Fatalf("fills = %s,%v", s, ok)
	}
	if _, ok := targetFor("none", open, fills); ok {
		t.Fatalf("neither should be ok=false")
	}
}

func TestStepAdvancesOpenAndFilled(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	seedSigned(t, led, "k", "c2")
	fc := &fakeClient{
		open:  map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}},
		fills: map[string]map[string]hlinfo.Fill{"0xacc": {"c2": {Sz: 1}}},
	}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if s, ok := statusOf(t, led, "c1"); !ok || s != ledger.StatusOpen {
		t.Fatalf("c1 = %s,%v, want open", s, ok)
	}
	if _, ok := statusOf(t, led, "c2"); ok {
		t.Fatalf("c2 should be terminal (filled) → absent from orphans")
	}
}

func TestStepSkipsUnknownCloid(t *testing.T) {
	led := ledger.NewMem()
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"ghost": {}}}}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step should skip unknown cloid, got %v", err)
	}
}

func TestStepReturnsClientError(t *testing.T) {
	boom := errors.New("boom")
	r := New(&fakeClient{err: boom}, ledger.NewMem(), []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("step err = %v, want boom", err)
	}
}

func TestStepMultiAccount(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k1", "a1")
	seedSigned(t, led, "k2", "b1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{
		"0xA": {"a1": {}},
		"0xB": {"b1": {}},
	}}
	r := New(fc, led, []Account{{KeyID: "k1", Address: "0xA"}, {KeyID: "k2", Address: "0xB"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if s, _ := statusOf(t, led, "a1"); s != ledger.StatusOpen {
		t.Fatalf("a1 = %s, want open", s)
	}
	if s, _ := statusOf(t, led, "b1"); s != ledger.StatusOpen {
		t.Fatalf("b1 = %s, want open", s)
	}
}

func TestRunStepsUntilCanceled(t *testing.T) {
	calls := make(chan struct{}, 4)
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}, calls: calls}
	r := New(fc, ledger.NewMem(), []Account{{KeyID: "k", Address: "0xacc"}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx, time.Millisecond); close(done) }()
	select {
	case <-calls:
	case <-time.After(2 * time.Second):
		t.Fatal("Run never stepped")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
