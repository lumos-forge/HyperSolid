import Database from "better-sqlite3";

export interface PushTokenRow {
  token: string;
  owner: string;
  platform: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PushTokenStore {
  /** Upsert by token; on conflict rebind owner + refresh platform/updatedAt. */
  register(owner: string, token: string, platform: string | null, now: number): void;
  /** Delete only if the token belongs to owner. Returns true when a row was deleted. */
  unregister(owner: string, token: string): boolean;
  /** All tokens currently bound to owner (for P2 fan-out). */
  tokensForOwner(owner: string): PushTokenRow[];
  /** Unconditional delete by token (for P2 invalid-token pruning). */
  deleteToken(token: string): void;
}

interface DbRow {
  token: string;
  owner: string;
  platform: string | null;
  created_at: number;
  updated_at: number;
}

function toRow(r: DbRow): PushTokenRow {
  return { token: r.token, owner: r.owner, platform: r.platform, createdAt: r.created_at, updatedAt: r.updated_at };
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      platform TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_tokens_owner ON push_tokens(owner);
  `);
}

/** Durable PushTokenStore over SQLite. Owner matching is case-insensitive. */
export class SqlitePushTokenStore implements PushTokenStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqlitePushTokenStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqlitePushTokenStore(db);
  }

  register(owner: string, token: string, platform: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO push_tokens (token, owner, platform, created_at, updated_at)
         VALUES (@token, @owner, @platform, @now, @now)
         ON CONFLICT(token) DO UPDATE SET
           owner = excluded.owner,
           platform = excluded.platform,
           updated_at = excluded.updated_at`,
      )
      .run({ token, owner: owner.toLowerCase(), platform, now });
  }

  unregister(owner: string, token: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM push_tokens WHERE token = ? AND owner = ?`)
      .run(token, owner.toLowerCase());
    return info.changes > 0;
  }

  tokensForOwner(owner: string): PushTokenRow[] {
    const rows = this.db
      .prepare(`SELECT token, owner, platform, created_at, updated_at FROM push_tokens WHERE owner = ?`)
      .all(owner.toLowerCase()) as DbRow[];
    return rows.map(toRow);
  }

  deleteToken(token: string): void {
    this.db.prepare(`DELETE FROM push_tokens WHERE token = ?`).run(token);
  }
}
