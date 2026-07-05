import { MemoryStrategyStore } from "../strategies/store";
import { MemoryActivityStore } from "../strategies/activityStore";
import { tick, cloidFor, cloidForKey, type OrderPlacer, type PlaceRequest } from "./scheduler";

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

describe("grid tick", () => {
  const params = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
  // step=20; lines 100,120,140,160,180,200 (idx 0..5)

  it("seeds lastLevel on the first tick without placing an order", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 0 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3 });
  });

  it("buys the crossed distance on a down-cross (non-reduce)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 4); // mark was at 180
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 100, filledSz: 0.5, avgPx: 200 }; } };
    const marks = { resolveMark: async () => 140, resolvePosition: async () => 0 }; // band 2
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2, actionsDone: 1, filledTotalUsdc: 100 });
  });

  it("sells reduce-only on an up-cross and does not add bought notional", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 1); // mark was at 120
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 100, filledSz: 0.5, avgPx: 160 }; } };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 1 }; // band 3
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "sell", reduceOnly: true, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 1, filledTotalUsdc: 0 });
  });

  it("does nothing when the band is unchanged", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 3);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 0 }; // band 3
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("halts entirely under the kill-switch", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 4);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 100, resolvePosition: async () => 0 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, true, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4 });
  });

  it("blocks a grid buy over the per-order cap but leaves state for retry", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 4);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 140, resolvePosition: async () => 0 }; // buy 100 usdc
    await tick(store, placer as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 0 });
  });

  it("keys the cloid on monotonic actionsDone, so revisiting the SAME level re-places (not deduped)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 3); // start at line 160
    const seen: string[] = [];
    const placer = { place: async (r: any) => { seen.push(r.cloid); return { ok: true, filledUsdc: 50, filledSz: 0.3, avgPx: 150 }; } };
    // tick 1: 160 -> 140, down-cross buy to band 2 (targetLevel 2)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 140, resolvePosition: async () => 0 });
    // tick 2: 140 -> 160, up-cross reduce-only sell to band 3 (targetLevel 3)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 160, resolvePosition: async () => 1 });
    // tick 3: 160 -> 140, down-cross buy back to band 2 AGAIN (targetLevel 2, same as tick 1)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 140, resolvePosition: async () => 0 });
    expect(seen).toHaveLength(3);
    // The two actions that both target level 2 (tick 1 and tick 3) must still get DISTINCT cloids,
    // which only holds if the cloid is keyed on the monotonic actionsDone, not the level index.
    expect(seen[0]).not.toBe(seen[2]);
    expect(new Set(seen).size).toBe(3);
  });

  it("does not place a reduce-only sell when flat; advances the tracked level instead", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 1); // start at line 120, FLAT
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 0 }; // band 3, no inventory
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    // tracked level advances to follow the price up, but no action counted
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 0 });
  });

  const symParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "symmetric" as const };

  it("symmetric: crossing above center opens a short toward target (non-reduce)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    store.seedGridLevel(s.id, 2); // tracking the center band
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.5, avgPx: 180 }; } };
    const marks = { resolveMark: async () => 180, resolvePosition: async () => 0 }; // band 4, flat -> target -75
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "sell", reduceOnly: false, sizeUsdc: 75 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 1 });
  });

  it("symmetric: crossing below center buys to reconcile against a short (non-reduce)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    store.seedGridLevel(s.id, 4); // tracking a high band
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 165, filledSz: 1.1, avgPx: 140 }; } };
    // band 2 -> target +25; actual = -1 * 140 = -140; delta = 25 - (-140) = 165
    const marks = { resolveMark: async () => 140, resolvePosition: async () => -1 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "buy", reduceOnly: false, sizeUsdc: 165 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2, actionsDone: 1 });
  });

  it("symmetric: gates the reconciling order through the per-order cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    store.seedGridLevel(s.id, 2); // center band
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 200, resolvePosition: async () => 0 }; // band 5, target -125, size 125 > cap
    await tick(store, placer as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2 });
  });

  it("symmetric: keeps net tracking target as price oscillates across center", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    let pos = 0;
    let mk = 140;
    const placer = {
      place: async (r: any) => {
        pos += (r.side === "buy" ? 1 : -1) * (r.sizeUsdc / mk); // simulate a full fill at mark
        return { ok: true, filledUsdc: r.sizeUsdc, filledSz: r.sizeUsdc / mk, avgPx: mk };
      },
    };
    const marks = { resolveMark: async () => mk, resolvePosition: async () => pos };

    mk = 140; // band 2 -> target +25 (open long from flat)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(pos).toBeGreaterThan(0);
    expect(pos * mk).toBeCloseTo(25, 6);

    mk = 200; // band 5 -> target -125 (flip long -> short)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(pos).toBeLessThan(0);
    expect(pos * mk).toBeCloseTo(-125, 6);

    mk = 120; // band 1 -> target +75 (flip short -> long)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(pos).toBeGreaterThan(0);
    expect(pos * mk).toBeCloseTo(75, 6);
  });

  it("symmetric seed: builds a long toward target below center", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams); // levels 6 -> center 2.5
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 75, filledSz: 0.5, avgPx: 120 }; } };
    const marks = { resolveMark: async () => 120, resolvePosition: async () => 0 }; // band 1 -> target (2.5-1)*50 = 75
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "buy", reduceOnly: false, sizeUsdc: 75 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 1, actionsDone: 1 });
  });

  it("symmetric seed: builds a short toward target above center", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.7, avgPx: 180 }; } };
    const marks = { resolveMark: async () => 180, resolvePosition: async () => 0 }; // band 4 -> target (2.5-4)*50 = -75
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "sell", reduceOnly: false, sizeUsdc: 75 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 1 });
  });

  it("symmetric seed: places no order at the exact center (odd levels)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const oddParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 5, perLevelUsdc: 50, mode: "symmetric" as const };
    const s = store.create("0xo", "grid", oddParams); // center band 2 -> line 150
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 150, resolvePosition: async () => 0 }; // band 2 -> target 0
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2 });
  });

  it("symmetric seed: skips a sub-min-notional target without ordering", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const dustParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 10, mode: "symmetric" as const };
    const s = store.create("0xo", "grid", dustParams); // center 2.5
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 140, resolvePosition: async () => 0 }; // band 2 -> target (2.5-2)*10 = 5 (< MIN)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2 });
  });

  it("symmetric seed: retries next tick when the seed order is capped (no lastLevel)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 120, resolvePosition: async () => 0 }; // seed target 75 > cap 10
    await tick(store, placer as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)!.lastLevel).toBeUndefined();
  });
});
describe("cloidForKey", () => {
  it("is deterministic per (strategyId, key) and 34-char hex", () => {
    const a = cloidForKey("s1", "gl:2:3");
    expect(a).toBe(cloidForKey("s1", "gl:2:3"));
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
  });
  it("differs across keys and strategies", () => {
    expect(cloidForKey("s1", "gl:2:3")).not.toBe(cloidForKey("s1", "gl:2:4"));
    expect(cloidForKey("s1", "gl:2:3")).not.toBe(cloidForKey("s2", "gl:2:3"));
  });
});
