import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { DcaParams, DcaStrategy } from "./dca";
import type { StrategyStore } from "./store";

interface Row {
  id: string;
  owner: string;
  status: string;
  params: string;
  next_run_at: number;
  filled_total_usdc: number;
}

function toStrategy(row: Row): DcaStrategy {
  return {
    id: row.id,
    owner: row.owner,
    status: row.status as "running" | "paused",
    params: JSON.parse(row.params) as DcaParams,
    nextRunAt: row.next_run_at,
    filledTotalUsdc: row.filled_total_usdc,
  };
}

/**
 * Durable `StrategyStore` over SQLite (better-sqlite3, synchronous). Strategy rows survive restarts,
 * so on reboot the scheduler simply re-evaluates persisted `nextRunAt`s; combined with the scheduler's
 * slot-deterministic cloid, an interrupted tick re-fires the SAME cloid (HL dedupes) — durable recovery
 * without a separate pending-cloid ledger. Owner matching is case-insensitive.
 */
export class SqliteStrategyStore implements StrategyStore {
  private constructor(
    private db: Database.Database,
    private now: () => number,
  ) {}

  static open(path: string, now: () => number = () => Date.now()): SqliteStrategyStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        params TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        filled_total_usdc REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS strategies_owner ON strategies(owner);
    `);
    return new SqliteStrategyStore(db, now);
  }

  create(owner: string, params: DcaParams): DcaStrategy {
    const s: DcaStrategy = {
      id: randomUUID(),
      owner,
      status: "running",
      params,
      nextRunAt: this.now(),
      filledTotalUsdc: 0,
    };
    this.db
      .prepare(
        "INSERT INTO strategies (id, owner, status, params, next_run_at, filled_total_usdc) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(s.id, s.owner.toLowerCase(), s.status, JSON.stringify(s.params), s.nextRunAt, s.filledTotalUsdc);
    return s;
  }

  get(id: string): DcaStrategy | undefined {
    const row = this.db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as Row | undefined;
    return row ? toStrategy(row) : undefined;
  }

  list(owner: string): DcaStrategy[] {
    const rows = this.db.prepare("SELECT * FROM strategies WHERE owner = ?").all(owner.toLowerCase()) as Row[];
    return rows.map(toStrategy);
  }

  listAll(): DcaStrategy[] {
    return (this.db.prepare("SELECT * FROM strategies").all() as Row[]).map(toStrategy);
  }

  setStatus(id: string, status: "running" | "paused"): void {
    this.db.prepare("UPDATE strategies SET status = ? WHERE id = ?").run(status, id);
  }

  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void {
    this.db
      .prepare("UPDATE strategies SET filled_total_usdc = filled_total_usdc + ?, next_run_at = ? WHERE id = ?")
      .run(quoteUsdc, nextRunAt, id);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
