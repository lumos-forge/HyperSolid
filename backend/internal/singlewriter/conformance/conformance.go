// Package conformance holds the reusable single-writer contract test suite. It
// lives in its own package (importing testing) so the production singlewriter
// library stays testing-free; any Writer implementation — the in-memory Mem
// here, the Postgres-backed writer in a later slice — must pass Run.
package conformance

import (
	"context"
	"math"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// cfNow is the fixed clock (ms) used by the scenarios.
const cfNow int64 = 1_700_000_000_000

// dayMs mirrors the single-writer's UTC-day bucket size (a fixed real-world
// constant); defined locally so the suite needs nothing unexported.
const dayMs int64 = 24 * 60 * 60 * 1000

// Run exercises a Writer implementation against the single-writer contract.
// newWriter must return a fresh, empty Writer on each call so scenarios do not
// share state.
func Run(t *testing.T, newWriter func() singlewriter.Writer) {
	t.Helper()
	ctx := context.Background()
	type Request = singlewriter.Request // local alias to keep scenarios terse

	t.Run("fresh key nonce is now, then strictly increases", func(t *testing.T) {
		w := newWriter()
		g1, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow})
		if err != nil || g1.Nonce != uint64(cfNow) {
			t.Fatalf("g1 = %+v err = %v, want nonce %d", g1, err, cfNow)
		}
		g2, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow})
		if err != nil || g2.Nonce != uint64(cfNow)+1 {
			t.Fatalf("g2 = %+v err = %v, want nonce %d (last+1)", g2, err, uint64(cfNow)+1)
		}
	})

	t.Run("clock regress still strictly increases", func(t *testing.T) {
		w := newWriter()
		_, _ = w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow})
		g, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, NowMs: cfNow - 10_000})
		if err != nil || g.Nonce != uint64(cfNow)+1 {
			t.Fatalf("g = %+v err = %v, want nonce %d", g, err, uint64(cfNow)+1)
		}
	})

	t.Run("stale fence rejected without consuming state", func(t *testing.T) {
		w := newWriter()
		_, _ = w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow})
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 4, NowMs: cfNow + 1}); err != singlewriter.ErrFenced {
			t.Fatalf("stale fence err = %v, want ErrFenced", err)
		}
		g, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow + 1})
		if err != nil || g.Nonce != uint64(cfNow)+1 {
			t.Fatalf("post-fence g = %+v err = %v, want nonce %d", g, err, uint64(cfNow)+1)
		}
	})

	t.Run("higher fence accepted then old fence rejected", func(t *testing.T) {
		w := newWriter()
		_, _ = w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow})
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 9, NowMs: cfNow + 1}); err != nil {
			t.Fatalf("higher fence err = %v, want nil", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 5, NowMs: cfNow + 2}); err != singlewriter.ErrFenced {
			t.Fatalf("old fence after raise err = %v, want ErrFenced", err)
		}
	})

	t.Run("daily cap strict boundary and deny does not burn nonce", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 300, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("first err = %v", err)
		}
		gAt, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 700, DailyCap: 1000, NowMs: cfNow})
		if err != nil {
			t.Fatalf("at-cap err = %v, want nil", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 1, DailyCap: 1000, NowMs: cfNow}); err != singlewriter.ErrDailyCap {
			t.Fatalf("over-cap err = %v, want ErrDailyCap", err)
		}
		gAfter, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 0, DailyCap: 1000, NowMs: cfNow})
		if err != nil || gAfter.Nonce != gAt.Nonce+1 {
			t.Fatalf("post-deny g = %+v err = %v, want nonce %d (no gap)", gAfter, err, gAt.Nonce+1)
		}
	})

	t.Run("zero cap unlimited", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 1e15, DailyCap: 0, NowMs: cfNow}); err != nil {
			t.Fatalf("err = %v, want nil (0 cap unlimited)", err)
		}
	})

	t.Run("day roll resets spend", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 900, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("day0 err = %v", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 900, DailyCap: 1000, NowMs: cfNow + dayMs}); err != nil {
			t.Fatalf("day1 err = %v, want nil (reset)", err)
		}
	})

	t.Run("invalid notional fails closed", func(t *testing.T) {
		w := newWriter()
		for _, n := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
			if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: n, DailyCap: 1000, NowMs: cfNow}); err != singlewriter.ErrInvalidNotional {
				t.Fatalf("notional %v err = %v, want ErrInvalidNotional", n, err)
			}
		}
	})

	t.Run("negative cap fails closed", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "k", Fence: 1, Notional: 1, DailyCap: -5, NowMs: cfNow}); err != singlewriter.ErrDailyCap {
			t.Fatalf("err = %v, want ErrDailyCap (negative cap)", err)
		}
	})

	t.Run("per-key isolation", func(t *testing.T) {
		w := newWriter()
		if _, err := w.Authorize(ctx, Request{KeyID: "a", Fence: 1, Notional: 1000, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("key a err = %v", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "a", Fence: 1, Notional: 1, DailyCap: 1000, NowMs: cfNow}); err != singlewriter.ErrDailyCap {
			t.Fatalf("key a should be full, err = %v", err)
		}
		if _, err := w.Authorize(ctx, Request{KeyID: "b", Fence: 1, Notional: 1000, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("key b independent, err = %v", err)
		}
	})
}
