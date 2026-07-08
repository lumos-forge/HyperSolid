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
	// Drive the record to `open` so both `filled` and `canceled` are valid next edges.
	if _, err := store.Reconcile(ctx, "k", "c", ledger.StatusSubmitted); err != nil {
		t.Fatalf("->submitted: %v", err)
	}
	if _, err := store.Reconcile(ctx, "k", "c", ledger.StatusOpen); err != nil {
		t.Fatalf("->open: %v", err)
	}
	// Race two mutually-exclusive terminal transitions from `open`. Under FOR UPDATE
	// serialization exactly ONE terminal wins: the winning target's callers succeed
	// (its own edge, then idempotent self-reports), while the losing target's callers
	// read the committed terminal and get ErrInvalidTransition (cross-terminal). WITHOUT
	// the row lock both groups could read `open` concurrently and both commit with no
	// error (lost update) — so a nonzero loser count is what proves serialization.
	const n = 8
	targets := make([]ledger.Status, n)
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			targets[i] = ledger.StatusFilled
		} else {
			targets[i] = ledger.StatusCanceled
		}
	}
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _, errs[i] = store.Reconcile(ctx, "k", "c", targets[i]) }(i)
	}
	wg.Wait()

	var final string
	if err := pool.QueryRow(ctx, "SELECT status FROM ledger_intents WHERE key_id='k' AND cloid='c'").Scan(&final); err != nil {
		t.Fatalf("final: %v", err)
	}
	if final != string(ledger.StatusFilled) && final != string(ledger.StatusCanceled) {
		t.Fatalf("final status = %s, want a terminal (filled|canceled)", final)
	}
	// Every caller targeting the winner succeeds; every caller targeting the loser
	// must have been rejected as an invalid cross-terminal edge.
	losers := 0
	for i, e := range errs {
		if string(targets[i]) == final {
			if e != nil {
				t.Fatalf("goroutine %d (winner %s) err = %v, want nil", i, targets[i], e)
			}
		} else {
			if !errors.Is(e, ledger.ErrInvalidTransition) {
				t.Fatalf("goroutine %d (loser %s) err = %v, want ErrInvalidTransition (serialization not enforced?)", i, targets[i], e)
			}
			losers++
		}
	}
	if losers == 0 {
		t.Fatal("no losing transitions rejected — FOR UPDATE serialization did not force a single terminal winner")
	}
}
