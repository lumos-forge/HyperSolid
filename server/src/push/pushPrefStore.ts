import Database from "better-sqlite3";

export type PushCategory = "fills" | "alerts" | "lifecycle";

export interface PushPrefs {
  fills: boolean;
  alerts: boolean;
  lifecycle: boolean;
}

export interface PushPrefStore {
  /** Effective on/off for one category; an absent row defaults to true (on). */
  isEnabled(owner: string, category: PushCategory): boolean;
  /** Effective prefs for every category (absent → true). */
  get(owner: string): PushPrefs;
  /** Upsert only the provided categories. */
  set(owner: string, prefs: Partial<PushPrefs>, now: number): void;
}

const CATEGORIES: PushCategory[] = ["fills", "alerts", "lifecycle"];

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_prefs (
      owner TEXT NOT NULL,
      category TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner, category)
    );
  `);
}

/** Durable per-owner category preferences over SQLite. Owner match is case-insensitive.
 *  Missing rows default to enabled (notifications on). */
export class SqlitePushPrefStore implements PushPrefStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqlitePushPrefStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqlitePushPrefStore(db);
  }

  isEnabled(owner: string, category: PushCategory): boolean {
    const row = this.db
      .prepare(`SELECT enabled FROM push_prefs WHERE owner = ? AND category = ?`)
      .get(owner.toLowerCase(), category) as { enabled: number } | undefined;
    return row ? row.enabled !== 0 : true;
  }

  get(owner: string): PushPrefs {
    const rows = this.db
      .prepare(`SELECT category, enabled FROM push_prefs WHERE owner = ?`)
      .all(owner.toLowerCase()) as { category: string; enabled: number }[];
    const map = new Map(rows.map((r) => [r.category, r.enabled !== 0]));
    return {
      fills: map.get("fills") ?? true,
      alerts: map.get("alerts") ?? true,
      lifecycle: map.get("lifecycle") ?? true,
    };
  }

  set(owner: string, prefs: Partial<PushPrefs>, now: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO push_prefs (owner, category, enabled, updated_at)
       VALUES (@owner, @category, @enabled, @now)
       ON CONFLICT(owner, category) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    );
    const lower = owner.toLowerCase();
    for (const category of CATEGORIES) {
      const v = prefs[category];
      if (typeof v === "boolean") {
        stmt.run({ owner: lower, category, enabled: v ? 1 : 0, now });
      }
    }
  }
}
