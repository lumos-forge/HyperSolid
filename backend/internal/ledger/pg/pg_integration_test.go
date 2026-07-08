//go:build integration

package pg_test

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger/conformance"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger/pg"
)

var testPool *pgxpool.Pool

func newPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testPool
}

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("ledger"),
		tcpostgres.WithUsername("ledger"),
		tcpostgres.WithPassword("ledger"),
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

func TestStoreConformance(t *testing.T) {
	ctx := context.Background()
	conformance.Run(t, func() ledger.Authorizer {
		if _, err := testPool.Exec(ctx, "TRUNCATE sw_state, ledger_intents"); err != nil {
			t.Fatalf("truncate: %v", err)
		}
		return pg.New(testPool)
	})
}

func TestConcurrentSameCloidGrantsOneNonce(t *testing.T) {
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, "TRUNCATE sw_state, ledger_intents"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	store := pg.New(testPool)
	const n = 8
	var wg sync.WaitGroup
	grants := make([]ledger.Grant, n)
	errs := make([]error, n)
	req := ledger.Request{KeyID: "k", Cloid: "same", Digest: [32]byte{1}, Fence: 1, Notional: 10, DailyCap: 1000, NowMs: 1_700_000_000_000}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); grants[i], errs[i] = store.Authorize(ctx, req) }(i)
	}
	wg.Wait()
	var nonce uint64
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("goroutine %d err = %v", i, errs[i])
		}
		if nonce == 0 {
			nonce = grants[i].Nonce
		} else if grants[i].Nonce != nonce {
			t.Fatalf("goroutine %d nonce = %d, want all equal to %d", i, grants[i].Nonce, nonce)
		}
	}
	var count int
	if err := testPool.QueryRow(ctx, "SELECT count(*) FROM ledger_intents WHERE key_id='k' AND cloid='same'").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("ledger_intents rows = %d, want 1", count)
	}
}

func TestStoreReconcileConformance(t *testing.T) {
	pool := newPool(t)
	if err := pg.EnsureSchema(context.Background(), pool); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	conformance.RunReconcile(t, func() ledger.Ledger {
		_, _ = pool.Exec(context.Background(), "TRUNCATE sw_state, ledger_intents")
		return pg.New(pool)
	})
}

func TestConcurrentReconcileSerializes(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()
	if err := pg.EnsureSchema(ctx, pool); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	store := pg.New(pool)
	if _, err := store.Authorize(ctx, ledger.Request{KeyID: "k", Cloid: "c", Digest: [32]byte{1}, Fence: 1, Notional: 1, DailyCap: 1000, NowMs: 1_700_000_000_000}); err != nil {
		t.Fatalf("authorize: %v", err)
	}
	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _, errs[i] = store.Reconcile(ctx, "k", "c", ledger.StatusSubmitted) }(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil { // signed->submitted valid; concurrent re-report is idempotent submitted->submitted
			t.Fatalf("goroutine %d err = %v, want nil", i, e)
		}
	}
	var final string
	if err := pool.QueryRow(ctx, "SELECT status FROM ledger_intents WHERE key_id='k' AND cloid='c'").Scan(&final); err != nil {
		t.Fatalf("final: %v", err)
	}
	if final != "submitted" {
		t.Fatalf("final status = %s, want submitted", final)
	}
}
