package wsshard

import (
	"fmt"
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

// admitN admits n distinct valid addresses and returns the shard each landed on.
func admitN(t *testing.T, a *Allocator, n int) []int {
	t.Helper()
	got := make([]int, 0, n)
	for i := 1; i <= n; i++ {
		addr := fmt.Sprintf("0x%040x", i)
		sid, ok := a.Admit(addr)
		if !ok {
			t.Fatalf("Admit #%d unexpectedly denied", i)
		}
		got = append(got, sid)
	}
	return got
}

func TestAdmitLeastLoadedRoundRobinsTies(t *testing.T) {
	a, _ := New(3, 10)
	// With all shards equal, least-loaded + lowest-index tie-break lays users out
	// 0,1,2,0,1,2,... so load stays balanced.
	got := admitN(t, a, 6)
	want := []int{0, 1, 2, 0, 1, 2}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("assignment[%d] = %d, want %d (seq=%v)", i, got[i], want[i], got)
		}
	}
	load := a.Stats().ShardLoad
	for i, l := range load {
		if l != 2 {
			t.Fatalf("ShardLoad[%d] = %d, want 2 (balanced), load=%v", i, l, load)
		}
	}
}

func TestAdmitPrefersEmptierShardAfterRelease(t *testing.T) {
	a, _ := New(2, 10)
	// Fill shard 0 and shard 1 to load 2 each (users u1..u4 -> 0,1,0,1).
	admitN(t, a, 4)
	// Release both users on shard 0 (u1 and u3 landed on shard 0).
	if !a.Release("0x" + fmt.Sprintf("%040x", 1)) {
		t.Fatal("release u1 failed")
	}
	if !a.Release("0x" + fmt.Sprintf("%040x", 3)) {
		t.Fatal("release u3 failed")
	}
	// Now shard 0 load=0, shard 1 load=2. Next admit must pick shard 0.
	sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", 99))
	if !ok || sid != 0 {
		t.Fatalf("Admit after release = (%d,%v), want (0,true) — least-loaded must pick emptier shard", sid, ok)
	}
}

func TestAdmitFullPoolDeniesAndCounts(t *testing.T) {
	a, _ := New(2, 2) // capacity 4
	admitN(t, a, 4)   // fill to capacity
	if got := a.Stats().Free; got != 0 {
		t.Fatalf("Free = %d, want 0 after filling capacity", got)
	}
	// Next two distinct users are denied and increment DeniedFull.
	for i := 5; i <= 6; i++ {
		if sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", i)); ok || sid != -1 {
			t.Fatalf("Admit over capacity = (%d,%v), want (-1,false)", sid, ok)
		}
	}
	if got := a.Stats().DeniedFull; got != 2 {
		t.Fatalf("DeniedFull = %d, want 2", got)
	}
	// An already-admitted user is still served (idempotent), not counted as denial.
	if sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", 1)); !ok || sid < 0 {
		t.Fatalf("idempotent Admit at capacity = (%d,%v), want (>=0,true)", sid, ok)
	}
	if got := a.Stats().DeniedFull; got != 2 {
		t.Fatalf("DeniedFull = %d after idempotent hit, want 2 (unchanged)", got)
	}
	// Releasing one slot lets a new user in again.
	if !a.Release("0x" + fmt.Sprintf("%040x", 2)) {
		t.Fatal("release failed")
	}
	if sid, ok := a.Admit("0x" + fmt.Sprintf("%040x", 7)); !ok || sid < 0 {
		t.Fatalf("Admit after freeing a slot = (%d,%v), want (>=0,true)", sid, ok)
	}
}

var _ = sync.Mutex{} // keep sync imported for later tasks
