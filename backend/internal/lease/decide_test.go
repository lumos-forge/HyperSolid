package lease

import "testing"

const dNow int64 = 1_700_000_000_000

func TestAcquireFreshSeedRow(t *testing.T) {
	// seed row: holder "", epoch 0, expired (expires 0).
	next, write, out, err := Decide(Row{ExpiresAtMs: 0}, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Holder != "a" || next.Epoch != 1 || next.ExpiresAtMs != dNow+1000 {
		t.Fatalf("next=%+v, want {a 1 %d}", next, dNow+1000)
	}
	if out.Holder != "a" || out.Epoch != 1 {
		t.Fatalf("out=%+v, want holder a epoch 1", out)
	}
}

func TestAcquireHeldByOtherRejected(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow + 5000}
	next, write, _, err := Decide(cur, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrHeld || write {
		t.Fatalf("err=%v write=%v, want ErrHeld/false", err, write)
	}
	if next != cur {
		t.Fatalf("state mutated on ErrHeld")
	}
}

func TestAcquireSelfValidRejected(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow + 5000}
	_, write, _, err := Decide(cur, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrHeld || write {
		t.Fatalf("err=%v write=%v, want ErrHeld/false (self valid hold → use Renew)", err, write)
	}
}

func TestAcquireStealsExpiredBumpsEpoch(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow - 1} // expired
	next, write, _, err := Decide(cur, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Holder != "a" || next.Epoch != 4 {
		t.Fatalf("next=%+v, want holder a epoch 4 (cur.epoch+1)", next)
	}
}

func TestRenewValidKeepsEpoch(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow + 500}
	next, write, _, err := Decide(cur, Req{Op: OpRenew, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Epoch != 3 || next.ExpiresAtMs != dNow+1000 {
		t.Fatalf("next=%+v, want epoch 3 (unchanged) expires %d", next, dNow+1000)
	}
}

func TestRenewExpiredSelf(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow - 1}
	_, write, _, err := Decide(cur, Req{Op: OpRenew, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrExpired || write {
		t.Fatalf("err=%v write=%v, want ErrExpired/false", err, write)
	}
}

func TestRenewNotHolder(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow + 500}
	_, write, _, err := Decide(cur, Req{Op: OpRenew, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != ErrNotHolder || write {
		t.Fatalf("err=%v write=%v, want ErrNotHolder/false", err, write)
	}
}

func TestReleaseHolderExpiresKeepsEpoch(t *testing.T) {
	cur := Row{Holder: "a", Epoch: 3, ExpiresAtMs: dNow + 500}
	next, write, _, err := Decide(cur, Req{Op: OpRelease, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || !write {
		t.Fatalf("err=%v write=%v, want nil/true", err, write)
	}
	if next.Holder != "a" || next.Epoch != 3 || next.ExpiresAtMs != dNow {
		t.Fatalf("next=%+v, want {a 3 %d} (expired now, epoch kept)", next, dNow)
	}
}

func TestReleaseNonHolderNoop(t *testing.T) {
	cur := Row{Holder: "b", Epoch: 3, ExpiresAtMs: dNow + 500}
	_, write, _, err := Decide(cur, Req{Op: OpRelease, Holder: "a", NowMs: dNow, TtlMs: 1000})
	if err != nil || write {
		t.Fatalf("err=%v write=%v, want nil/false (idempotent no-op)", err, write)
	}
}

func TestEpochMonotonicAcrossReleaseReacquire(t *testing.T) {
	// acquire → epoch 1
	n1, _, _, _ := Decide(Row{ExpiresAtMs: 0}, Req{Op: OpAcquire, Holder: "a", NowMs: dNow, TtlMs: 1000})
	// release → epoch kept 1, expired
	n2, _, _, _ := Decide(n1, Req{Op: OpRelease, Holder: "a", NowMs: dNow + 10, TtlMs: 1000})
	// re-acquire → epoch 2 (not reset to 1)
	n3, _, _, err := Decide(n2, Req{Op: OpAcquire, Holder: "a", NowMs: dNow + 20, TtlMs: 1000})
	if err != nil {
		t.Fatalf("re-acquire err=%v", err)
	}
	if n3.Epoch != 2 {
		t.Fatalf("epoch=%d, want 2 (monotonic across release/re-acquire)", n3.Epoch)
	}
}
