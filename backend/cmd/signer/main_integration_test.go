//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
)

func TestBuildHandlerPostgresEndToEnd(t *testing.T) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("signer"),
		tcpostgres.WithUsername("signer"),
		tcpostgres.WithPassword("signer"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2),
		),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	defer func() { _ = container.Terminate(ctx) }()
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("dsn: %v", err)
	}

	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add key: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})

	cfg := config{
		databaseURL: dsn,
		leaseName:   "signer-leader",
		holderID:    "a",
		leaseTTL:    15 * time.Second,
		renewEvery:  50 * time.Millisecond,
	}
	h, cleanup, err := buildHandler(ctx, cfg, ks, policies)
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	defer cleanup()
	srv := httptest.NewServer(h)
	defer srv.Close()

	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	sign := func() (int, uint64) {
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		var out struct {
			Nonce uint64 `json:"nonce"`
		}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out.Nonce
	}

	// Poll until the background leader has acquired the lease (503 → 200). This
	// exercises the whole stack: pgxpool + both schemas + PgWriter.Authorize (real
	// Postgres single-writer) + PgStore lease + leader.Run + fence + nonce.
	var n1 uint64
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, n := sign()
		if code == 200 {
			n1 = n
			break
		}
		if code != 503 {
			t.Fatalf("unexpected sign status %d before leadership", code)
		}
		if time.Now().After(deadline) {
			t.Fatal("leader did not acquire within timeout")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A second sign advances the persisted nonce high-water strictly.
	code, n2 := sign()
	if code != 200 {
		t.Fatalf("second sign status = %d, want 200", code)
	}
	if n2 <= n1 {
		t.Fatalf("nonce n2=%d not > n1=%d (single-writer must advance)", n2, n1)
	}
}
