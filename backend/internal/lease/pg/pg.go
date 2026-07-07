// Package pg is a Postgres-backed lease.Store: it evaluates lease.Decide inside a
// row-locked transaction using the DATABASE clock (now()) as the single time
// source, so instances cannot disagree about lease liveness
// (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package pg

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/lease"
)

// PgStore is a Postgres-backed lease.Store.
type PgStore struct{ pool *pgxpool.Pool }

// New returns a PgStore over the given pool. Run EnsureSchema once at startup.
func New(pool *pgxpool.Pool) *PgStore { return &PgStore{pool: pool} }

const (
	// seedSQL guarantees the row exists so SELECT … FOR UPDATE always has a row to
	// lock (race-free for brand-new names). The seed row is epoch 0 / expired.
	// Do NOT replace with a lazy SELECT-then-insert: that reintroduces a new-name race.
	seedSQL   = `INSERT INTO lease (name, holder, epoch, expires_at) VALUES ($1, '', 0, 0) ON CONFLICT (name) DO NOTHING`
	selectSQL = `SELECT holder, epoch, expires_at, (extract(epoch from now())*1000)::bigint FROM lease WHERE name = $1 FOR UPDATE`
	updateSQL = `UPDATE lease SET holder = $2, epoch = $3, expires_at = $4 WHERE name = $1`
)

func (s *PgStore) Acquire(ctx context.Context, name, holder string, ttl time.Duration) (lease.Lease, error) {
	return s.run(ctx, name, lease.OpAcquire, holder, ttl)
}

func (s *PgStore) Renew(ctx context.Context, name, holder string, ttl time.Duration) (lease.Lease, error) {
	return s.run(ctx, name, lease.OpRenew, holder, ttl)
}

func (s *PgStore) Release(ctx context.Context, name, holder string) error {
	_, err := s.run(ctx, name, lease.OpRelease, holder, 0)
	return err
}

// run executes one lease operation in a single row-locked READ COMMITTED
// transaction: seed the row, lock it FOR UPDATE, read the DB transaction-start
// clock now() in the same query (≤ real time — conservative for expiry), apply
// lease.Decide, then UPDATE+COMMIT (mutation) or COMMIT (no-op), or
// roll back on a typed rejection. Infra errors are wrapped.
func (s *PgStore) run(ctx context.Context, name string, op lease.Op, holder string, ttl time.Duration) (lease.Lease, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: begin: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit; undoes the seed on reject/error

	if _, err := tx.Exec(ctx, seedSQL, name); err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: seed: %w", err)
	}

	var curHolder string
	var epoch, expiresAt, nowMs int64
	if err := tx.QueryRow(ctx, selectSQL, name).Scan(&curHolder, &epoch, &expiresAt, &nowMs); err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: select: %w", err)
	}

	next, write, out, derr := lease.Decide(
		lease.Row{Holder: curHolder, Epoch: uint64(epoch), ExpiresAtMs: expiresAt},
		lease.Req{Op: op, Holder: holder, NowMs: nowMs, TtlMs: ttl.Milliseconds()},
	)
	if derr != nil {
		return lease.Lease{}, derr // typed rejection; deferred Rollback undoes the seed
	}
	if write {
		if _, err := tx.Exec(ctx, updateSQL, name, next.Holder, int64(next.Epoch), next.ExpiresAtMs); err != nil {
			return lease.Lease{}, fmt.Errorf("pg lease: update: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return lease.Lease{}, fmt.Errorf("pg lease: commit: %w", err)
	}
	out.Name = name
	return out, nil
}

// compile-time assertion that PgStore satisfies the Store interface.
var _ lease.Store = (*PgStore)(nil)
