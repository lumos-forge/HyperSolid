import Database from "better-sqlite3";
import { randomUUID } from "crypto";

/** A recorded strategy fill. The App sees the DTO subset `{ id, time, coin, side, sz, px }`. */
export interface Activity {
  id: string;
  strategyId: string;
  owner: string;
  time: number;
  coin: string;
  side: string;
  sz: number;
  px: number;
}

/** Append-only activity log; `record` assigns the id, `list` is newest-first and owner-scoped. */
export interface ActivityStore {
  record(a: Omit<Activity, "id">): Activity;
  list(owner: string, strategyId: string): Activity[];
  /** Sum of `sz*px` notional for an owner across all strategies since `sinceMs` (inclusive). */
  notionalSince(owner: string, sinceMs: number): number;
}

export class MemoryActivityStore implements ActivityStore {
  private rows: Activity[] = [];
  record(a: Omit<Activity, "id">): Activity {
    const row: Activity = { id: randomUUID(), ...a, owner: a.owner.toLowerCase() };
    this.rows.push(row);
    return row;
  }
  list(owner: string, strategyId: string): Activity[] {
    return this.rows
      .filter((r) => r.owner === owner.toLowerCase() && r.strategyId === strategyId)
      .sort((x, y) => y.time - x.time);
  }
  notionalSince(owner: string, sinceMs: number): number {
    return this.rows
      .filter((r) => r.owner === owner.toLowerCase() && r.time >= sinceMs)
      .reduce((sum, r) => sum + r.sz * r.px, 0);
  }
}

interface Row {
  id: string;
  strategy_id: string;
  owner: string;
  time: number;
  coin: string;
  side: string;
  sz: number;
  px: number;
}

export class SqliteActivityStore implements ActivityStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqliteActivityStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        time INTEGER NOT NULL,
        coin TEXT NOT NULL,
        side TEXT NOT NULL,
        sz REAL NOT NULL,
        px REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_lookup ON activity(owner, strategy_id, time);
    `);
    return new SqliteActivityStore(db);
  }

  record(a: Omit<Activity, "id">): Activity {
    const row: Activity = { id: randomUUID(), ...a, owner: a.owner.toLowerCase() };
    this.db
      .prepare("INSERT INTO activity (id, strategy_id, owner, time, coin, side, sz, px) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.strategyId, row.owner, row.time, row.coin, row.side, row.sz, row.px);
    return row;
  }

  list(owner: string, strategyId: string): Activity[] {
    const rows = this.db
      .prepare("SELECT * FROM activity WHERE owner = ? AND strategy_id = ? ORDER BY time DESC")
      .all(owner.toLowerCase(), strategyId) as Row[];
    return rows.map((r) => ({
      id: r.id,
      strategyId: r.strategy_id,
      owner: r.owner,
      time: r.time,
      coin: r.coin,
      side: r.side,
      sz: r.sz,
      px: r.px,
    }));
  }

  notionalSince(owner: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(sz * px), 0) AS total FROM activity WHERE owner = ? AND time >= ?")
      .get(owner.toLowerCase(), sinceMs) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}
