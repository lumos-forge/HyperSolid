import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import type { SqlDb, SqlParam, SqlRow } from "./sqlDb";

/**
 * Real {@link SqlDb} adapter over expo-sqlite's SYNCHRONOUS API (runSync/getAllSync/execSync).
 * NOTE: imports the expo-sqlite native module — must NOT be imported from jest tests (inject a fake
 * SqlDb there instead). The DB file lives in the app sandbox; at-rest protection comes from the iOS
 * default Data Protection entitlement set in app.json (NSFileProtectionCompleteUntilFirstUnlock,
 * applied by EAS builds).
 */
export function createSqlDb(dbName: string): SqlDb {
  const db: SQLiteDatabase = openDatabaseSync(dbName);
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, params: SqlParam[] = []) => {
      db.runSync(sql, params);
    },
    all: <T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []) =>
      db.getAllSync(sql, params) as T[],
  };
}
