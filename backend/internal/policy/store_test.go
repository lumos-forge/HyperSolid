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

func TestOwnerBudgetConflictMaps(t *testing.T) {
	s := NewStore()
	s.Set("k1", Config{OwnerAddress: "0xAAA", IPRatePerSec: 1, IPRateBurst: 1, AddressDailyMaxNotionalUsdc: 600})
	if s.OwnerIPBudgetConflict("0xaaa") || s.OwnerAddressBudgetConflict("0xaaa") {
		t.Fatal("single owner config must not conflict")
	}

	s.Set("k2", Config{OwnerAddress: "0xaaa", IPRatePerSec: 2, IPRateBurst: 2, AddressDailyMaxNotionalUsdc: 600})
	if !s.OwnerIPBudgetConflict("0xAAA") {
		t.Fatal("IP budget drift for same owner must be detected")
	}
	if s.OwnerAddressBudgetConflict("0xaaa") {
		t.Fatal("address cap should still match here")
	}

	s.Set("k2", Config{OwnerAddress: "0xaaa", IPRatePerSec: 1, IPRateBurst: 1, AddressDailyMaxNotionalUsdc: 700})
	if s.OwnerIPBudgetConflict("0xaaa") {
		t.Fatal("IP budget drift should clear once configs match again")
	}
	if !s.OwnerAddressBudgetConflict("0xaaa") {
		t.Fatal("address-cap drift for same owner must be detected")
	}
}

func TestStoreDelete(t *testing.T) {
	s := NewStore()
	s.Set("k1", Config{OwnerAddress: "0xowner", AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 100})
	if !s.Get("k1").AllowedKinds["order"] {
		t.Fatal("precondition: order should be allowed")
	}
	s.Delete("k1")
	if len(s.Get("k1").AllowedKinds) != 0 {
		t.Fatalf("expected default-deny (empty) Config after Delete, got %+v", s.Get("k1"))
	}
	s.Delete("k1") // idempotent
}
