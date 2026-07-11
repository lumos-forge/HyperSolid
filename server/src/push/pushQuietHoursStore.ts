import Database from "better-sqlite3";
import { isWithinQuietHours, type QuietHours } from "./pushQuietHours";

export interface QuietHoursStore {
  /** Absent row → { enabled:false, start:0, end:0, tz:"UTC" }. */
  get(owner: string): QuietHours;
  set(owner: string, qh: QuietHours, now: number): void;
  /** Effective suppression check now; false (send) on any error. */
  isQuietNow(owner: string, nowMs: number): boolean;
}

interface DbRow {
  enabled: number;
  start_min: number;
  end_min: number;
  tz: string;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_quiet_hours (
      owner TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      tz TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

const DEFAULT: QuietHours = { enabled: false, start: 0, end: 0, tz: "UTC" };

/** Durable per-owner quiet-hours config over SQLite. Owner match is case-insensitive.
 *  A missing row means "disabled" (never suppresses). */
export class SqliteQuietHoursStore implements QuietHoursStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqliteQuietHoursStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqliteQuietHoursStore(db);
  }

  get(owner: string): QuietHours {
    const row = this.db
      .prepare(`SELECT enabled, start_min, end_min, tz FROM push_quiet_hours WHERE owner = ?`)
      .get(owner.toLowerCase()) as DbRow | undefined;
    if (!row) return { ...DEFAULT };
    return { enabled: row.enabled !== 0, start: row.start_min, end: row.end_min, tz: row.tz };
  }

  set(owner: string, qh: QuietHours, now: number): void {
    this.db
      .prepare(
        `INSERT INTO push_quiet_hours (owner, enabled, start_min, end_min, tz, updated_at)
         VALUES (@owner, @enabled, @start, @end, @tz, @now)
         ON CONFLICT(owner) DO UPDATE SET
           enabled = excluded.enabled,
           start_min = excluded.start_min,
           end_min = excluded.end_min,
           tz = excluded.tz,
           updated_at = excluded.updated_at`,
      )
      .run({ owner: owner.toLowerCase(), enabled: qh.enabled ? 1 : 0, start: qh.start, end: qh.end, tz: qh.tz, now });
  }

  isQuietNow(owner: string, nowMs: number): boolean {
    try {
      return isWithinQuietHours(this.get(owner), nowMs);
    } catch {
      return false; // fail-open
    }
  }
}
