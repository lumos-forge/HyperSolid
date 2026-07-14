import Database from "better-sqlite3";
import { decideBudget, nextBudget, type DeadManBudget, type DeadManDecision, type OwnerBudget } from "./deadMan";

interface Row {
  day: number;
  count: number;
  armed_until: number;
}

/**
 * Durable `DeadManBudget` over SQLite: the per-owner `{day, count, armedUntil}` survives restarts, so a
 * crash-loop or frequent deploys cannot reset the 10/day counting-arm budget and exceed HL's real limit
 * (which would silently disable the dead-man switch). Shares the pure decision/transition logic with the
 * in-memory budget, so behavior is identical. One row per owner; day rollover is handled in the pure
 * functions, so no cleanup is needed. Owner is keyed as-is (no lowercasing), matching the in-memory budget.
 */
export class SqliteDeadManBudgetStore implements DeadManBudget {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqliteDeadManBudgetStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS dead_man_budget (
        owner TEXT PRIMARY KEY,
        day INTEGER NOT NULL,
        count INTEGER NOT NULL,
        armed_until INTEGER NOT NULL
      );
    `);
    return new SqliteDeadManBudgetStore(db);
  }

  private get(owner: string): OwnerBudget | undefined {
    const row = this.db
      .prepare("SELECT day, count, armed_until FROM dead_man_budget WHERE owner = ?")
      .get(owner) as Row | undefined;
    return row ? { day: row.day, count: row.count, armedUntil: row.armed_until } : undefined;
  }

  decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision {
    return decideBudget(this.get(owner), nowMs, ttlMs);
  }

  record(owner: string, nowMs: number, time: number, counts: boolean): void {
    const next = nextBudget(this.get(owner), nowMs, time, counts);
    this.db
      .prepare(
        `INSERT INTO dead_man_budget (owner, day, count, armed_until)
         VALUES (@owner, @day, @count, @armedUntil)
         ON CONFLICT(owner) DO UPDATE SET day = excluded.day, count = excluded.count, armed_until = excluded.armed_until`,
      )
      .run({ owner, day: next.day, count: next.count, armedUntil: next.armedUntil });
  }

  close(): void {
    this.db.close();
  }
}
