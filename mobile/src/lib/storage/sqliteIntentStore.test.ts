import { SqliteIntentStore, INTENT_SCHEMA_VERSION } from "./sqliteIntentStore";
import type { SqlDb, SqlParam, SqlRow } from "./sqlDb";
import type { OrderIntent } from "../hyperliquid/intentLedger";

class FakeSqlDb implements SqlDb {
  execCalls: string[] = [];
  runCalls: { sql: string; params: SqlParam[] }[] = [];
  allResult: SqlRow[] = [];
  pragmaVersion = 0;
  exec(sql: string) {
    this.execCalls.push(sql);
  }
  run(sql: string, params: SqlParam[] = []) {
    this.runCalls.push({ sql, params });
  }
  all<T extends SqlRow = SqlRow>(sql: string, _params: SqlParam[] = []): T[] {
    if (sql.includes("PRAGMA user_version")) return [{ user_version: this.pragmaVersion }] as unknown as T[];
    return this.allResult as T[];
  }
}

const SCOPE = "0xabc:mainnet";
const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  cloid: ("0x" + "1".repeat(32)) as `0x${string}`,
  coin: "BTC",
  side: "buy",
  size: 0.01,
  price: 60000,
  status: "pending",
  attempts: 1,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

describe("SqliteIntentStore — schema/migration", () => {
  it("runs the v1 schema migration on construct when user_version < current", () => {
    const db = new FakeSqlDb();
    db.pragmaVersion = 0;
    new SqliteIntentStore(db, SCOPE);
    const ddl = db.execCalls.join("\n");
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS intents/);
    expect(ddl).toMatch(new RegExp(`PRAGMA user_version = ${INTENT_SCHEMA_VERSION}`));
  });

  it("skips migration when already at current version", () => {
    const db = new FakeSqlDb();
    db.pragmaVersion = INTENT_SCHEMA_VERSION;
    new SqliteIntentStore(db, SCOPE);
    expect(db.execCalls.join("\n")).not.toMatch(/CREATE TABLE/);
  });
});

describe("SqliteIntentStore — write-through CRUD", () => {
  it("set writes through (cache + scoped UPSERT) and get/values read from cache", () => {
    const db = new FakeSqlDb();
    const store = new SqliteIntentStore(db, SCOPE);
    const i = intent();
    store.set(i.cloid, i);

    expect(store.get(i.cloid)).toEqual(i);
    expect(store.values()).toHaveLength(1);

    const upsert = db.runCalls.find((c) => /INSERT INTO intents/.test(c.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toMatch(/ON CONFLICT\(scope, ?cloid\) DO UPDATE/);
    expect(upsert!.params[0]).toBe(SCOPE); // scope first
    expect(upsert!.params).toContain(i.cloid);
    expect(upsert!.params).toContain("pending");
  });

  it("maps optional oid/reason to NULL in params", () => {
    const db = new FakeSqlDb();
    const store = new SqliteIntentStore(db, SCOPE);
    store.set(intent().cloid, intent({ oid: undefined, reason: undefined }));
    const upsert = db.runCalls.find((c) => /INSERT INTO intents/.test(c.sql))!;
    expect(upsert.params).toContain(null);
  });

  it("delete removes from cache + issues a scoped DELETE", () => {
    const db = new FakeSqlDb();
    const store = new SqliteIntentStore(db, SCOPE);
    const i = intent();
    store.set(i.cloid, i);
    store.delete(i.cloid);

    expect(store.get(i.cloid)).toBeUndefined();
    const del = db.runCalls.find((c) => /DELETE FROM intents/.test(c.sql))!;
    expect(del.sql).toMatch(/WHERE scope = \? AND cloid = \?/);
    expect(del.params).toEqual([SCOPE, i.cloid]);
  });
});

describe("SqliteIntentStore — prune (retention)", () => {
  it("deletes terminal intents older than maxAgeMs (DB + cache), keeps pending + recent terminal", () => {
    const db = new FakeSqlDb();
    const store = new SqliteIntentStore(db, SCOPE);
    const cl = (n: string) => ("0x" + n.repeat(32)) as `0x${string}`;
    store.set(cl("1"), intent({ cloid: cl("1"), status: "pending", updatedAt: 1000 }));
    store.set(cl("2"), intent({ cloid: cl("2"), status: "filled", updatedAt: 100 })); // old terminal
    store.set(cl("3"), intent({ cloid: cl("3"), status: "filled", updatedAt: 900 })); // recent terminal
    db.runCalls.length = 0;

    store.prune(1000, 200); // cutoff = 800

    expect(store.get(cl("2"))).toBeUndefined(); // old terminal pruned
    expect(store.get(cl("1"))).toBeDefined(); // pending kept
    expect(store.get(cl("3"))).toBeDefined(); // recent terminal kept

    const ageDelete = db.runCalls.find((c) => /updatedAt < \?/.test(c.sql))!;
    expect(ageDelete.sql).toMatch(/status IN \('filled', ?'rejected', ?'canceled'\)/);
    expect(ageDelete.params).toEqual([SCOPE, 800]);
  });

  it("caps terminal count to maxRows (evicts oldest terminal beyond cap)", () => {
    const db = new FakeSqlDb();
    const store = new SqliteIntentStore(db, SCOPE);
    const cl = (n: string) => ("0x" + n.repeat(32)) as `0x${string}`;
    store.set(cl("a"), intent({ cloid: cl("a"), status: "filled", updatedAt: 100 }));
    store.set(cl("b"), intent({ cloid: cl("b"), status: "filled", updatedAt: 200 }));
    store.set(cl("c"), intent({ cloid: cl("c"), status: "filled", updatedAt: 300 }));

    store.prune(10_000, 10_000, 2); // no age pruning; cap to 2 newest terminal

    expect(store.get(cl("a"))).toBeUndefined(); // oldest dropped
    expect(store.get(cl("b"))).toBeDefined();
    expect(store.get(cl("c"))).toBeDefined();
    const capDelete = db.runCalls.find((c) => /ORDER BY updatedAt DESC LIMIT \?/.test(c.sql))!;
    expect(capDelete.params).toEqual([SCOPE, SCOPE, 2]);
  });
});

describe("SqliteIntentStore — hydrate (load scope into cache)", () => {
  it("loads this scope's rows and maps them to OrderIntent (null oid/reason -> undefined)", () => {
    const db = new FakeSqlDb();
    db.allResult = [
      {
        scope: SCOPE,
        cloid: "0x" + "2".repeat(32),
        coin: "ETH",
        side: "sell",
        size: 1,
        price: 3000,
        status: "open",
        attempts: 2,
        oid: 42,
        reason: null,
        createdAt: 100,
        updatedAt: 200,
      },
    ];
    const store = new SqliteIntentStore(db, SCOPE).hydrate();
    const i = store.get("0x" + "2".repeat(32));
    expect(i).toBeDefined();
    expect(i!.coin).toBe("ETH");
    expect(i!.side).toBe("sell");
    expect(i!.status).toBe("open");
    expect(i!.oid).toBe(42);
    expect(i!.reason).toBeUndefined();
    expect(store.values()).toHaveLength(1);
  });
});
