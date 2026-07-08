package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	swpg "github.com/lumos-forge/hypersolid/backend/internal/singlewriter/pg"
)

// createSchemaSQL is the DDL for the cloid intent ledger. nonce holds a uint64
// value stored as its int64 bit-pattern (the DB never does arithmetic on it; all
// logic is in ledger.Decide), so bigint round-trips the full uint64 domain.
const createSchemaSQL = `CREATE TABLE IF NOT EXISTS ledger_intents (
	key_id     text NOT NULL,
	cloid      text NOT NULL,
	nonce      bigint NOT NULL,
	digest     bytea NOT NULL,
	status     text NOT NULL,
	notional   double precision NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (key_id, cloid)
)`

// EnsureSchema idempotently creates both the single-writer state table (reused
// for the fence/cap/nonce authority) and the ledger_intents table, and ensures
// the reconciliation updated_at column exists. A dedicated migration tool
// (goose/migrate) is deferred to later M6 work.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	if err := swpg.EnsureSchema(ctx, pool); err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, createSchemaSQL); err != nil {
		return err
	}
	_, err := pool.Exec(ctx, `ALTER TABLE ledger_intents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`)
	return err
}
