package lease

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestMemAcquireRenewStealMonotonic(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()

	l, err := m.Acquire(ctx, "k", "a", time.Second)
	if err != nil || l.Epoch != 1 || l.Holder != "a" || l.Name != "k" {
		t.Fatalf("acquire: l=%+v err=%v, want epoch 1 holder a name k", l, err)
	}
	if _, err := m.Acquire(ctx, "k", "b", time.Second); err != ErrHeld {
		t.Fatalf("acquire b: err=%v, want ErrHeld", err)
	}
	r, err := m.Renew(ctx, "k", "a", time.Second)
	if err != nil || r.Epoch != 1 {
		t.Fatalf("renew: r=%+v err=%v, want epoch 1", r, err)
	}
	now += 2000 // past the 1s TTL
	l2, err := m.Acquire(ctx, "k", "b", time.Second)
	if err != nil || l2.Epoch != 2 || l2.Holder != "b" {
		t.Fatalf("steal expired: l2=%+v err=%v, want epoch 2 holder b", l2, err)
	}
}

func TestMemReleaseKeepsEpochMonotonic(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()
	if _, err := m.Acquire(ctx, "k", "a", time.Second); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := m.Release(ctx, "k", "a"); err != nil {
		t.Fatalf("release: %v", err)
	}
	// after release the lease is expired; b acquires with a HIGHER epoch (not reset)
	l, err := m.Acquire(ctx, "k", "b", time.Second)
	if err != nil || l.Epoch != 2 {
		t.Fatalf("acquire after release: l=%+v err=%v, want epoch 2", l, err)
	}
}

func TestMemReleaseNonHolderNoop(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()
	if _, err := m.Acquire(ctx, "k", "a", time.Second); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := m.Release(ctx, "k", "b"); err != nil { // non-holder → no-op nil
		t.Fatalf("release by non-holder: err=%v, want nil", err)
	}
	// a still holds it (valid)
	if _, err := m.Acquire(ctx, "k", "b", time.Second); err != ErrHeld {
		t.Fatalf("acquire b: err=%v, want ErrHeld (a still holds)", err)
	}
}

func TestMemConcurrentAcquireSingleWinner(t *testing.T) {
	now := int64(1_700_000_000_000)
	m := NewMem(func() int64 { return now })
	ctx := context.Background()
	const holders = 50
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, held := 0, 0
	for i := 0; i < holders; i++ {
		h := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.Acquire(ctx, "k", string(rune('A'+h)), time.Minute)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				wins++
			} else if err == ErrHeld {
				held++
			}
		}()
	}
	wg.Wait()
	if wins != 1 || held != holders-1 {
		t.Fatalf("wins=%d held=%d, want 1 and %d", wins, held, holders-1)
	}
}
