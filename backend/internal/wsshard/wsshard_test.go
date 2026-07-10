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

var _ = sync.Mutex{} // keep sync imported for later tasks
