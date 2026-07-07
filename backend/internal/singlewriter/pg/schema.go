package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// createSchemaSQL is the single-table DDL for the single-writer state. Columns
// fence/last_nonce hold uint64 values stored as their int64 bit-pattern (the DB
// never does arithmetic on them; all logic is in singlewriter.Decide), so bigint
// round-trips the full uint64 domain losslessly.
const createSchemaSQL = `CREATE TABLE IF NOT EXISTS sw_state (
	key_id      text PRIMARY KEY,
	fence       bigint NOT NULL,
	last_nonce  bigint NOT NULL,
	spend_day   bigint NOT NULL,
	spend_total double precision NOT NULL
)`

// EnsureSchema idempotently creates the sw_state table. A dedicated migration
// tool (goose/migrate) is deferred to the multi-table M6 ledger work.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, createSchemaSQL)
	return err
}
