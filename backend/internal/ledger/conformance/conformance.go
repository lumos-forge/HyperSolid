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
