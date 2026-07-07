package policy

import (
	"math"
	"sync"
	"testing"
)

func TestChargeWithinCap(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	if !s.Charge("k1", 300, 1000) {
		t.Fatal("300 within cap 1000 should charge")
	}
	if got := s.Spent("k1"); got != 300 {
		t.Fatalf("Spent = %v, want 300", got)
	}
	if !s.Charge("k1", 700, 1000) {
		t.Fatal("300+700=1000 == cap should charge (strict >)")
	}
	if s.Charge("k1", 1, 1000) {
		t.Fatal("1001 > cap 1000 should be denied")
	}
	if got := s.Spent("k1"); got != 1000 {
		t.Fatalf("Spent = %v, want 1000 (denied charge not added)", got)
	}
}

func TestChargeZeroCapUnlimited(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	if !s.Charge("k1", 1e15, 0) {
		t.Fatal("dailyCap 0 = unlimited, should charge")
	}
	if got := s.Spent("k1"); got != 1e15 {
		t.Fatalf("Spent = %v, want 1e15", got)
	}
}

func TestChargeDayRollResets(t *testing.T) {
	now := int64(1_700_000_000_000)
	s := NewSpendTracker(func() int64 { return now })
	s.Charge("k1", 900, 1000)
	if s.Charge("k1", 200, 1000) {
		t.Fatal("900+200 over cap same day should deny")
	}
	now += 24 * 60 * 60 * 1000 // next UTC day
	if !s.Charge("k1", 900, 1000) {
		t.Fatal("new day should reset the key's total")
	}
	if got := s.Spent("k1"); got != 900 {
		t.Fatalf("Spent = %v, want 900 (new day)", got)
	}
}

func TestChargePerKeyIsolation(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	s.Charge("a", 1000, 1000)
	if s.Charge("a", 1, 1000) {
		t.Fatal("key a is full")
	}
	if !s.Charge("b", 1000, 1000) {
		t.Fatal("key b is independent and empty")
	}
}

func TestChargeConcurrentNeverExceeds(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	const per = 100.0
	const cap = 1000.0
	const goroutines = 100
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.Charge("k1", per, cap) {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if allowed != 10 {
		t.Fatalf("allowed = %d, want exactly 10 (cap/per)", allowed)
	}
	if got := s.Spent("k1"); got != 1000 {
		t.Fatalf("Spent = %v, want 1000 (never exceeds cap)", got)
	}
}

func TestChargeRejectsInvalidNotional(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	if !s.Charge("k1", 500, 1000) {
		t.Fatal("setup charge should succeed")
	}
	if s.Charge("k1", math.NaN(), 1000) {
		t.Fatal("NaN notional must be rejected (fail-closed)")
	}
	if s.Charge("k1", math.Inf(1), 1000) {
		t.Fatal("+Inf notional must be rejected")
	}
	if s.Charge("k1", math.Inf(-1), 1000) {
		t.Fatal("-Inf notional must be rejected")
	}
	if s.Charge("k1", -1, 1000) {
		t.Fatal("negative notional must be rejected")
	}
	if got := s.Spent("k1"); got != 500 {
		t.Fatalf("Spent = %v, want 500 (invalid charges must not mutate total)", got)
	}
}

func TestChargeNegativeCapFailsClosed(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	if s.Charge("k1", 1, -5) {
		t.Fatal("negative dailyCap (misconfig) must fail closed (deny)")
	}
	if got := s.Spent("k1"); got != 0 {
		t.Fatalf("Spent = %v, want 0 (denied charge not added)", got)
	}
}
