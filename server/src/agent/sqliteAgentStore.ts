import Database from "better-sqlite3";
import type { AgentRecord, AgentStore } from "./agentManager";
import { open, seal } from "./secretBox";

interface Row {
  owner: string;
  agent_address: string;
  enc_private_key: string;
  key_id: string | null;
  approved: number;
  valid_until: number | null;
}

/**
 * Durable `AgentStore` over SQLite. Supports **dual custody**: legacy records hold the trade-only
 * private key **encrypted at rest** (AES-256-GCM via secretBox); delegated records hold only a signer
 * `key_id` (custody lives in the Go signer) with an empty `enc_private_key`. Agents survive restarts so
 * the scheduler keeps trading after a reboot without re-approval; any raw key only ever exists decrypted
 * in memory. Owner matching is case-insensitive.
 */
export class SqliteAgentStore implements AgentStore {
  private constructor(
    private db: Database.Database,
    private encKey: Buffer,
  ) {}

  static open(path: string, encKey: Buffer): SqliteAgentStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        owner TEXT PRIMARY KEY,
        agent_address TEXT NOT NULL,
        enc_private_key TEXT NOT NULL,
        approved INTEGER NOT NULL,
        valid_until INTEGER
      );
    `);
    // Dual-custody migration: add key_id for signer-custody records. Guarded so it's idempotent and
    // safe on pre-existing DBs (SQLite can't ADD COLUMN IF NOT EXISTS).
    const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "key_id")) {
      db.exec("ALTER TABLE agents ADD COLUMN key_id TEXT");
    }
    return new SqliteAgentStore(db, encKey);
  }

  get(owner: string): AgentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE owner = ?").get(owner.toLowerCase()) as Row | undefined;
    if (!row) return undefined;
    return {
      owner: row.owner,
      agentAddress: row.agent_address,
      privateKey: row.enc_private_key ? (open(row.enc_private_key, this.encKey) as `0x${string}`) : undefined,
      keyId: row.key_id ?? undefined,
      approved: row.approved === 1,
      validUntil: row.valid_until ?? undefined,
    };
  }

  set(rec: AgentRecord): void {
    this.db
      .prepare(
        `INSERT INTO agents (owner, agent_address, enc_private_key, key_id, approved, valid_until)
         VALUES (@owner, @agentAddress, @enc, @keyId, @approved, @validUntil)
         ON CONFLICT(owner) DO UPDATE SET
           agent_address = excluded.agent_address,
           enc_private_key = excluded.enc_private_key,
           key_id = excluded.key_id,
           approved = excluded.approved,
           valid_until = excluded.valid_until`,
      )
      .run({
        owner: rec.owner.toLowerCase(),
        agentAddress: rec.agentAddress,
        enc: rec.privateKey ? seal(rec.privateKey, this.encKey) : "",
        keyId: rec.keyId ?? null,
        approved: rec.approved ? 1 : 0,
        validUntil: rec.validUntil ?? null,
      });
  }

  remove(owner: string): void {
    this.db.prepare("DELETE FROM agents WHERE owner = ?").run(owner.toLowerCase());
  }

  close(): void {
    this.db.close();
  }
}
