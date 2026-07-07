package singlewriter

import (
	"math"
	"testing"
)

const fixedNow int64 = 1_700_000_000_000

func TestDecideFreshKeyNonceIsNow(t *testing.T) {
	next, g, err := decide(State{}, Request{KeyID: "k1", Fence: 1, NowMs: fixedNow})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if g.Nonce != uint64(fixedNow) {
		t.Fatalf("nonce = %d, want %d", g.Nonce, fixedNow)
	}
	if next.LastNonce != uint64(fixedNow) || next.Fence != 1 {
		t.Fatalf("next = %+v, want LastNonce=%d Fence=1", next, fixedNow)
	}
}

func TestDecideNonceStrictlyIncreasesOnClockRegress(t *testing.T) {
	s := State{Fence: 1, LastNonce: uint64(fixedNow)}
	next, g, err := decide(s, Request{KeyID: "k1", Fence: 1, NowMs: fixedNow - 5000})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if g.Nonce != uint64(fixedNow)+1 {
		t.Fatalf("nonce = %d, want %d", g.Nonce, uint64(fixedNow)+1)
	}
	if next.LastNonce != uint64(fixedNow)+1 {
		t.Fatalf("LastNonce = %d, want %d", next.LastNonce, uint64(fixedNow)+1)
	}
}

func TestDecideFenceRejectsStaleToken(t *testing.T) {
	s := State{Fence: 5, LastNonce: uint64(fixedNow)}
	next, _, err := decide(s, Request{KeyID: "k1", Fence: 4, NowMs: fixedNow})
	if err != ErrFenced {
		t.Fatalf("err = %v, want ErrFenced", err)
	}
	if next != s {
		t.Fatalf("state mutated on fenced reject: got %+v want %+v", next, s)
	}
}

func TestDecideFenceEqualAndHigherAccepted(t *testing.T) {
	s := State{Fence: 5, LastNonce: uint64(fixedNow)}
	n1, _, err := decide(s, Request{KeyID: "k1", Fence: 5, NowMs: fixedNow + 1})
	if err != nil || n1.Fence != 5 {
		t.Fatalf("equal token: err=%v fence=%d, want nil/5", err, n1.Fence)
	}
	n2, _, err := decide(s, Request{KeyID: "k1", Fence: 9, NowMs: fixedNow + 1})
	if err != nil || n2.Fence != 9 {
		t.Fatalf("higher token: err=%v fence=%d, want nil/9", err, n2.Fence)
	}
}

func TestDecideDailyCapStrictBoundary(t *testing.T) {
	s := State{Fence: 1, SpendDay: fixedNow / dayMs, SpendTotal: 300}
	at, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 700, DailyCap: 1000, NowMs: fixedNow})
	if err != nil {
		t.Fatalf("at-cap err = %v, want nil", err)
	}
	if at.SpendTotal != 1000 {
		t.Fatalf("SpendTotal = %v, want 1000", at.SpendTotal)
	}
	over, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 701, DailyCap: 1000, NowMs: fixedNow})
	if err != ErrDailyCap {
		t.Fatalf("over-cap err = %v, want ErrDailyCap", err)
	}
	if over != s {
		t.Fatalf("state mutated on cap reject: got %+v want %+v", over, s)
	}
}

func TestDecideZeroCapUnlimited(t *testing.T) {
	next, _, err := decide(State{Fence: 1}, Request{KeyID: "k1", Fence: 1, Notional: 1e15, DailyCap: 0, NowMs: fixedNow})
	if err != nil {
		t.Fatalf("err = %v, want nil (0 cap = unlimited)", err)
	}
	if next.SpendTotal != 1e15 {
		t.Fatalf("SpendTotal = %v, want 1e15", next.SpendTotal)
	}
}

func TestDecideDayRollResetsSpend(t *testing.T) {
	day0 := fixedNow / dayMs
	s := State{Fence: 1, LastNonce: uint64(fixedNow), SpendDay: day0, SpendTotal: 900}
	nextDay := fixedNow + dayMs
	next, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 900, DailyCap: 1000, NowMs: nextDay})
	if err != nil {
		t.Fatalf("err = %v, want nil (new day resets)", err)
	}
	if next.SpendTotal != 900 || next.SpendDay != nextDay/dayMs {
		t.Fatalf("next = %+v, want SpendTotal=900 day=%d", next, nextDay/dayMs)
	}
}

func TestDecideInvalidNotionalFailsClosed(t *testing.T) {
	s := State{Fence: 1, LastNonce: uint64(fixedNow)}
	for _, n := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
		next, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: n, DailyCap: 1000, NowMs: fixedNow})
		if err != ErrInvalidNotional {
			t.Fatalf("notional %v: err = %v, want ErrInvalidNotional", n, err)
		}
		if next != s {
			t.Fatalf("notional %v: state mutated on reject", n)
		}
	}
}

func TestDecideNegativeCapFailsClosed(t *testing.T) {
	s := State{Fence: 1, LastNonce: uint64(fixedNow)}
	next, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 1, DailyCap: -5, NowMs: fixedNow})
	if err != ErrDailyCap {
		t.Fatalf("err = %v, want ErrDailyCap (negative cap misconfig)", err)
	}
	if next != s {
		t.Fatalf("state mutated on negative-cap reject")
	}
}

func TestDecideInvalidClockFailsClosed(t *testing.T) {
	s := State{Fence: 1, LastNonce: uint64(fixedNow)}
	for _, now := range []int64{0, -1, -1_700_000_000_000} {
		next, _, err := decide(s, Request{KeyID: "k1", Fence: 1, Notional: 1, DailyCap: 1000, NowMs: now})
		if err != ErrInvalidClock {
			t.Fatalf("NowMs %d: err = %v, want ErrInvalidClock", now, err)
		}
		if next != s {
			t.Fatalf("NowMs %d: state mutated on reject", now)
		}
	}
}
