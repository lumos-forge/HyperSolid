package singlewriter_test

import (
	"context"
	"sync"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter/conformance"
)

const memNow int64 = 1_700_000_000_000

func TestMemConformance(t *testing.T) {
	conformance.Run(t, func() singlewriter.Writer { return singlewriter.NewMem() })
}

func TestMemConcurrentNoNonceReuseNoOverspend(t *testing.T) {
	m := singlewriter.NewMem()
	ctx := context.Background()
	const per = 100.0
	const cap = 1000.0
	const goroutines = 100
	var wg sync.WaitGroup
	var mu sync.Mutex
	nonces := make(map[uint64]int)
	accepted := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g, err := m.Authorize(ctx, singlewriter.Request{KeyID: "k1", Fence: 1, Notional: per, DailyCap: cap, NowMs: memNow})
			if err != nil {
				return
			}
			mu.Lock()
			nonces[g.Nonce]++
			accepted++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if accepted != int(cap/per) {
		t.Fatalf("accepted = %d, want %d (cap/per, no overspend)", accepted, int(cap/per))
	}
	for n, c := range nonces {
		if c != 1 {
			t.Fatalf("nonce %d issued %d times (reuse)", n, c)
		}
	}
	if len(nonces) != accepted {
		t.Fatalf("unique nonces = %d, want %d", len(nonces), accepted)
	}
}
