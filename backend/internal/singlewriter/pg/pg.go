// Package pg is a Postgres-backed singlewriter.Writer: it runs singlewriter.Decide
// inside a row-locked transaction so per-key authorization (fence + daily cap +
// nonce high-water) is atomic and durable across processes and hosts
// (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package pg

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// PgWriter is a Postgres-backed singlewriter.Writer.
type PgWriter struct{ pool *pgxpool.Pool }

// New returns a PgWriter over the given pool. Run EnsureSchema once at startup
// before serving.
func New(pool *pgxpool.Pool) *PgWriter { return &PgWriter{pool: pool} }

const (
	seedSQL   = `INSERT INTO sw_state (key_id, fence, last_nonce, spend_day, spend_total) VALUES ($1, 0, 0, 0, 0) ON CONFLICT (key_id) DO NOTHING`
	selectSQL = `SELECT fence, last_nonce, spend_day, spend_total FROM sw_state WHERE key_id = $1 FOR UPDATE`
	updateSQL = `UPDATE sw_state SET fence = $2, last_nonce = $3, spend_day = $4, spend_total = $5 WHERE key_id = $1`
)

// Authorize runs Decide inside a single row-locked transaction: it seeds a zero
// row, locks it FOR UPDATE (per-key mutual exclusion across transactions),
// applies Decide, and either COMMITs the new state or rolls back on a typed
// rejection (leaving no state change). Infrastructure errors are wrapped so the
// caller can distinguish them (5xx) from typed policy rejections (4xx).
func (w *PgWriter) Authorize(ctx context.Context, r singlewriter.Request) (singlewriter.Grant, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: begin: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after a successful Commit; undoes the seed on any reject/error

	if _, err := tx.Exec(ctx, seedSQL, r.KeyID); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: seed: %w", err)
	}

	var fence, lastNonce, spendDay int64
	var spendTotal float64
	if err := tx.QueryRow(ctx, selectSQL, r.KeyID).Scan(&fence, &lastNonce, &spendDay, &spendTotal); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: select: %w", err)
	}
	state := singlewriter.State{
		Fence:      uint64(fence),
		LastNonce:  uint64(lastNonce),
		SpendDay:   spendDay,
		SpendTotal: spendTotal,
	}

	next, grant, derr := singlewriter.Decide(state, r)
	if derr != nil {
		// Typed rejection: the deferred Rollback undoes the seed → no state change.
		return singlewriter.Grant{}, derr
	}

	if _, err := tx.Exec(ctx, updateSQL, r.KeyID, int64(next.Fence), int64(next.LastNonce), next.SpendDay, next.SpendTotal); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return singlewriter.Grant{}, fmt.Errorf("pg singlewriter: commit: %w", err)
	}
	return grant, nil
}

// compile-time assertion that PgWriter satisfies the Writer interface.
var _ singlewriter.Writer = (*PgWriter)(nil)
