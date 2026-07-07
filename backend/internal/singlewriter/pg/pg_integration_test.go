//go:build integration

package pg_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter/conformance"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter/pg"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("sw"),
		tcpostgres.WithUsername("sw"),
		tcpostgres.WithPassword("sw"),
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

func TestPgWriterConformance(t *testing.T) {
	ctx := context.Background()
	conformance.Run(t, func() singlewriter.Writer {
		if _, err := testPool.Exec(ctx, "TRUNCATE sw_state"); err != nil {
			t.Fatalf("truncate: %v", err)
		}
		return pg.New(testPool)
	})
}

func TestPgWriterConcurrentNoReuseNoOverspend(t *testing.T) {
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, "TRUNCATE sw_state"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	w := pg.New(testPool)
	const per = 100.0
	const cap = 1000.0
	const goroutines = 50
	const now = int64(1_700_000_000_000)
	var wg sync.WaitGroup
	var mu sync.Mutex
	nonces := make(map[uint64]int)
	accepted := 0
	var unexpected []error
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g, err := w.Authorize(ctx, singlewriter.Request{KeyID: "k1", Fence: 1, Notional: per, DailyCap: cap, NowMs: now})
			if err != nil {
				if !errors.Is(err, singlewriter.ErrDailyCap) {
					mu.Lock()
					unexpected = append(unexpected, err)
					mu.Unlock()
				}
				return
			}
			mu.Lock()
			nonces[g.Nonce]++
			accepted++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(unexpected) > 0 {
		t.Fatalf("unexpected non-cap errors: %v", unexpected)
	}
	if accepted != int(cap/per) {
		t.Fatalf("accepted = %d, want %d (no overspend across transactions)", accepted, int(cap/per))
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
