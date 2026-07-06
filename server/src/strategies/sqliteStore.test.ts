import { mkdirSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { SqliteStrategyStore } from "./sqliteStore";
import type { TwapParams, TpslParams } from "./types";

describe("SqliteStrategyStore", () => {
  it("creates a dca strategy running at now with zeroed progress", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const s = store.create("0xO", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    expect(s).toMatchObject({ kind: "dca", status: "running", nextRunAt: 1000, filledTotalUsdc: 0, createdAt: 1000 });
    expect(store.list("0xo")).toHaveLength(1);
    store.close();
  });

  it("creates a twap strategy with slicesDone 0", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const p: TwapParams = { coin: "ETH", side: "sell", totalUsdc: 300, slices: 3, durationHours: 3 };
    const s = store.create("0xO", "twap", p);
    expect(s).toMatchObject({ kind: "twap", slicesDone: 0, filledTotalUsdc: 0, nextRunAt: 1000 });
    store.close();
  });

  it("creates a tpsl strategy with no schedule", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const p: TpslParams = { coin: "SOL", stopLossPrice: 100 };
    const s = store.create("0xO", "tpsl", p);
    expect(s.kind).toBe("tpsl");
    expect(s.nextRunAt).toBeUndefined();
    store.close();
  });

  it("recordFill advances twap slicesDone and completes on the final slice", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const s = store.create("0xO", "twap", { coin: "ETH", side: "buy", totalUsdc: 200, slices: 2, durationHours: 2 });
    store.recordFill(s.id, 100, 2000);
    expect(store.get(s.id)).toMatchObject({ slicesDone: 1, filledTotalUsdc: 100, status: "running", nextRunAt: 2000 });
    store.recordFill(s.id, 100, 3000);
    expect(store.get(s.id)).toMatchObject({ slicesDone: 2, status: "completed" });
    store.close();
  });

  it("recordTrigger marks a tpsl completed with triggeredAt", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const s = store.create("0xO", "tpsl", { coin: "SOL", takeProfitPrice: 200 });
    store.recordTrigger(s.id, 4242);
    expect(store.get(s.id)).toMatchObject({ status: "completed", triggeredAt: 4242 });
    store.close();
  });

  it("migrates a legacy dca-only table by adding kind/created_at/slices_done/triggered_at", () => {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE strategies (id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, params TEXT NOT NULL, next_run_at INTEGER NOT NULL, filled_total_usdc REAL NOT NULL);`);
    db.prepare("INSERT INTO strategies VALUES (?,?,?,?,?,?)").run("old1", "0xo", "running", JSON.stringify({ coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 }), 0, 0);
    const cols = db.prepare("PRAGMA table_info(strategies)").all().map((c: { name: string }) => c.name);
    expect(cols).not.toContain("kind");
    const store = SqliteStrategyStore.fromDb(db, () => 1000);
    const s = store.get("old1");
    expect(s?.kind).toBe("dca");
    store.close();
  });

  it("persists strategies + fills across a reopen (durable recovery)", () => {
    const dir = join(process.cwd(), `.jest-sqlite-${randomUUID()}`);
    const file = join(dir, "strategies.db");
    mkdirSync(dir);
    try {
      const first = SqliteStrategyStore.open(file, () => 1000);
      const s = first.create("0xo", "dca", { coin: "ETH", side: "buy", quoteAmountUsdc: 25, intervalHours: 12 });
      first.recordFill(s.id, 25, 50000);
      first.close();

      const reopened = SqliteStrategyStore.open(file, () => 2000);
      const recovered = reopened.get(s.id)!;
      expect(recovered.owner).toBe("0xo");
      expect(recovered.params).toEqual({ coin: "ETH", side: "buy", quoteAmountUsdc: 25, intervalHours: 12 });
      expect(recovered.filledTotalUsdc).toBe(25);
      expect(recovered.nextRunAt).toBe(50000);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sqlite grid state", () => {
  const params = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("round-trips a grid with seed + record", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 0);
    const s = store.create("0xO", "grid", params);
    expect(store.get(s.id)).toMatchObject({ kind: "grid", actionsDone: 0, filledTotalUsdc: 0 });
    expect(store.get(s.id)!.lastLevel).toBeUndefined();

    store.seedGridLevel(s.id, 3);
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 0 });

    store.recordGridAction(s.id, 2, 100);
    store.recordGridAction(s.id, 4, 0);
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 2, filledTotalUsdc: 100 });
    store.close();
  });
});

describe("gridLimit persistence (sqlite)", () => {
  it("creates a gridLimit strategy, upserts rungs, accumulates filled, cascades delete", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 0);
    const s = store.create("0xo", "gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    expect(store.get(s.id)!.kind).toBe("gridLimit");
    expect(store.gridLimitRungs(s.id)).toEqual([]);

    store.setGridLimitRung(s.id, { rung: 1, state: "armed", side: "buy", cloid: "0xa", px: 120, seq: 1 });
    store.setGridLimitRung(s.id, { rung: 1, state: "holding", side: "sell", cloid: "0xb", px: 140, seq: 2 });
    store.setGridLimitRung(s.id, { rung: 3, state: "armed", side: "buy", cloid: "0xc", px: 160, seq: 1 });
    expect(store.gridLimitRungs(s.id)).toEqual([
      { rung: 1, state: "holding", side: "sell", cloid: "0xb", px: 140, seq: 2 },
      { rung: 3, state: "armed", side: "buy", cloid: "0xc", px: 160, seq: 1 },
    ]);

    store.addFilledUsdc(s.id, 7);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(7);

    store.remove(s.id);
    expect(store.gridLimitRungs(s.id)).toEqual([]);
    store.close();
  });
});
