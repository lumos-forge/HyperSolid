package leader

import (
	"context"
	"testing"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
)

func TestStepAcquiresThenRenews(t *testing.T) {
	now := int64(1_700_000_000_000)
	store := lease.NewMem(func() int64 { return now })
	ctx := context.Background()
	l := New(store, "signer-leader", "a", time.Second)

	l.step(ctx)
	if e, ok := l.Fence(); !ok || e != 1 {
		t.Fatalf("after first step Fence=(%d,%v), want (1,true)", e, ok)
	}
	// within TTL: step renews, epoch unchanged, still leader.
	now += 300
	l.step(ctx)
	if e, ok := l.Fence(); !ok || e != 1 {
		t.Fatalf("after renew Fence=(%d,%v), want (1,true)", e, ok)
	}
}

func TestStepHeldByOtherNotLeader(t *testing.T) {
	now := int64(1_700_000_000_000)
	store := lease.NewMem(func() int64 { return now })
	ctx := context.Background()
	a := New(store, "signer-leader", "a", time.Second)
	a.step(ctx)
	b := New(store, "signer-leader", "b", time.Second)
	b.step(ctx)
	if e, ok := b.Fence(); ok || e != 0 {
		t.Fatalf("b Fence=(%d,%v), want (0,false)", e, ok)
	}
}

func TestStepFailoverBumpsEpoch(t *testing.T) {
	now := int64(1_700_000_000_000)
	store := lease.NewMem(func() int64 { return now })
	ctx := context.Background()
	a := New(store, "signer-leader", "a", time.Second)
	b := New(store, "signer-leader", "b", time.Second)
	a.step(ctx) // a leader, epoch 1
	now += 2000 // a's lease expires

	b.step(ctx) // b steals → epoch 2, leader
	if e, ok := b.Fence(); !ok || e != 2 {
		t.Fatalf("b Fence=(%d,%v), want (2,true)", e, ok)
	}
	a.step(ctx) // a was leader; renew fails (b holds) → tries acquire → ErrHeld → not leader
	if _, ok := a.Fence(); ok {
		t.Fatalf("a still leader after losing lease, want not leader")
	}
}

func TestRunAcquiresAndReleasesOnCancel(t *testing.T) {
	store := lease.NewMem(nil) // real clock
	l := New(store, "signer-leader", "a", time.Second)
	ctx, cancel := context.WithCancel(context.Background())

	go l.Run(ctx, 5*time.Millisecond)

	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := l.Fence(); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Run did not become leader within timeout")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	deadline = time.Now().Add(2 * time.Second)
	for {
		if _, err := store.Acquire(context.Background(), "signer-leader", "b", time.Second); err == nil {
			return // released as expected
		}
		if time.Now().After(deadline) {
			t.Fatal("lease not released after Run cancelled")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
