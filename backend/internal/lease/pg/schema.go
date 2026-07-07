package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// createSchemaSQL is the single-table DDL for leases. expires_at is epoch ms
// (bigint) to match the pure Decide's int64-ms clock. epoch holds a uint64 as its
// int64 bit-pattern (the DB does no arithmetic on it).
const createSchemaSQL = `CREATE TABLE IF NOT EXISTS lease (
	name       text   PRIMARY KEY,
	holder     text   NOT NULL,
	epoch      bigint NOT NULL,
	expires_at bigint NOT NULL
)`

// EnsureSchema idempotently creates the lease table.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, createSchemaSQL)
	return err
}
