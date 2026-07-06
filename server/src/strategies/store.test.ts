import { MemoryStrategyStore } from "./store";
import type { TwapParams, TpslParams } from "./types";

describe("MemoryStrategyStore", () => {
  it("creates a dca strategy running at now with zeroed progress", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xO", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    expect(s).toMatchObject({ kind: "dca", status: "running", nextRunAt: 1000, filledTotalUsdc: 0, createdAt: 1000 });
  });

  it("creates a twap strategy with slicesDone 0", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const p: TwapParams = { coin: "ETH", side: "sell", totalUsdc: 300, slices: 3, durationHours: 3 };
    const s = store.create("0xO", "twap", p);
    expect(s).toMatchObject({ kind: "twap", slicesDone: 0, filledTotalUsdc: 0, nextRunAt: 1000 });
  });

  it("creates a tpsl strategy with no schedule", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const p: TpslParams = { coin: "SOL", stopLossPrice: 100 };
    const s = store.create("0xO", "tpsl", p);
    expect(s.kind).toBe("tpsl");
    expect(s.nextRunAt).toBeUndefined();
  });

  it("recordFill advances twap slicesDone and completes on the final slice", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xO", "twap", { coin: "ETH", side: "buy", totalUsdc: 200, slices: 2, durationHours: 2 });
    store.recordFill(s.id, 100, 2000);
    expect(store.get(s.id)).toMatchObject({ slicesDone: 1, filledTotalUsdc: 100, status: "running", nextRunAt: 2000 });
    store.recordFill(s.id, 100, 3000);
    expect(store.get(s.id)).toMatchObject({ slicesDone: 2, status: "completed" });
  });

  it("recordTrigger marks a tpsl completed with triggeredAt", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xO", "tpsl", { coin: "SOL", takeProfitPrice: 200 });
    store.recordTrigger(s.id, 4242);
    expect(store.get(s.id)).toMatchObject({ status: "completed", triggeredAt: 4242 });
  });

  it("lists case-insensitively, toggles status, and removes a strategy", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xO", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    expect(store.list("0xo")).toHaveLength(1);
    expect(store.list("0xother")).toHaveLength(0);

    store.setStatus(s.id, "paused");
    expect(store.get(s.id)!.status).toBe("paused");

    store.remove(s.id);
    expect(store.get(s.id)).toBeUndefined();
  });
});

describe("grid store state", () => {
  const params = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("creates a grid with actionsDone=0 and no lastLevel", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    expect(s).toMatchObject({ kind: "grid", status: "running", actionsDone: 0, filledTotalUsdc: 0 });
    expect(s.lastLevel).toBeUndefined();
  });

  it("seedGridLevel sets lastLevel without bumping actionsDone", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 3);
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 0 });
  });

  it("recordGridAction advances lastLevel/actionsDone and adds bought notional", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.recordGridAction(s.id, 2, 100); // a buy
    store.recordGridAction(s.id, 4, 0);   // a reduce-only sell adds no bought notional
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 2, filledTotalUsdc: 100 });
  });
});

describe("gridLimit rung state (memory)", () => {
  it("builds a gridLimit strategy and defaults to no rung rows", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    expect(s.kind).toBe("gridLimit");
    expect(s.filledTotalUsdc).toBe(0);
    expect(store.gridLimitRungs(s.id)).toEqual([]);
  });
  it("upserts a rung and reads it back; addFilledUsdc accumulates", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    store.setGridLimitRung(s.id, { rung: 2, state: "armed", side: "buy", cloid: "0xabc", px: 140, seq: 1 });
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xdef", px: 160, seq: 2 });
    expect(store.gridLimitRungs(s.id)).toEqual([{ rung: 2, state: "holding", side: "sell", cloid: "0xdef", px: 160, seq: 2 }]);
    store.addFilledUsdc(s.id, 10);
    store.addFilledUsdc(s.id, 5);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(15);
  });
});
