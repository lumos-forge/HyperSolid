package wsshard

import (
	"sync"
	"testing"
)

func TestNewValidConfigStats(t *testing.T) {
	a, err := New(3, 10)
	if err != nil {
		t.Fatalf("New(3,10) err = %v, want nil", err)
	}
	s := a.Stats()
	if s.NumShards != 3 || s.MaxPerShard != 10 {
		t.Fatalf("dims = (%d,%d), want (3,10)", s.NumShards, s.MaxPerShard)
	}
	if s.Capacity != 30 || s.Admitted != 0 || s.Free != 30 {
		t.Fatalf("cap/admitted/free = (%d,%d,%d), want (30,0,30)", s.Capacity, s.Admitted, s.Free)
	}
	if len(s.ShardLoad) != 3 {
		t.Fatalf("len(ShardLoad) = %d, want 3", len(s.ShardLoad))
	}
	for i, l := range s.ShardLoad {
		if l != 0 {
			t.Fatalf("ShardLoad[%d] = %d, want 0", i, l)
		}
	}
	if s.DeniedFull != 0 {
		t.Fatalf("DeniedFull = %d, want 0", s.DeniedFull)
	}
}

func TestNewInvalidConfigFailClosed(t *testing.T) {
	for _, tc := range []struct{ n, m int }{{0, 10}, {3, 0}, {-1, 10}, {3, -1}, {0, 0}} {
		a, err := New(tc.n, tc.m)
		if err == nil {
			t.Fatalf("New(%d,%d) err = nil, want non-nil", tc.n, tc.m)
		}
		if a == nil {
			t.Fatalf("New(%d,%d) returned nil *Allocator; must be non-nil fail-closed", tc.n, tc.m)
		}
		if sid, ok := a.Admit("0x000000000000000000000000000000000000dEaD"); ok || sid != -1 {
			t.Fatalf("fail-closed Admit = (%d,%v), want (-1,false)", sid, ok)
		}
		s := a.Stats()
		if s.Capacity != 0 || s.Admitted != 0 || s.Free != 0 {
			t.Fatalf("fail-closed Stats cap/admitted/free = (%d,%d,%d), want (0,0,0)", s.Capacity, s.Admitted, s.Free)
		}
	}
}

func TestAdmitIdempotentAndNormalized(t *testing.T) {
	a, _ := New(1, 10)
	const mixed = "0xAbC0000000000000000000000000000000000001"
	sid, ok := a.Admit(mixed)
	if !ok || sid != 0 {
		t.Fatalf("first Admit = (%d,%v), want (0,true)", sid, ok)
	}
	// Same address in different case / with whitespace = same user, same shard, no new slot.
	sid2, ok2 := a.Admit("  0xabc0000000000000000000000000000000000001  ")
	if !ok2 || sid2 != 0 {
		t.Fatalf("idempotent Admit = (%d,%v), want (0,true)", sid2, ok2)
	}
	if got := a.Stats().Admitted; got != 1 {
		t.Fatalf("Admitted = %d, want 1 (idempotent must not consume a new slot)", got)
	}
}

func TestAdmitRejectsInvalidAddress(t *testing.T) {
	a, _ := New(1, 10)
	for _, bad := range []string{"", "0x", "not-an-address", "0x123", "0xZZ00000000000000000000000000000000000001", "000000000000000000000000000000000000dEaD"} {
		if sid, ok := a.Admit(bad); ok || sid != -1 {
			t.Fatalf("Admit(%q) = (%d,%v), want (-1,false)", bad, sid, ok)
		}
	}
	if got := a.Stats().Admitted; got != 0 {
		t.Fatalf("Admitted = %d, want 0 after only invalid admits", got)
	}
}

var _ = sync.Mutex{} // keep sync imported for later tasks
