//go:build integration

package pg_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
	"github.com/lumos-forge/hypersolid/backend/internal/lease/pg"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("lease"),
		tcpostgres.WithUsername("lease"),
		tcpostgres.WithPassword("lease"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2),
		),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start postgres container: %v\n", err)
		os.Exit(1)
	}
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Fprintf(os.Stderr, "connection string: %v\n", err)
		os.Exit(1)
	}
	testPool, err = pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pool: %v\n", err)
		os.Exit(1)
	}
	if err := pg.EnsureSchema(ctx, testPool); err != nil {
		fmt.Fprintf(os.Stderr, "ensure schema: %v\n", err)
		os.Exit(1)
	}
	code := m.Run()
	testPool.Close()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

func TestAcquireRenewReleaseLifecycle(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "lc"

	l, err := s.Acquire(ctx, name, "a", time.Second)
	if err != nil || l.Epoch != 1 || l.Holder != "a" || l.Name != name {
		t.Fatalf("acquire: l=%+v err=%v, want epoch 1 holder a name %s", l, err, name)
	}
	if _, err := s.Acquire(ctx, name, "b", time.Second); !errors.Is(err, lease.ErrHeld) {
		t.Fatalf("acquire by b: err=%v, want ErrHeld", err)
	}
	r, err := s.Renew(ctx, name, "a", time.Second)
	if err != nil || r.Epoch != 1 {
		t.Fatalf("renew: r=%+v err=%v, want epoch 1", r, err)
	}
	if _, err := s.Renew(ctx, name, "b", time.Second); !errors.Is(err, lease.ErrNotHolder) {
		t.Fatalf("renew by b: err=%v, want ErrNotHolder", err)
	}
	if err := s.Release(ctx, name, "a"); err != nil {
		t.Fatalf("release: %v", err)
	}
	l2, err := s.Acquire(ctx, name, "b", time.Second)
	if err != nil || l2.Epoch != 2 || l2.Holder != "b" {
		t.Fatalf("acquire after release: l2=%+v err=%v, want epoch 2 holder b", l2, err)
	}
}

func TestExpiryAllowsSteal(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "exp"
	if _, err := s.Acquire(ctx, name, "a", 200*time.Millisecond); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	l, err := s.Acquire(ctx, name, "b", time.Second)
	if err != nil || l.Holder != "b" || l.Epoch != 2 {
		t.Fatalf("steal expired: l=%+v err=%v, want holder b epoch 2", l, err)
	}
	if _, err := s.Renew(ctx, name, "a", time.Second); !errors.Is(err, lease.ErrNotHolder) {
		t.Fatalf("a renew after steal: err=%v, want ErrNotHolder", err)
	}
}

func TestRenewExpiredSelfReturnsErrExpired(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "exp2"
	if _, err := s.Acquire(ctx, name, "a", 200*time.Millisecond); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := s.Renew(ctx, name, "a", time.Second); !errors.Is(err, lease.ErrExpired) {
		t.Fatalf("renew expired self: err=%v, want ErrExpired", err)
	}
}

func TestConcurrentAcquireSingleWinner(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "race"
	const holders = 30
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	held := 0
	unexpected := []error{}
	for i := 0; i < holders; i++ {
		h := fmt.Sprintf("h%d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, err := s.Acquire(ctx, name, h, time.Minute)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
				if l.Epoch != 1 {
					unexpected = append(unexpected, fmt.Errorf("winner epoch %d, want 1", l.Epoch))
				}
			case errors.Is(err, lease.ErrHeld):
				held++
			default:
				unexpected = append(unexpected, err)
			}
		}()
	}
	wg.Wait()
	if len(unexpected) > 0 {
		t.Fatalf("unexpected: %v", unexpected)
	}
	if wins != 1 {
		t.Fatalf("winners = %d, want exactly 1", wins)
	}
	if held != holders-1 {
		t.Fatalf("ErrHeld count = %d, want %d", held, holders-1)
	}
}

func TestConcurrentStealExpiredSingleWinnerUniqueEpoch(t *testing.T) {
	ctx := context.Background()
	s := pg.New(testPool)
	name := "steal-race"
	// Establish an existing lease (epoch 1), then let it EXPIRE on the DB clock so
	// the contended path is "steal an existing expired row" — the path whose
	// correctness depends on SELECT … FOR UPDATE (not the seed-insert unique index).
	if _, err := s.Acquire(ctx, name, "seed", 100*time.Millisecond); err != nil {
		t.Fatalf("seed acquire: %v", err)
	}
	time.Sleep(250 * time.Millisecond) // expire

	const holders = 30
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	held := 0
	winEpochs := map[uint64]int{}
	unexpected := []error{}
	for i := 0; i < holders; i++ {
		h := fmt.Sprintf("s%d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, err := s.Acquire(ctx, name, h, time.Minute)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
				winEpochs[l.Epoch]++
			case errors.Is(err, lease.ErrHeld):
				held++
			default:
				unexpected = append(unexpected, err)
			}
		}()
	}
	wg.Wait()

	if len(unexpected) > 0 {
		t.Fatalf("unexpected: %v", unexpected)
	}
	if wins != 1 {
		t.Fatalf("winners = %d, want exactly 1 (FOR UPDATE must serialize the steal of an expired row)", wins)
	}
	if held != holders-1 {
		t.Fatalf("ErrHeld = %d, want %d", held, holders-1)
	}
	// The single winner's epoch must be minted exactly once and strictly greater
	// than the seed's epoch 1 — two winners sharing an epoch would break fencing.
	for e, c := range winEpochs {
		if c != 1 {
			t.Fatalf("epoch %d minted %d times (two winners sharing an epoch → fence broken)", e, c)
		}
		if e <= 1 {
			t.Fatalf("winner epoch %d, want > 1 (seed was epoch 1)", e)
		}
	}
}
