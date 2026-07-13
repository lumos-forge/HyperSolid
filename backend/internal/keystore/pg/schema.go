package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

const createSchemaSQL = `CREATE TABLE IF NOT EXISTS agent_keys (
	key_id        text PRIMARY KEY,
	agent_address text NOT NULL,
	enc_priv      bytea NOT NULL,
	created_at    timestamptz NOT NULL DEFAULT now()
)`

// EnsureSchema idempotently creates the agent_keys table.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, createSchemaSQL)
	return err
}
