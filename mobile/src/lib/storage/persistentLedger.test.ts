import { createPersistentLedger, scopeKey } from "./persistentLedger";
import type { SqlDb, SqlParam, SqlRow } from "./sqlDb";

class FakeSqlDb implements SqlDb {
  runCalls: { sql: string; params: SqlParam[] }[] = [];
  allResult: SqlRow[] = [];
  pragmaVersion = 1;
  exec() {}
  run(sql: string, params: SqlParam[] = []) {
    this.runCalls.push({ sql, params });
  }
  all<T extends SqlRow = SqlRow>(sql: string, _params: SqlParam[] = []): T[] {
    if (sql.includes("PRAGMA user_version")) return [{ user_version: this.pragmaVersion }] as unknown as T[];
    return this.allResult as T[];
  }
}

const row = (over: Partial<SqlRow>): SqlRow => ({
  scope: "0xabc:mainnet",
  cloid: "0x" + "1".repeat(32),
  coin: "BTC",
  side: "buy",
  size: 0.01,
  price: 60000,
  status: "open",
  attempts: 1,
  oid: 5,
  reason: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

describe("scopeKey", () => {
  it("lowercases the address and joins with network", () => {
    expect(scopeKey("0xABCdef", "testnet")).toBe("0xabcdef:testnet");
  });
});

describe("createPersistentLedger", () => {
  it("hydrates existing intents from the store into the ledger", () => {
    const db = new FakeSqlDb();
    db.allResult = [row({ cloid: "0x" + "2".repeat(32), status: "open" })];
    const ledger = createPersistentLedger(db, "0xAbc", "mainnet", { now: 1000 });
    expect(ledger.get("0x" + "2".repeat(32))?.status).toBe("open");
  });

  it("prunes old terminal intents on construction (retention)", () => {
    const db = new FakeSqlDb();
    db.allResult = [row({ cloid: "0x" + "3".repeat(32), status: "filled", updatedAt: 100 })];
    const ledger = createPersistentLedger(db, "0xAbc", "mainnet", { now: 10_000, maxAgeMs: 1000 });
    // updatedAt 100 < cutoff 9000 -> pruned from cache
    expect(ledger.get("0x" + "3".repeat(32))).toBeUndefined();
  });

  it("writes through to SQLite when the ledger opens a new intent", () => {
    const db = new FakeSqlDb();
    const ledger = createPersistentLedger(db, "0xAbc", "mainnet", { now: 1000 });
    const intent = ledger.open({ coin: "ETH", side: "sell", size: 1, price: 3000 });
    expect(db.runCalls.some((c) => /INSERT INTO intents/.test(c.sql))).toBe(true);
    expect(ledger.get(intent.cloid)).toBeDefined();
  });
});
