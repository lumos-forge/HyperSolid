package policy

import (
	"sync"
	"testing"
)

func TestStoreSetGet(t *testing.T) {
	s := NewStore()
	cfg := Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1000}
	s.Set("k1", cfg)
	got := s.Get("k1")
	if !got.AllowedKinds["order"] || got.MaxNotionalUsdc != 1000 {
		t.Fatalf("Get returned %+v, want %+v", got, cfg)
	}
}

func TestStoreGetAbsentIsDefaultDeny(t *testing.T) {
	s := NewStore()
	got := s.Get("unknown")
	d := Evaluate(Intent{Kind: "order", NotionalUsdc: 1}, got)
	if d.Allow {
		t.Fatal("absent keyId must yield a default-deny config")
	}
	if d.Reason != "kind not allowed" {
		t.Fatalf("reason = %q, want %q", d.Reason, "kind not allowed")
	}
}

func TestStoreConcurrent(t *testing.T) {
	s := NewStore()
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			s.Set("k", Config{MaxNotionalUsdc: float64(n)})
			_ = s.Get("k")
		}(i)
	}
	wg.Wait()
}
