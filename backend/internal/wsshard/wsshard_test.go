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

func TestAssignmentLookup(t *testing.T) {
	a, _ := New(2, 10)
	const u = "0x00000000000000000000000000000000000000AA"
	if sid, ok := a.Assignment(u); ok || sid != -1 {
		t.Fatalf("Assignment before admit = (%d,%v), want (-1,false)", sid, ok)
	}
	want, _ := a.Admit(u)
	// Lookup is case-insensitive and does not change state.
	sid, ok := a.Assignment("0x00000000000000000000000000000000000000aa")
	if !ok || sid != want {
		t.Fatalf("Assignment after admit = (%d,%v), want (%d,true)", sid, ok, want)
	}
	if got := a.Stats().Admitted; got != 1 {
		t.Fatalf("Assignment must not admit: Admitted = %d, want 1", got)
	}
	if sid, ok := a.Assignment("garbage"); ok || sid != -1 {
		t.Fatalf("Assignment(invalid) = (%d,%v), want (-1,false)", sid, ok)
	}
	a.Release(u)
	if sid, ok := a.Assignment(u); ok || sid != -1 {
		t.Fatalf("Assignment after release = (%d,%v), want (-1,false)", sid, ok)
	}
}

func TestStatsShardLoadIsCopy(t *testing.T) {
	a, _ := New(2, 10)
	a.Admit("0x" + fmt.Sprintf("%040x", 1))
	s := a.Stats()
	s.ShardLoad[0] = 999 // mutate the returned slice
	if got := a.Stats().ShardLoad[0]; got == 999 {
		t.Fatal("Stats().ShardLoad must be a copy; caller mutation leaked into allocator")
	}
}

func TestInvariantsUnderMixedOps(t *testing.T) {
	a, _ := New(4, 5) // capacity 20
	// Admit 20, release every other, admit 10 more; invariants must always hold.
	for i := 1; i <= 20; i++ {
		a.Admit("0x" + fmt.Sprintf("%040x", i))
	}
	for i := 1; i <= 20; i += 2 {
		a.Release("0x" + fmt.Sprintf("%040x", i))
	}
	for i := 100; i < 110; i++ {
		a.Admit("0x" + fmt.Sprintf("%040x", i))
	}
	s := a.Stats()
	sum := 0
	for i, l := range s.ShardLoad {
		if l < 0 || l > s.MaxPerShard {
			t.Fatalf("ShardLoad[%d] = %d out of [0,%d]", i, l, s.MaxPerShard)
		}
		sum += l
	}
	if sum != s.Admitted {
		t.Fatalf("sum(ShardLoad)=%d != Admitted=%d", sum, s.Admitted)
	}
	if s.Free != s.Capacity-s.Admitted {
		t.Fatalf("Free=%d != Capacity-Admitted=%d", s.Free, s.Capacity-s.Admitted)
	}
}

func TestConcurrentAdmitReleaseStats(t *testing.T) {
	a, _ := New(8, 10) // capacity 80
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				addr := "0x" + fmt.Sprintf("%040x", g*1000+i%50)
				switch i % 3 {
				case 0:
					a.Admit(addr)
				case 1:
					a.Release(addr)
				default:
					_ = a.Stats()
					_, _ = a.Assignment(addr)
				}
			}
		}(g)
	}
	wg.Wait()
	// Final invariant: sum of shard loads equals Admitted, none over cap.
	s := a.Stats()
	sum := 0
	for i, l := range s.ShardLoad {
		if l < 0 || l > s.MaxPerShard {
			t.Fatalf("post-race ShardLoad[%d]=%d out of [0,%d]", i, l, s.MaxPerShard)
		}
		sum += l
	}
	if sum != s.Admitted {
		t.Fatalf("post-race sum(ShardLoad)=%d != Admitted=%d", sum, s.Admitted)
	}
}
