// Package conformance holds the reusable cloid-ledger contract test suite. It
// lives in its own package (importing testing) so the production ledger library
// stays testing-free; any Authorizer implementation — the in-memory Mem, the
// Postgres Store — must pass Run.
package conformance

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// cfNow is the fixed clock (ms) used by the scenarios.
const cfNow int64 = 1_700_000_000_000

// dig is a terse 32-byte digest builder (only the first byte varies per intent).
func dig(b byte) [32]byte { return [32]byte{b} }

// Run exercises an Authorizer implementation against the cloid-ledger contract.
// newAuth must return a fresh, empty Authorizer on each call so scenarios do not
// share state.
func Run(t *testing.T, newAuth func() ledger.Authorizer) {
	t.Helper()
	ctx := context.Background()
	type Request = ledger.Request

	t.Run("fresh cloid allocates nonce = now", func(t *testing.T) {
		a := newAuth()
		g, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || g.Nonce != uint64(cfNow) || g.Duplicate {
			t.Fatalf("g = %+v err = %v, want nonce %d dup false", g, err, uint64(cfNow))
		}
	})

	t.Run("same cloid same digest replays original nonce without recharging cap", func(t *testing.T) {
		a := newAuth()
		g1, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, Notional: 600, DailyCap: 1000, NowMs: cfNow})
		if err != nil {
			t.Fatalf("c1 err = %v", err)
		}
		gr, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, Notional: 600, DailyCap: 1000, NowMs: cfNow})
		if err != nil || gr.Nonce != g1.Nonce || !gr.Duplicate {
			t.Fatalf("replay g = %+v err = %v, want nonce %d dup true", gr, err, g1.Nonce)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(2), Fence: 1, Notional: 300, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("c2 err = %v, want nil (replay must not have charged the cap)", err)
		}
	})

	t.Run("same cloid different digest fails closed and does not disturb the record", func(t *testing.T) {
		a := newAuth()
		g1, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil {
			t.Fatalf("c1 err = %v", err)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(9), Fence: 1, NowMs: cfNow}); !errors.Is(err, ledger.ErrCloidReuse) {
			t.Fatalf("collision err = %v, want ErrCloidReuse", err)
		}
		gr, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || gr.Nonce != g1.Nonce || !gr.Duplicate {
			t.Fatalf("post-collision replay g = %+v err = %v, want nonce %d dup true", gr, err, g1.Nonce)
		}
	})

	t.Run("empty cloid fails closed without consuming a nonce", func(t *testing.T) {
		a := newAuth()
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "", Fence: 1, NowMs: cfNow}); !errors.Is(err, ledger.ErrMissingCloid) {
			t.Fatalf("empty cloid err = %v, want ErrMissingCloid", err)
		}
		g, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || g.Nonce != uint64(cfNow) {
			t.Fatalf("post-empty g = %+v err = %v, want nonce %d (no nonce burned)", g, err, uint64(cfNow))
		}
	})

	t.Run("distinct cloids get strictly increasing distinct nonces", func(t *testing.T) {
		a := newAuth()
		g1, _ := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		g2, _ := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(2), Fence: 1, NowMs: cfNow})
		if g2.Nonce <= g1.Nonce {
			t.Fatalf("g2.Nonce %d must exceed g1.Nonce %d", g2.Nonce, g1.Nonce)
		}
	})

	t.Run("single-writer rejections pass through", func(t *testing.T) {
		a := newAuth()
		_, _ = a.Authorize(ctx, Request{KeyID: "k", Cloid: "c0", Digest: dig(1), Fence: 5, NowMs: cfNow})
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(2), Fence: 4, NowMs: cfNow + 1}); !errors.Is(err, singlewriter.ErrFenced) {
			t.Fatalf("stale fence err = %v, want ErrFenced", err)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(3), Fence: 5, NowMs: 0}); !errors.Is(err, singlewriter.ErrInvalidClock) {
			t.Fatalf("bad clock err = %v, want ErrInvalidClock", err)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c3", Digest: dig(4), Fence: 5, Notional: 2000, DailyCap: 1000, NowMs: cfNow + 2}); !errors.Is(err, singlewriter.ErrDailyCap) {
			t.Fatalf("over cap err = %v, want ErrDailyCap", err)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c4", Digest: dig(5), Fence: 5, Notional: math.NaN(), DailyCap: 1000, NowMs: cfNow + 3}); !errors.Is(err, singlewriter.ErrInvalidNotional) {
			t.Fatalf("NaN notional err = %v, want ErrInvalidNotional", err)
		}
	})

	t.Run("per-key isolation: same cloid under different keys is independent", func(t *testing.T) {
		a := newAuth()
		ga, err := a.Authorize(ctx, Request{KeyID: "a", Cloid: "shared", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil {
			t.Fatalf("key a err = %v", err)
		}
		gb, err := a.Authorize(ctx, Request{KeyID: "b", Cloid: "shared", Digest: dig(2), Fence: 1, NowMs: cfNow})
		if err != nil {
			t.Fatalf("key b err = %v, want nil (independent of key a)", err)
		}
		if ga.Duplicate || gb.Duplicate {
			t.Fatalf("neither should be a duplicate: ga=%+v gb=%+v", ga, gb)
		}
	})

	t.Run("replay is stable after later cloids advance the nonce", func(t *testing.T) {
		a := newAuth()
		g1, _ := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		_, _ = a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(2), Fence: 1, NowMs: cfNow})
		_, _ = a.Authorize(ctx, Request{KeyID: "k", Cloid: "c3", Digest: dig(3), Fence: 1, NowMs: cfNow})
		gr, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || gr.Nonce != g1.Nonce || !gr.Duplicate {
			t.Fatalf("stable replay g = %+v err = %v, want ORIGINAL nonce %d dup true", gr, err, g1.Nonce)
		}
	})
}

// RunReconcile exercises a Ledger implementation against the reconciliation +
// orphan-detection contract. newLedger must return a fresh, empty Ledger each call.
func RunReconcile(t *testing.T, newLedger func() ledger.Ledger) {
	t.Helper()
	ctx := context.Background()
	seed := func(l ledger.Ledger, key, cloid string, b byte) {
		if _, err := l.Authorize(ctx, ledger.Request{KeyID: key, Cloid: cloid, Digest: dig(b), Fence: 1, NowMs: cfNow}); err != nil {
			t.Fatalf("seed authorize(%s,%s): %v", key, cloid, err)
		}
	}

	t.Run("forward chain signed->submitted->open->filled", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "c1", 1)
		for _, tgt := range []ledger.Status{ledger.StatusSubmitted, ledger.StatusOpen, ledger.StatusFilled} {
			got, err := l.Reconcile(ctx, "k", "c1", tgt)
			if err != nil || got != tgt {
				t.Fatalf("reconcile %s = %s,%v", tgt, got, err)
			}
		}
	})

	t.Run("idempotent re-report of terminal", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "c1", 1)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusSubmitted)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusFilled)
		if got, err := l.Reconcile(ctx, "k", "c1", ledger.StatusFilled); err != nil || got != ledger.StatusFilled {
			t.Fatalf("idempotent filled = %s,%v, want filled,nil", got, err)
		}
	})

	t.Run("invalid transition leaves state intact", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "c1", 1)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusSubmitted)
		_, _ = l.Reconcile(ctx, "k", "c1", ledger.StatusOpen)
		if _, err := l.Reconcile(ctx, "k", "c1", ledger.StatusSigned); !errors.Is(err, ledger.ErrInvalidTransition) {
			t.Fatalf("backward err = %v, want ErrInvalidTransition", err)
		}
		if got, err := l.Reconcile(ctx, "k", "c1", ledger.StatusFilled); err != nil || got != ledger.StatusFilled {
			t.Fatalf("valid after invalid = %s,%v (state must be intact)", got, err)
		}
		if _, err := l.Reconcile(ctx, "k", "c1", ledger.StatusRejected); !errors.Is(err, ledger.ErrInvalidTransition) {
			t.Fatalf("cross-terminal err = %v, want ErrInvalidTransition", err)
		}
	})

	t.Run("unknown intent", func(t *testing.T) {
		l := newLedger()
		if _, err := l.Reconcile(ctx, "k", "nope", ledger.StatusSubmitted); !errors.Is(err, ledger.ErrUnknownIntent) {
			t.Fatalf("unknown = %v, want ErrUnknownIntent", err)
		}
	})

	t.Run("orphans: non-terminal within cutoff, terminal excluded", func(t *testing.T) {
		l := newLedger()
		seed(l, "k", "term", 1)
		seed(l, "k", "open", 2)
		seed(l, "k", "sign", 3)
		// term reaches a terminal state via a valid edge (signed→submitted→filled).
		if _, err := l.Reconcile(ctx, "k", "term", ledger.StatusSubmitted); err != nil {
			t.Fatalf("term->submitted: %v", err)
		}
		if _, err := l.Reconcile(ctx, "k", "term", ledger.StatusFilled); err != nil {
			t.Fatalf("term->filled: %v", err)
		}
		// open reaches the open state via a valid edge (signed→submitted→open).
		if _, err := l.Reconcile(ctx, "k", "open", ledger.StatusSubmitted); err != nil {
			t.Fatalf("open->submitted: %v", err)
		}
		if _, err := l.Reconcile(ctx, "k", "open", ledger.StatusOpen); err != nil {
			t.Fatalf("open->open: %v", err)
		}
		orph, err := l.Orphans(ctx, 4_000_000_000_000)
		if err != nil {
			t.Fatalf("orphans: %v", err)
		}
		got := map[string]ledger.Status{}
		for _, o := range orph {
			got[o.Cloid] = o.Status
		}
		if len(got) != 2 || got["open"] != ledger.StatusOpen || got["sign"] != ledger.StatusSigned {
			t.Fatalf("orphans = %+v; want {open:open, sign:signed} (term excluded)", got)
		}
		if past, _ := l.Orphans(ctx, 1_000_000_000); len(past) != 0 {
			t.Fatalf("orphans(past) = %+v; want empty", past)
		}
	})

	t.Run("orphans across keys", func(t *testing.T) {
		l := newLedger()
		seed(l, "a", "c", 1)
		seed(l, "b", "c", 2)
		orph, err := l.Orphans(ctx, 4_000_000_000_000)
		if err != nil {
			t.Fatalf("orphans: %v", err)
		}
		keys := map[string]bool{}
		for _, o := range orph {
			keys[o.KeyID] = true
		}
		if !keys["a"] || !keys["b"] {
			t.Fatalf("orphans keys = %+v; want both a and b", keys)
		}
	})
}
