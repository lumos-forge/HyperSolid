import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { StrategyStore } from "./store";
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, TwapParams, GridParams } from "./types";

interface Row {
  id: string; owner: string; status: string; params: string;
  kind: string; next_run_at: number; filled_total_usdc: number;
  slices_done: number; triggered_at: number | null; created_at: number;
  last_level: number | null; actions_done: number;
}

function toStrategy(row: Row): Strategy {
  const base = { id: row.id, owner: row.owner, status: row.status as StrategyStatus, createdAt: row.created_at };
  const params = JSON.parse(row.params);
  if (row.kind === "twap") return { ...base, kind: "twap", params, nextRunAt: row.next_run_at, filledTotalUsdc: row.filled_total_usdc, slicesDone: row.slices_done };
  if (row.kind === "tpsl") return { ...base, kind: "tpsl", params, triggeredAt: row.triggered_at ?? undefined };
  if (row.kind === "grid") return { ...base, kind: "grid", params, filledTotalUsdc: row.filled_total_usdc, actionsDone: row.actions_done, lastLevel: row.last_level ?? undefined };
  return { ...base, kind: "dca", params, nextRunAt: row.next_run_at, filledTotalUsdc: row.filled_total_usdc };
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, params TEXT NOT NULL,
      next_run_at INTEGER NOT NULL, filled_total_usdc REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS strategies_owner ON strategies(owner);
  `);
  const cols = new Set((db.prepare("PRAGMA table_info(strategies)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("kind")) db.exec("ALTER TABLE strategies ADD COLUMN kind TEXT NOT NULL DEFAULT 'dca'");
  if (!cols.has("slices_done")) db.exec("ALTER TABLE strategies ADD COLUMN slices_done INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("triggered_at")) db.exec("ALTER TABLE strategies ADD COLUMN triggered_at INTEGER");
  if (!cols.has("created_at")) db.exec("ALTER TABLE strategies ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("last_level")) db.exec("ALTER TABLE strategies ADD COLUMN last_level INTEGER");
  if (!cols.has("actions_done")) db.exec("ALTER TABLE strategies ADD COLUMN actions_done INTEGER NOT NULL DEFAULT 0");
}

/** Durable `StrategyStore` over SQLite. Owner matching is case-insensitive. */
export class SqliteStrategyStore implements StrategyStore {
  private constructor(private db: Database.Database, private now: () => number) {}

  static open(path: string, now: () => number = () => Date.now()): SqliteStrategyStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqliteStrategyStore(db, now);
  }
  /** For tests: adopt an existing db handle (also runs the migration). */
  static fromDb(db: Database.Database, now: () => number = () => Date.now()): SqliteStrategyStore {
    migrate(db);
    return new SqliteStrategyStore(db, now);
  }

  create(owner: string, kind: StrategyKind, params: StrategyParams): Strategy {
    const now = this.now();
    const id = randomUUID();
    const scheduled = kind === "tpsl" || kind === "grid" ? 0 : now;
    this.db
      .prepare(
        "INSERT INTO strategies (id, owner, status, params, kind, next_run_at, filled_total_usdc, slices_done, triggered_at, created_at, last_level, actions_done) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, owner.toLowerCase(), "running", JSON.stringify(params), kind, scheduled, 0, 0, null, now, null, 0);
    return this.get(id)!;
  }
  get(id: string): Strategy | undefined {
    const row = this.db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as Row | undefined;
    return row ? toStrategy(row) : undefined;
  }
  list(owner: string): Strategy[] {
    return (this.db.prepare("SELECT * FROM strategies WHERE owner = ?").all(owner.toLowerCase()) as Row[]).map(toStrategy);
  }
  listAll(): Strategy[] { return (this.db.prepare("SELECT * FROM strategies").all() as Row[]).map(toStrategy); }
  setStatus(id: string, status: StrategyStatus): void {
    this.db.prepare("UPDATE strategies SET status = ? WHERE id = ?").run(status, id);
  }
  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void {
    const row = this.db.prepare("SELECT kind, params, slices_done FROM strategies WHERE id = ?").get(id) as
      | { kind: string; params: string; slices_done: number } | undefined;
    if (!row) return;
    this.db.prepare("UPDATE strategies SET filled_total_usdc = filled_total_usdc + ?, next_run_at = ? WHERE id = ?").run(quoteUsdc, nextRunAt, id);
    if (row.kind === "twap") {
      const done = row.slices_done + 1;
      const slices = (JSON.parse(row.params) as TwapParams).slices;
      this.db.prepare("UPDATE strategies SET slices_done = ? WHERE id = ?").run(done, id);
      if (done >= slices) this.db.prepare("UPDATE strategies SET status = 'completed' WHERE id = ?").run(id);
    }
  }
  recordTrigger(id: string, now: number): void {
    this.db.prepare("UPDATE strategies SET triggered_at = ?, status = 'completed' WHERE id = ?").run(now, id);
  }
  seedGridLevel(id: string, level: number): void {
    this.db.prepare("UPDATE strategies SET last_level = ? WHERE id = ?").run(level, id);
  }

  recordGridAction(id: string, newLevel: number, boughtUsdc: number): void {
    this.db
      .prepare("UPDATE strategies SET last_level = ?, actions_done = actions_done + 1, filled_total_usdc = filled_total_usdc + ? WHERE id = ?")
      .run(newLevel, boughtUsdc, id);
  }
  remove(id: string): void { this.db.prepare("DELETE FROM strategies WHERE id = ?").run(id); }
  close(): void { this.db.close(); }
}
