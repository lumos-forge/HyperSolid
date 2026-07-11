import Database from "better-sqlite3";

export interface PendingReceipt {
  receiptId: string;
  token: string;
}

export interface PushReceiptStore {
  /** Remember a receipt id → token (idempotent by receipt_id). */
  record(receiptId: string, token: string, now: number): void;
  /** Oldest-first pending receipts, up to `limit`. */
  pending(limit: number): PendingReceipt[];
  /** Delete the given receipt rows (processed). No-op on empty. */
  remove(receiptIds: string[]): void;
  /** Delete receipt rows created before cutoffMs (never got a receipt). */
  pruneOlderThan(cutoffMs: number): void;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_receipts (
      receipt_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_receipts_created ON push_receipts(created_at);
  `);
}

/** Durable receipt-id → token registry for delayed Expo receipt polling. */
export class SqlitePushReceiptStore implements PushReceiptStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqlitePushReceiptStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqlitePushReceiptStore(db);
  }

  record(receiptId: string, token: string, now: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO push_receipts (receipt_id, token, created_at) VALUES (?, ?, ?)`)
      .run(receiptId, token, now);
  }

  pending(limit: number): PendingReceipt[] {
    const rows = this.db
      .prepare(`SELECT receipt_id, token FROM push_receipts ORDER BY created_at ASC LIMIT ?`)
      .all(limit) as { receipt_id: string; token: string }[];
    return rows.map((r) => ({ receiptId: r.receipt_id, token: r.token }));
  }

  remove(receiptIds: string[]): void {
    if (receiptIds.length === 0) return;
    const placeholders = receiptIds.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM push_receipts WHERE receipt_id IN (${placeholders})`).run(...receiptIds);
  }

  pruneOlderThan(cutoffMs: number): void {
    this.db.prepare(`DELETE FROM push_receipts WHERE created_at < ?`).run(cutoffMs);
  }
}
