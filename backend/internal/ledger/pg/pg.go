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

	addrSeedSQL   = `INSERT INTO addr_spend_state (address_key, spend_day, spend_total) VALUES ($1, 0, 0) ON CONFLICT (address_key) DO NOTHING`
	addrSelectSQL = `SELECT spend_day, spend_total FROM addr_spend_state WHERE address_key = $1 FOR UPDATE`
	addrUpdateSQL = `UPDATE addr_spend_state SET spend_day = $2, spend_total = $3 WHERE address_key = $1`

	recSelectSQL       = `SELECT nonce, digest, status FROM ledger_intents WHERE key_id = $1 AND cloid = $2`
	recInsertSQL       = `INSERT INTO ledger_intents (key_id, cloid, nonce, digest, status, notional) VALUES ($1, $2, $3, $4, $5, $6)`
	recStatusSelectSQL = `SELECT status FROM ledger_intents WHERE key_id = $1 AND cloid = $2 FOR UPDATE`
	recStatusUpdateSQL = `UPDATE ledger_intents SET status = $3, updated_at = now() WHERE key_id = $1 AND cloid = $2`
	orphansSQL         = `SELECT key_id, cloid, nonce, status, (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint FROM ledger_intents WHERE status NOT IN ('filled','rejected','canceled') AND updated_at < to_timestamp($1 / 1000.0)`
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
		existing = &ledger.Record{Nonce: uint64(recNonce), Digest: d, Status: ledger.Status(recStatus)}
	case errors.Is(err, pgx.ErrNoRows):
		existing = nil
	default:
		return ledger.Grant{}, fmt.Errorf("pg ledger: record select: %w", err)
	}

	addr := ledger.SpendState{}
	if r.AddressDailyCap > 0 {
		if _, err := tx.Exec(ctx, addrSeedSQL, r.AddressSpendKey); err != nil {
			return ledger.Grant{}, fmt.Errorf("pg ledger: addr seed: %w", err)
		}
		var addrDay int64
		var addrTotal float64
		if err := tx.QueryRow(ctx, addrSelectSQL, r.AddressSpendKey).Scan(&addrDay, &addrTotal); err != nil {
			return ledger.Grant{}, fmt.Errorf("pg ledger: addr select: %w", err)
		}
		addr = ledger.SpendState{SpendDay: addrDay, SpendTotal: addrTotal}
	}

	nextSW, nextAddr, rec, grant, derr := ledger.Decide(sw, addr, existing, r)
	if derr != nil {
		return ledger.Grant{}, derr // typed rejection; deferred Rollback undoes the seed
	}
	if grant.Duplicate {
		return grant, nil // idempotent replay: nothing to persist
	}

	if _, err := tx.Exec(ctx, swUpdateSQL, r.KeyID, int64(nextSW.Fence), int64(nextSW.LastNonce), nextSW.SpendDay, nextSW.SpendTotal); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: sw update: %w", err)
	}
	if r.AddressDailyCap > 0 {
		if _, err := tx.Exec(ctx, addrUpdateSQL, r.AddressSpendKey, nextAddr.SpendDay, nextAddr.SpendTotal); err != nil {
			return ledger.Grant{}, fmt.Errorf("pg ledger: addr update: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, recInsertSQL, r.KeyID, r.Cloid, int64(rec.Nonce), rec.Digest[:], rec.Status, r.Notional); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: record insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: commit: %w", err)
	}
	return grant, nil
}

// Reconcile validates and persists the lifecycle transition for (keyID, cloid)
// inside one row-locked transaction. Unknown intent → ErrUnknownIntent; a
// disallowed edge → ErrInvalidTransition (rolled back); success updates status +
// updated_at. Infra errors are wrapped (5xx) vs typed rejections (4xx).
func (s *Store) Reconcile(ctx context.Context, keyID, cloid string, target ledger.Status) (ledger.Status, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return "", fmt.Errorf("pg ledger: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var cur string
	switch err := tx.QueryRow(ctx, recStatusSelectSQL, keyID, cloid).Scan(&cur); {
	case errors.Is(err, pgx.ErrNoRows):
		return "", ledger.ErrUnknownIntent
	case err != nil:
		return "", fmt.Errorf("pg ledger: reconcile select: %w", err)
	}

	next, derr := ledger.Transition(ledger.Status(cur), target)
	if derr != nil {
		return ledger.Status(cur), derr // typed rejection; deferred Rollback
	}
	if _, err := tx.Exec(ctx, recStatusUpdateSQL, keyID, cloid, string(next)); err != nil {
		return "", fmt.Errorf("pg ledger: reconcile update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("pg ledger: reconcile commit: %w", err)
	}
	return next, nil
}

// Orphans returns every non-terminal record whose updated_at is older than the
// olderThanMs cutoff (unix ms).
func (s *Store) Orphans(ctx context.Context, olderThanMs int64) ([]ledger.Orphan, error) {
	rows, err := s.pool.Query(ctx, orphansSQL, olderThanMs)
	if err != nil {
		return nil, fmt.Errorf("pg ledger: orphans query: %w", err)
	}
	defer rows.Close()
	var out []ledger.Orphan
	for rows.Next() {
		var keyID, cloid, status string
		var nonce, updatedAtMs int64
		if err := rows.Scan(&keyID, &cloid, &nonce, &status, &updatedAtMs); err != nil {
			return nil, fmt.Errorf("pg ledger: orphans scan: %w", err)
		}
		out = append(out, ledger.Orphan{KeyID: keyID, Cloid: cloid, Nonce: uint64(nonce), Status: ledger.Status(status), UpdatedAtMs: updatedAtMs})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pg ledger: orphans rows: %w", err)
	}
	return out, nil
}

// compile-time assertion that Store satisfies the Ledger interface.
var _ ledger.Ledger = (*Store)(nil)
