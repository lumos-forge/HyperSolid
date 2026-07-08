package ledger

import (
	"context"
	"errors"
	"testing"
)

func TestTransitionForwardChain(t *testing.T) {
	for _, tc := range []struct{ cur, tgt, want Status }{
		{StatusSigned, StatusSubmitted, StatusSubmitted},
		{StatusSubmitted, StatusOpen, StatusOpen},
		{StatusOpen, StatusFilled, StatusFilled},
		{StatusSubmitted, StatusFilled, StatusFilled},
		{StatusOpen, StatusCanceled, StatusCanceled},
		{StatusSigned, StatusRejected, StatusRejected},
	} {
		got, err := Transition(tc.cur, tc.tgt)
		if err != nil || got != tc.want {
			t.Fatalf("Transition(%s,%s) = %s,%v; want %s,nil", tc.cur, tc.tgt, got, err, tc.want)
		}
	}
}

func TestTransitionIdempotent(t *testing.T) {
	for _, s := range []Status{StatusSigned, StatusOpen, StatusFilled, StatusRejected, StatusCanceled} {
		if got, err := Transition(s, s); err != nil || got != s {
			t.Fatalf("Transition(%s,%s) = %s,%v; want idempotent %s,nil", s, s, got, err, s)
		}
	}
}

func TestTransitionInvalid(t *testing.T) {
	for _, tc := range []struct{ cur, tgt Status }{
		{StatusFilled, StatusOpen},
		{StatusOpen, StatusSigned},
		{StatusFilled, StatusRejected},
		{StatusRejected, StatusFilled},
		{StatusSigned, StatusOpen},
	} {
		if _, err := Transition(tc.cur, tc.tgt); !errors.Is(err, ErrInvalidTransition) {
			t.Fatalf("Transition(%s,%s) err = %v; want ErrInvalidTransition", tc.cur, tc.tgt, err)
		}
	}
}

func TestMemReconcileAndOrphans(t *testing.T) {
	ctx := context.Background()
	m := NewMem()
	if _, err := m.Reconcile(ctx, "k", "c1", StatusSubmitted); !errors.Is(err, ErrUnknownIntent) {
		t.Fatalf("reconcile unknown = %v, want ErrUnknownIntent", err)
	}
	if _, err := m.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1_700_000_000_000}); err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if s, err := m.Reconcile(ctx, "k", "c1", StatusSubmitted); err != nil || s != StatusSubmitted {
		t.Fatalf("reconcile submitted = %s,%v", s, err)
	}
	if _, err := m.Reconcile(ctx, "k", "c1", StatusSigned); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("reconcile backward = %v, want ErrInvalidTransition", err)
	}
	if s, err := m.Reconcile(ctx, "k", "c1", StatusOpen); err != nil || s != StatusOpen {
		t.Fatalf("reconcile open after invalid = %s,%v (state must be intact)", s, err)
	}
	orph, err := m.Orphans(ctx, 4_000_000_000_000)
	if err != nil || len(orph) != 1 || orph[0].Cloid != "c1" || orph[0].Status != StatusOpen {
		t.Fatalf("orphans(future) = %+v,%v; want [c1 open]", orph, err)
	}
	if orph, _ := m.Orphans(ctx, 1_000_000_000); len(orph) != 0 {
		t.Fatalf("orphans(past) = %+v; want empty", orph)
	}
	if _, err := m.Reconcile(ctx, "k", "c1", StatusFilled); err != nil {
		t.Fatalf("reconcile filled: %v", err)
	}
	if orph, _ := m.Orphans(ctx, 4_000_000_000_000); len(orph) != 0 {
		t.Fatalf("orphans after filled = %+v; want empty (terminal excluded)", orph)
	}
}
