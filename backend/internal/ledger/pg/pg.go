// Package pg is a Postgres-backed ledger.Authorizer: it runs ledger.Decide inside
// a row-locked transaction that atomically manages BOTH the single-writer state
// (sw_state: fence + daily cap + nonce high-water) and the cloid intent ledger
// (ledger_intents), so cloid-idempotent authorization is atomic and durable
// across processes and hosts (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package pg

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// Store is a Postgres-backed ledger.Authorizer.
type Store struct{ pool *pgxpool.Pool }

// New returns a Store over the given pool. Run EnsureSchema once at startup
// before serving.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

const (
	// sw_state SQL (schema owned by singlewriter/pg; re-declared here because this
	// store drives the same rows inside its own transaction alongside ledger_intents).
	swSeedSQL   = `INSERT INTO sw_state (key_id, fence, last_nonce, spend_day, spend_total) VALUES ($1, 0, 0, 0, 0) ON CONFLICT (key_id) DO NOTHING`
	swSelectSQL = `SELECT fence, last_nonce, spend_day, spend_total FROM sw_state WHERE key_id = $1 FOR UPDATE`
	swUpdateSQL = `UPDATE sw_state SET fence = $2, last_nonce = $3, spend_day = $4, spend_total = $5 WHERE key_id = $1`

	recSelectSQL = `SELECT nonce, digest, status FROM ledger_intents WHERE key_id = $1 AND cloid = $2`
	recInsertSQL = `INSERT INTO ledger_intents (key_id, cloid, nonce, digest, status, notional) VALUES ($1, $2, $3, $4, $5, $6)`
)

// Authorize runs ledger.Decide inside one READ COMMITTED transaction: it seeds a
// zero sw_state row, locks it FOR UPDATE (per-key mutual exclusion across
// transactions — this also serializes the cloid read), loads the (key,cloid)
// record if any, applies Decide, and either COMMITs the new sw_state + a new
// ledger_intents row, returns the replayed grant unchanged (Duplicate), or rolls
// back on a typed rejection. Infra errors are wrapped (5xx) to distinguish them
// from typed policy rejections (4xx).
func (s *Store) Authorize(ctx context.Context, r ledger.Request) (ledger.Grant, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: begin: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit; undoes the seed on any reject/error

	if _, err := tx.Exec(ctx, swSeedSQL, r.KeyID); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: seed: %w", err)
	}

	var fence, lastNonce, spendDay int64
	var spendTotal float64
	if err := tx.QueryRow(ctx, swSelectSQL, r.KeyID).Scan(&fence, &lastNonce, &spendDay, &spendTotal); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: sw select: %w", err)
	}
	sw := singlewriter.State{Fence: uint64(fence), LastNonce: uint64(lastNonce), SpendDay: spendDay, SpendTotal: spendTotal}

	var existing *ledger.Record
	var recNonce int64
	var recDigest []byte
	var recStatus string
	switch err := tx.QueryRow(ctx, recSelectSQL, r.KeyID, r.Cloid).Scan(&recNonce, &recDigest, &recStatus); {
	case err == nil:
		var d [32]byte
		copy(d[:], recDigest)
		existing = &ledger.Record{Nonce: uint64(recNonce), Digest: d, Status: recStatus}
	case errors.Is(err, pgx.ErrNoRows):
		existing = nil
	default:
		return ledger.Grant{}, fmt.Errorf("pg ledger: record select: %w", err)
	}

	nextSW, rec, grant, derr := ledger.Decide(sw, existing, r)
	if derr != nil {
		return ledger.Grant{}, derr // typed rejection; deferred Rollback undoes the seed
	}
	if grant.Duplicate {
		return grant, nil // idempotent replay: nothing to persist
	}

	if _, err := tx.Exec(ctx, swUpdateSQL, r.KeyID, int64(nextSW.Fence), int64(nextSW.LastNonce), nextSW.SpendDay, nextSW.SpendTotal); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: sw update: %w", err)
	}
	if _, err := tx.Exec(ctx, recInsertSQL, r.KeyID, r.Cloid, int64(rec.Nonce), rec.Digest[:], rec.Status, r.Notional); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: record insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: commit: %w", err)
	}
	return grant, nil
}

// compile-time assertion that Store satisfies the Authorizer interface.
var _ ledger.Authorizer = (*Store)(nil)
