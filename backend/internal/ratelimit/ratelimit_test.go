package ratelimit

import (
	"math"
	"sync"
	"testing"
)

// fakeClock is a mutable millisecond clock for deterministic refill tests.
type fakeClock struct{ ms int64 }

func (c *fakeClock) now() int64 { return c.ms }

func TestAllowFullBucketThenExhausts(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	for i := 0; i < 3; i++ {
		if !l.Allow("k", 1, 3) {
			t.Fatalf("request %d should be allowed (full bucket)", i+1)
		}
	}
	if l.Allow("k", 1, 3) {
		t.Fatalf("4th request should be denied (bucket empty)")
	}
}

func TestAllowRefillsOverTime(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	for i := 0; i < 3; i++ {
		l.Allow("k", 2, 3)
	}
	if l.Allow("k", 2, 3) {
		t.Fatalf("bucket should be empty before refill")
	}
	clk.ms += 1_000 // 1s at 2 tok/s → +2 tokens
	if !l.Allow("k", 2, 3) {
		t.Fatalf("should allow after 1s refill (1st token)")
	}
	if !l.Allow("k", 2, 3) {
		t.Fatalf("should allow after 1s refill (2nd token)")
	}
	if l.Allow("k", 2, 3) {
		t.Fatalf("only 2 tokens refilled → 3rd denied")
	}
}

func TestRefillCappedAtBurst(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	l.Allow("k", 1, 2) // create bucket (starts full=2), consume 1 → 1 left
	clk.ms += 1_000_000
	if !l.Allow("k", 1, 2) {
		t.Fatalf("token 1 after idle")
	}
	if !l.Allow("k", 1, 2) {
		t.Fatalf("token 2 after idle (capped at burst=2)")
	}
	if l.Allow("k", 1, 2) {
		t.Fatalf("3rd denied — refill must be capped at burst")
	}
}

func TestDisabledAllowsAndDoesNotAllocate(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	for i := 0; i < 100; i++ {
		if !l.Allow("k", 0, 0) {
			t.Fatalf("ratePerSec=0 must always allow (disabled)")
		}
	}
	if len(l.buckets) != 0 {
		t.Fatalf("disabled key must not allocate a bucket, got %d", len(l.buckets))
	}
}

func TestFailClosedOnMisconfig(t *testing.T) {
	l := New((&fakeClock{ms: 1}).now)
	if l.Allow("k", -1, 5) {
		t.Fatalf("negative rate must deny (fail-closed)")
	}
	if l.Allow("k", 5, 0) {
		t.Fatalf("rate>0 with burst<=0 must deny (fail-closed)")
	}
	if l.Allow("k", math.NaN(), 5) {
		t.Fatalf("NaN rate must deny")
	}
	if l.Allow("k", 5, math.Inf(1)) {
		t.Fatalf("Inf burst must deny")
	}
	if len(l.buckets) != 0 {
		t.Fatalf("fail-closed paths must not allocate buckets, got %d", len(l.buckets))
	}
}

func TestClockRollbackNoNegativeRefill(t *testing.T) {
	clk := &fakeClock{ms: 10_000}
	l := New(clk.now)
	l.Allow("k", 1, 2) // full=2 → 1 left, lastMs=10_000
	clk.ms = 5_000     // clock moved backwards
	if !l.Allow("k", 1, 2) {
		t.Fatalf("rollback must not lose the remaining token")
	}
	if l.Allow("k", 1, 2) {
		t.Fatalf("rollback must not add negative/extra tokens beyond what remained")
	}
}

func TestAllowConcurrent(t *testing.T) {
	l := New((&fakeClock{ms: 1}).now)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				l.Allow("k", 10, 10)
			}
		}()
	}
	wg.Wait()
}
