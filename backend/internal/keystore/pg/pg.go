package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
)

// Vault is a Postgres-backed keystore.Vault storing AES-256-GCM-sealed agent keys.
type Vault struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Vault { return &Vault{pool: pool} }

func (v *Vault) Put(ctx context.Context, r keystore.Record) error {
	_, err := v.pool.Exec(ctx,
		`INSERT INTO agent_keys (key_id, agent_address, enc_priv) VALUES ($1,$2,$3)
		 ON CONFLICT (key_id) DO UPDATE SET agent_address = EXCLUDED.agent_address, enc_priv = EXCLUDED.enc_priv`,
		r.KeyID, r.AgentAddress, r.EncPriv)
	return err
}

func (v *Vault) List(ctx context.Context) ([]keystore.Record, error) {
	rows, err := v.pool.Query(ctx, `SELECT key_id, agent_address, enc_priv FROM agent_keys`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []keystore.Record
	for rows.Next() {
		var r keystore.Record
		if err := rows.Scan(&r.KeyID, &r.AgentAddress, &r.EncPriv); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (v *Vault) Delete(ctx context.Context, keyID string) error {
	_, err := v.pool.Exec(ctx, `DELETE FROM agent_keys WHERE key_id = $1`, keyID)
	return err
}
