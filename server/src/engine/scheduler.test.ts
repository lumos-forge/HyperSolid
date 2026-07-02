import { MemoryStrategyStore } from "../strategies/store";
import { MemoryActivityStore } from "../strategies/activityStore";
import { tick, cloidFor, type OrderPlacer, type PlaceRequest } from "./scheduler";

function placerFake(): OrderPlacer & { calls: PlaceRequest[] } {
  const calls: PlaceRequest[] = [];
  return {
    calls,
    async place(req) {
      calls.push(req);
      const filledUsdc = req.sizeUsdc ?? 0;
      return { ok: true, filledUsdc, filledSz: 0.001, avgPx: filledUsdc / 0.001 };
    },
  };
}

describe("scheduler tick", () => {
  const limits = { maxNotionalUsdc: 1000 };

  it("places one order per due strategy with the slot-deterministic cloid, then advances it", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xo", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const placer = placerFake();

    await tick(store, placer, limits, false, 2000);
    expect(placer.calls).toHaveLength(1);
    expect(placer.calls[0].cloid).toBe(cloidFor(s.id, 1000));
    expect(placer.calls[0]).toEqual(expect.objectContaining({ side: "buy", reduceOnly: false, sizeUsdc: 50 }));

    await tick(store, placer, limits, false, 2000);
    expect(placer.calls).toHaveLength(1);
  });

  it("places nothing when the kill-switch is on", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    store.create("0xo", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const placer = placerFake();
    await tick(store, placer, limits, true, 2000);
    expect(placer.calls).toHaveLength(0);
  });

  it("does not advance the strategy if the placer reports failure", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xo", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const failing: OrderPlacer = { async place() { return { ok: false }; } };
    await tick(store, failing, limits, false, 2000);
    expect(store.get(s.id)!.nextRunAt).toBe(1000);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(0);
  });

  it("records exactly one activity row per confirmed fill, and none on failure", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xo", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const activity = new MemoryActivityStore();

    await tick(store, placerFake(), limits, false, 2000, activity);
    const rows = activity.list("0xo", s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ coin: "BTC", side: "buy", sz: 0.001, px: 50000, time: 2000 });

    // a failing placement records nothing more
    const failing: OrderPlacer = { async place() { return { ok: false }; } };
    store.setStatus(s.id, "running");
    store.recordFill(s.id, 0, 1500); // make it due again without adding activity
    await tick(store, failing, limits, false, 2000, activity);
    expect(activity.list("0xo", s.id)).toHaveLength(1);
  });

  it("skips a strategy whose coin is over its per-coin cap while another coin still fires", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const btc = store.create("0xo", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 200, intervalHours: 24 });
    const eth = store.create("0xo", "dca", { coin: "ETH", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const placer = placerFake();

    await tick(store, placer, { maxNotionalUsdc: 1000, perCoinMaxNotionalUsdc: { BTC: 100 } }, false, 2000);

    // ETH fired (under global), BTC skipped (over its tighter per-coin cap)
    expect(placer.calls).toHaveLength(1);
    expect(store.get(eth.id)!.nextRunAt).toBeGreaterThan(1000);
    expect(store.get(btc.id)!.nextRunAt).toBe(1000);
  });

  it("enforces a per-owner daily spend cap, leaving other owners unaffected", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const a = store.create("0xo", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 60, intervalHours: 24 });
    const b = store.create("0xo", "dca", { coin: "ETH", side: "buy", quoteAmountUsdc: 60, intervalHours: 24 });
    const c = store.create("0xother", "dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 60, intervalHours: 24 });
    const placer = placerFake();
    const activity = new MemoryActivityStore();

    await tick(store, placer, { maxNotionalUsdc: 1000, dailyMaxNotionalUsdc: 100 }, false, 2000, activity);

    // owner 0xo: first 60 fires, second would push the day to 120 > 100 -> skipped. 0xother unaffected.
    expect(store.get(a.id)!.nextRunAt).toBeGreaterThan(1000);
    expect(store.get(b.id)!.nextRunAt).toBe(1000);
    expect(store.get(c.id)!.nextRunAt).toBeGreaterThan(1000);
    expect(placer.calls).toHaveLength(2);
  });

  it("places a TWAP slice, advances slicesDone, and completes on the final slice", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "twap", { coin: "ETH", side: "sell", totalUsdc: 100, slices: 2, durationHours: 2 });
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 50, filledSz: 0.5, avgPx: 100 }; } };
    const limits = { maxNotionalUsdc: 1000 };

    await tick(store, placer as any, limits, false, 0);
    expect(placed[0]).toMatchObject({ coin: "ETH", side: "sell", reduceOnly: false, sizeUsdc: 50 });
    expect(store.get(s.id)).toMatchObject({ slicesDone: 1, status: "running" });

    // second slice due after the interval
    const iv = (2 * 3600 * 1000) / 2;
    await tick(store, placer as any, limits, false, iv);
    expect(store.get(s.id)).toMatchObject({ slicesDone: 2, status: "completed" });
  });

  it("does not place a TWAP slice when the kill-switch is active", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "twap", { coin: "ETH", side: "buy", totalUsdc: 100, slices: 2, durationHours: 2 });
    const placer = { place: jest.fn(async () => ({ ok: true, filledUsdc: 50 })) };
    await tick(store, placer as any, { maxNotionalUsdc: 1000 }, true, 0);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("closes a long position (reduce-only sell) when take-profit triggers", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "tpsl", { coin: "BTC", takeProfitPrice: 110 });
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.5, avgPx: 110 }; } };
    const tpsl = { resolveMark: async () => 111, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, tpsl);
    expect(placed[0]).toMatchObject({ coin: "BTC", side: "sell", reduceOnly: true, sizeCoin: 0.5 });
    expect(store.get(s.id)).toMatchObject({ status: "completed", triggeredAt: 0 });
  });

  it("does not trigger when mark has not crossed", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "tpsl", { coin: "BTC", takeProfitPrice: 110, stopLossPrice: 90 });
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const tpsl = { resolveMark: async () => 100, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, tpsl);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("skips when there is no position", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "tpsl", { coin: "BTC", stopLossPrice: 90 });
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const tpsl = { resolveMark: async () => 80, resolvePosition: async () => undefined };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, tpsl);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("kill-switch blocks the tpsl close", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "tpsl", { coin: "BTC", takeProfitPrice: 110 });
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const tpsl = { resolveMark: async () => 120, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, true, 0, undefined, tpsl);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("uses cloidFor(s.id, now) for TP/SL close and partial fill leaves strategy running", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "tpsl", { coin: "BTC", takeProfitPrice: 110 });
    const placed: any[] = [];
    // partial fill: filledSz < abs(szi)
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.1, avgPx: 111 }; } };
    const tpsl = { resolveMark: async () => 111, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 42, undefined, tpsl);
    expect(placed[0].cloid).toBe(cloidFor(s.id, 42));
    // partial fill — strategy must still be running, no triggeredAt
    expect(store.get(s.id)).toMatchObject({ status: "running" });
    expect(store.get(s.id)!.triggeredAt).toBeUndefined();
  });

  it("records exactly one activity row when TP triggers a reduce-only close with filledSz and avgPx", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "tpsl", { coin: "BTC", takeProfitPrice: 110 });
    const activity = new MemoryActivityStore();
    const placer = { place: async (_r: any) => ({ ok: true, filledSz: 0.5, avgPx: 112 }) };
    const tpsl = { resolveMark: async () => 112, resolvePosition: async () => 0.5 };

    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 5000, activity, tpsl);

    const rows = activity.list("0xo", s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      strategyId: s.id,
      owner: "0xo",
      time: 5000,
      coin: "BTC",
      side: "sell",   // close side for a long position (szi > 0)
      sz: 0.5,
      px: 112,
    });

    // a second tick must not record another row (strategy is now completed)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 6000, activity, tpsl);
    expect(activity.list("0xo", s.id)).toHaveLength(1);
  });
});