import type { IntentStatus, IntentStore, OrderIntent } from "../hyperliquid/intentLedger";
import type { SqlDb, SqlRow } from "./sqlDb";

/** Bump when the `intents` table shape changes; add a migration branch below. */
export const INTENT_SCHEMA_VERSION = 1;

const TERMINAL: ReadonlySet<IntentStatus> = new Set(["filled", "rejected", "canceled"]);
const TERMINAL_SQL = "status IN ('filled', 'rejected', 'canceled')";

const UPSERT_SQL =
  "INSERT INTO intents " +
  "(scope, cloid, coin, side, size, price, status, attempts, oid, reason, createdAt, updatedAt) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(scope, cloid) DO UPDATE SET " +
  "coin = excluded.coin, side = excluded.side, size = excluded.size, price = excluded.price, " +
  "status = excluded.status, attempts = excluded.attempts, oid = excluded.oid, " +
  "reason = excluded.reason, updatedAt = excluded.updatedAt";

function migrate(db: SqlDb): void {
  const rows = db.all<{ user_version: number }>("PRAGMA user_version");
  const version = Number(rows[0]?.user_version ?? 0);
  if (version < 1) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS intents (
        scope TEXT NOT NULL,
        cloid TEXT NOT NULL,
        coin TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        price REAL NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        oid INTEGER,
        reason TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (scope, cloid)
      );
      CREATE INDEX IF NOT EXISTS idx_intents_scope_status ON intents(scope, status);
      CREATE INDEX IF NOT EXISTS idx_intents_scope_oid ON intents(scope, oid);
      PRAGMA user_version = ${INTENT_SCHEMA_VERSION};`,
    );
  }
}

function rowToIntent(r: SqlRow): OrderIntent {
  return {
    cloid: String(r.cloid) as `0x${string}`,
    coin: String(r.coin),
    side: r.side === "sell" ? "sell" : "buy",
    size: Number(r.size),
    price: Number(r.price),
    status: String(r.status) as IntentStatus,
    attempts: Number(r.attempts),
    oid: r.oid === null || r.oid === undefined ? undefined : Number(r.oid),
    reason: r.reason === null || r.reason === undefined ? undefined : String(r.reason),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  };
}

/**
 * Persistent IntentStore backed by SQLite (spec §6.2). In-memory cache serves the synchronous
 * IntentStore reads (get/values); writes are write-through to SQLite (per-row ACID UPSERT/DELETE).
 * Scoped by `address × network` so switching wallet/network never mixes intents.
 */
export class SqliteIntentStore implements IntentStore {
  private cache = new Map<string, OrderIntent>();

  constructor(
    private db: SqlDb,
    private scope: string,
  ) {
    migrate(db);
  }

  get(cloid: string): OrderIntent | undefined {
    return this.cache.get(cloid);
  }

  set(cloid: string, intent: OrderIntent): void {
    this.cache.set(cloid, intent);
    this.db.run(UPSERT_SQL, [
      this.scope,
      intent.cloid,
      intent.coin,
      intent.side,
      intent.size,
      intent.price,
      intent.status,
      intent.attempts,
      intent.oid ?? null,
      intent.reason ?? null,
      intent.createdAt,
      intent.updatedAt,
    ]);
  }

  delete(cloid: string): void {
    this.cache.delete(cloid);
    this.db.run("DELETE FROM intents WHERE scope = ? AND cloid = ?", [this.scope, cloid]);
  }

  values(): OrderIntent[] {
    return [...this.cache.values()];
  }

  /** Load this scope's persisted intents into the in-memory cache (startup hydration). */
  hydrate(): this {
    this.cache.clear();
    const rows = this.db.all("SELECT * FROM intents WHERE scope = ?", [this.scope]);
    for (const r of rows) {
      const intent = rowToIntent(r);
      this.cache.set(intent.cloid, intent);
    }
    return this;
  }

  /**
   * Retention cleanup (run at startup): delete terminal intents older than `maxAgeMs`, then cap the
   * terminal count to `maxRows` (newest kept). pending/submitted are never pruned. DB + cache stay
   * consistent. Non-terminal intents are always retained until reconciled.
   */
  prune(now: number, maxAgeMs: number, maxRows = 2000): void {
    const cutoff = now - maxAgeMs;
    // 1) age-based: terminal older than cutoff
    this.db.run(`DELETE FROM intents WHERE scope = ? AND ${TERMINAL_SQL} AND updatedAt < ?`, [
      this.scope,
      cutoff,
    ]);
    for (const [k, v] of this.cache) {
      if (TERMINAL.has(v.status) && v.updatedAt < cutoff) this.cache.delete(k);
    }
    // 2) count cap: keep newest `maxRows` terminal, drop the rest
    this.db.run(
      `DELETE FROM intents WHERE scope = ? AND ${TERMINAL_SQL} AND cloid NOT IN ` +
        `(SELECT cloid FROM intents WHERE scope = ? AND ${TERMINAL_SQL} ORDER BY updatedAt DESC LIMIT ?)`,
      [this.scope, this.scope, maxRows],
    );
    const terminal = [...this.cache.values()]
      .filter((i) => TERMINAL.has(i.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const i of terminal.slice(maxRows)) this.cache.delete(i.cloid);
  }
}
