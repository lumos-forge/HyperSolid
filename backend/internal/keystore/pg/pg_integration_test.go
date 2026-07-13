//go:build integration

package pg_test

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	kpg "github.com/lumos-forge/hypersolid/backend/internal/keystore/pg"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("keystore"),
		tcpostgres.WithUsername("keystore"),
		tcpostgres.WithPassword("keystore"),
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
	if err := kpg.EnsureSchema(ctx, testPool); err != nil {
		fmt.Fprintf(os.Stderr, "ensure schema: %v\n", err)
		os.Exit(1)
	}
	code := m.Run()
	testPool.Close()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

func TestPGVaultRoundTrip(t *testing.T) {
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, "TRUNCATE agent_keys"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	v := kpg.New(testPool)
	if err := v.Put(ctx, keystore.Record{KeyID: "k1", AgentAddress: "0xabc", EncPriv: []byte{1, 2, 3}}); err != nil {
		t.Fatal(err)
	}
	if err := v.Put(ctx, keystore.Record{KeyID: "k1", AgentAddress: "0xdef", EncPriv: []byte{4}}); err != nil {
		t.Fatal(err) // upsert
	}
	recs, err := v.List(ctx)
	if err != nil || len(recs) != 1 || recs[0].AgentAddress != "0xdef" {
		t.Fatalf("List = %+v, %v", recs, err)
	}
	if err := v.Delete(ctx, "k1"); err != nil {
		t.Fatal(err)
	}
	if err := v.Delete(ctx, "k1"); err != nil {
		t.Fatalf("Delete must be idempotent: %v", err)
	}
	if recs, _ := v.List(ctx); len(recs) != 0 {
		t.Fatalf("expected empty after delete, got %+v", recs)
	}
}
