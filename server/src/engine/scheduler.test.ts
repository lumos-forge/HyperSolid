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

// A fake resting executor whose placeLimit records calls and returns an incrementing resting oid;
// callers can override the outcome per test.
function fakeExec(outcome?: (req: any) => any) {
  const calls: any[] = [];
  const cancels: any[] = [];
  let oid = 1000;
  return {
    calls, cancels,
    placeLimit: jest.fn(async (req: any) => { calls.push(req); return outcome ? outcome(req) : { ok: true, oid: oid++ }; }),
    cancelMany: jest.fn(async (req: any) => { cancels.push(req); return true; }),
  };
}
function fakeReader(cloids: string[], total?: number) {
  return {
    openOrders: jest.fn(async () => ({
      byCloid: new Map(cloids.map((c) => [c, { oid: 1, coin: "BTC", side: "buy" as const, px: 100 }])),
      total: total ?? cloids.length,
    })),
  };
}

function fakeFills(map: Record<string, { sz: number; px: number; closedPnl: number }>) {
  return { fillsByCloid: jest.fn(async () => new Map(Object.entries(map))) };
}

const glParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
// lines 100,120,140,160,180,200; rungs 0..4 (buy@line[i], sell@line[i+1])

describe("gridLimit tick (running)", () => {
  it("arms resting buys on every rung whose buy line is below the mark", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    const armed = store.gridLimitRungs(s.id).filter((r) => r.state === "armed").map((r) => r.rung);
    expect(armed).toEqual([0, 1, 2]);
    expect(exec.placeLimit).toHaveBeenCalledTimes(3);
    expect(exec.calls[0]).toMatchObject({ side: "buy", reduceOnly: false, price: 100 });
  });

  it("on a filled buy, places a reduce-only sell one line up and goes holding", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "armed", side: "buy", cloid: "0xBUY", px: 140, seq: 1 });
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 145, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    const r2 = store.gridLimitRungs(s.id).find((r) => r.rung === 2)!;
    expect(r2).toMatchObject({ state: "holding", side: "sell", px: 160 });
    expect(exec.calls.find((c) => c.side === "sell")).toMatchObject({ side: "sell", reduceOnly: true, price: 160 });
  });

  it("on a filled sell, realizes profit and re-arms the buy", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xSELL", px: 160, seq: 2 });
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    const r2 = store.gridLimitRungs(s.id).find((r) => r.rung === 2)!;
    expect(r2.state).toBe("armed");
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo((160 - 140) * (50 / 140), 6);
  });

  it("does not re-arm a rung whose buy line is at/above mark (stays idle)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 4, state: "holding", side: "sell", cloid: "0xSELL", px: 200, seq: 2 });
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(store.gridLimitRungs(s.id).find((r) => r.rung === 4)!.state).toBe("idle");
  });

  it("leaves a rung unchanged when an ALO placement is rejected (retry next tick)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec(() => ({ ok: false, rejected: true }));
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(store.gridLimitRungs(s.id).filter((r) => r.state === "armed")).toEqual([]);
  });

  it("gates buys with the per-order notional cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(exec.placeLimit).not.toHaveBeenCalled();
  });

  it("keeps an already-resting armed buy without re-placing", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xBUY0", px: 100, seq: 1 });
    const exec = fakeExec();
    const reader = fakeReader(["0xBUY0"]);
    const marks = { resolveMark: async () => 110, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(exec.placeLimit).not.toHaveBeenCalled();
  });

  it("adopts a crash-orphaned resting order matching our deterministic cloid instead of re-placing", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    const orphan = cloidForKey(s.id, "gl:0:1"); // what an idle rung 0 (seq 0) would place next
    const exec = fakeExec();
    const reader = fakeReader([orphan]);
    const marks = { resolveMark: async () => 110, resolvePosition: async () => undefined }; // only rung 0 armable
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(exec.placeLimit).not.toHaveBeenCalled(); // adopted, not re-placed
    expect(store.gridLimitRungs(s.id).find((r) => r.rung === 0)).toMatchObject({ state: "armed", side: "buy", cloid: orphan, seq: 1 });
  });

  it("records precise sz/px from userFills on a buy fill", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "armed", side: "buy", cloid: "0xBUY", px: 140, seq: 1 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({ "0xBUY": { sz: 0.36, px: 139.9, closedPnl: 0 } });
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, marks, exec as any, fakeReader([]) as any, fills as any);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", sz: 0.36, px: 139.9 }));
  });

  it("uses userFills closedPnl for realized pnl on a sell fill", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xSELL", px: 160, seq: 2 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({ "0xSELL": { sz: 0.36, px: 160.1, closedPnl: 7.25 } });
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, marks, exec as any, fakeReader([]) as any, fills as any);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", sz: 0.36, px: 160.1 }));
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo(7.25, 6);
  });

  it("falls back to the limit-price approximation when userFills lacks the cloid", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xSELL", px: 160, seq: 2 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({}); // cloid absent -> fallback
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, marks, exec as any, fakeReader([]) as any, fills as any);
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo((160 - 140) * (50 / 140), 6);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", px: 160 }));
  });
});

describe("gridLimit tick (draining)", () => {
  it("cancels resting orders when paused, clearing rungs only once the book confirms them gone", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xB0", px: 100, seq: 1 });
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xS2", px: 160, seq: 2 });
    store.setStatus(s.id, "paused");
    const exec = fakeExec();
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    // Tick 1: both still open -> cancel both, keep rungs tracked (cancel not yet confirmed).
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, fakeReader(["0xB0", "0xS2"]) as any);
    expect(exec.cancels).toHaveLength(1); // both rungs coalesced into one cancelMany call
    expect(exec.cancels[0].cancels.map((c: any) => c.cloid).sort()).toEqual(["0xB0", "0xS2"]);
    expect(store.gridLimitRungs(s.id).some((r) => r.cloid !== null)).toBe(true);
    expect(store.get(s.id)!.status).toBe("paused");
    // Tick 2: book empty -> rungs cleared to idle, still paused.
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, fakeReader([]) as any);
    expect(store.gridLimitRungs(s.id).every((r) => r.state === "idle" && r.cloid === null)).toBe(true);
    expect(store.get(s.id)!.status).toBe("paused");
  });

  it("cancels all under the global kill-switch and does not place", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xB0", px: 100, seq: 1 });
    const exec = fakeExec();
    const reader = fakeReader(["0xB0"]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, true, 0, undefined, marks, exec as any, reader as any);
    expect(exec.cancels.flatMap((c: any) => c.cancels.map((x: any) => x.cloid))).toEqual(["0xB0"]);
    expect(exec.placeLimit).not.toHaveBeenCalled();
  });

  it("drains a canceling strategy then removes it once nothing is left resting", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xB0", px: 100, seq: 1 });
    store.setStatus(s.id, "canceling");
    const exec = fakeExec();
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader(["0xB0"]) as any);
    expect(store.get(s.id)).toBeDefined();
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    expect(store.get(s.id)).toBeUndefined();
  });

  it("cancels a crash-orphaned resting order (never persisted) before removing a canceling strategy", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setStatus(s.id, "canceling");
    const orphan = cloidForKey(s.id, "gl:0:1"); // rung 0 default seq 0 -> next-seq crash orphan
    const exec = fakeExec();
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([orphan]) as any);
    expect(exec.cancels.flatMap((c: any) => c.cancels.map((x: any) => x.cloid))).toContain(orphan);
    expect(store.get(s.id)).toBeDefined();
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    expect(store.get(s.id)).toBeUndefined();
  });

  it("coalesces two draining strategies of one owner across coins into a single cancelMany", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const a = store.create("0xo", "gridLimit", { ...glParams, coin: "BTC" });
    const b = store.create("0xo", "gridLimit", { ...glParams, coin: "ETH" });
    store.setGridLimitRung(a.id, { rung: 0, state: "armed", side: "buy", cloid: "0xA", px: 100, seq: 1 });
    store.setGridLimitRung(b.id, { rung: 0, state: "armed", side: "buy", cloid: "0xE", px: 100, seq: 1 });
    store.setStatus(a.id, "paused");
    store.setStatus(b.id, "paused");
    const exec = fakeExec();
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, fakeReader(["0xA", "0xE"]) as any);
    expect(exec.cancels).toHaveLength(1); // one cancelMany for the owner, spanning both coins
    const sent = exec.cancels[0].cancels;
    expect(sent).toContainEqual({ coin: "BTC", cloid: "0xA" });
    expect(sent).toContainEqual({ coin: "ETH", cloid: "0xE" });
  });
});

describe("gridLimit tick (open-order cap)", () => {
  it("skips new entry placements when the owner is at the open-order cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9, maxOpenOrders: 5 }, false, 0, undefined, marks, exec as any, fakeReader([], 5) as any);
    const entries = exec.calls.filter((c: any) => !c.reduceOnly);
    expect(entries).toHaveLength(0); // entries blocked at cap
  });
  it("places entries when below the open-order cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9, maxOpenOrders: 100 }, false, 0, undefined, marks, exec as any, fakeReader([], 0) as any);
    const entries = exec.calls.filter((c: any) => !c.reduceOnly);
    expect(entries.length).toBeGreaterThan(0); // entries flow below cap
  });
});

describe("gridLimit tick (symmetric)", () => {
  const symParams = { ...glParams, mode: "symmetric" as const };

  it("arms long buys below the mark and short sells above it, partitioned by rung center", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", symParams);
    const exec = fakeExec();
    // mark 150: centers 110,130 (long) -> buy@100,120; centers 150,170,190 (short) -> sell@160,180,200.
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    const buys = exec.calls.filter((c: any) => c.side === "buy").map((c: any) => c.price).sort((a: number, b: number) => a - b);
    const sells = exec.calls.filter((c: any) => c.side === "sell").map((c: any) => c.price).sort((a: number, b: number) => a - b);
    expect(buys).toEqual([100, 120]);
    expect(sells).toEqual([160, 180, 200]);
    expect(exec.calls.filter((c: any) => c.side === "sell").every((c: any) => c.reduceOnly === false)).toBe(true);
  });

  it("runs a short rung through open -> reduce-only TP buy -> close", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", symParams);
    store.setGridLimitRung(s.id, { rung: 3, state: "armed", side: "sell", cloid: "0xSH", px: 180, seq: 1 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({ "0xSH": { sz: 50 / 180, px: 180, closedPnl: 0 } });
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any, fills as any);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", px: 180 }));
    const tp = exec.calls.find((c: any) => c.side === "buy" && c.reduceOnly === true);
    expect(tp).toMatchObject({ price: 160, reduceOnly: true });
    const r3 = store.gridLimitRungs(s.id).find((r) => r.rung === 3)!;
    expect(r3).toMatchObject({ state: "holding", side: "buy" });

    const exec2 = fakeExec();
    const fills2 = fakeFills({ [r3.cloid!]: { sz: 50 / 180, px: 160, closedPnl: 6.1 } });
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec2 as any, fakeReader([]) as any, fills2 as any);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", px: 160 }));
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo(6.1, 6);
    // After TP closes, rung 3 is still armable (sell@180 > mark@150) so it re-arms immediately.
    expect(store.gridLimitRungs(s.id).find((r) => r.rung === 3)).toMatchObject({ state: "armed", side: "sell" });
  });

  it("books a short TP close with short-sizing when userFills is unavailable", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", symParams);
    // holding short rung 3: sold @180, resting reduce-only TP buy @160. cloid vanished from open orders = filled.
    store.setGridLimitRung(s.id, { rung: 3, state: "holding", side: "buy", cloid: "0xTP", px: 160, seq: 2 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    // No userFills reader passed -> fill is undefined, exercising the direction-aware fallback.
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    // short rung 3: sell@180, buy@160 -> fallback size = perLevelUsdc/sellPrice = 50/180 (NOT 50/160).
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", sz: 50 / 180 }));
    // fallback pnl = (180 - 160) * (50/180) = 5.5556, not the long-sized (180-160)*(50/160) = 6.25.
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo((180 - 160) * (50 / 180), 6);
  });

  it("gates a short entry behind caps (does not place a sell when over cap)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", symParams);
    const exec = fakeExec();
    await tick(store, {} as any, { maxNotionalUsdc: 10 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    expect(exec.calls.filter((c: any) => c.side === "sell")).toHaveLength(0);
  });

  it("leaves longOnly behavior unchanged (default mode: buys below mark, no sells)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    const buys = exec.calls.filter((c: any) => c.side === "buy").map((c: any) => c.price).sort((a: number, b: number) => a - b);
    expect(buys).toEqual([100, 120, 140]);
    expect(exec.calls.filter((c: any) => c.side === "sell")).toHaveLength(0);
  });
});

describe("trailing stop", () => {
  it("advances the peak while the mark rises, then closes on retrace and completes", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.5, avgPx: 94 }; } };
    const s = store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const rising = { resolveMark: async () => 100, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, rising);
    expect(placed).toHaveLength(0);            // 100 not <= 95
    expect(store.get(s.id)?.trailPeak).toBe(100);
    const retrace = { resolveMark: async () => 94, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, retrace);
    expect(placed[0]).toMatchObject({ coin: "BTC", side: "sell", reduceOnly: true, sizeCoin: 0.5 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("closes a short when the mark rises past the trough callback", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.5, avgPx: 106 }; } };
    const s = store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const down = { resolveMark: async () => 100, resolvePosition: async () => -0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, down);
    expect(placed).toHaveLength(0);            // 100 not >= 105
    const up = { resolveMark: async () => 106, resolvePosition: async () => -0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, up);
    expect(placed[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: true, sizeCoin: 0.5 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("does not close while the mark keeps rising (long)", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const m1 = { resolveMark: async () => 100, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, m1);
    const m2 = { resolveMark: async () => 120, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, m2);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("skips when there is no position", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const none = { resolveMark: async () => 50, resolvePosition: async () => undefined };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, none);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("kill-switch blocks the trailing close", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const retrace = { resolveMark: async () => 80, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, true, 0, undefined, retrace);
    expect(placer.place).not.toHaveBeenCalled();
  });
});

describe("conditional entry", () => {
  const cond = (over: any = {}) => ({ coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 100, triggerDirection: "above", ...over });

  it("opens a market position and completes when the mark crosses above", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "conditional", cond());
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("fires a below-direction sell when the mark crosses down", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "conditional", cond({ side: "sell", triggerDirection: "below" }));
    const marks = { resolveMark: async () => 95, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "sell", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("does not fire before the trigger is crossed", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond());
    const marks = { resolveMark: async () => 90, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.calls).toHaveLength(0);
  });

  it("kill-switch blocks the conditional entry", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond());
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, true, 0, undefined, marks);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the per-coin notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond({ sizeUsdc: 100 }));
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1000, perCoinMaxNotionalUsdc: { BTC: 50 } }, false, 0, undefined, marks);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the daily notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond({ sizeUsdc: 100 }));
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    const activity = { record: () => {}, notionalSince: () => 60 } as any;
    await tick(store, placer, { maxNotionalUsdc: 1e9, dailyMaxNotionalUsdc: 100 }, false, 0, activity, marks);
    expect(placer.calls).toHaveLength(0); // 60 + 100 > 100
  });

  it("uses a restart-stable cloid so a replay dedupes instead of double-opening", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const calls: any[] = [];
    // Placement fails, so the strategy stays running and re-fires on the next tick.
    const placer = { place: async (r: any) => { calls.push(r); return { ok: false }; } };
    store.create("0xo", "conditional", cond());
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 111, undefined, marks);
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 222, undefined, marks); // different `now`
    expect(calls).toHaveLength(2);
    expect(calls[0].cloid).toBe(calls[1].cloid); // stable across ticks/restarts
  });
});

describe("scheduled entry", () => {
  const sched = (over: any = {}) => ({ coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 5000, ...over });

  it("opens a market position and completes once runAt has passed", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 5000);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("fires a sell side too", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "scheduled", sched({ side: "sell", runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 6000);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "sell", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("does not fire before runAt", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 4999);
    expect(placer.calls).toHaveLength(0);
  });

  it("kill-switch blocks the scheduled entry", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, true, 5000);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the per-coin notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ sizeUsdc: 100, runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1000, perCoinMaxNotionalUsdc: { BTC: 50 } }, false, 5000);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the daily notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ sizeUsdc: 100, runAt: 5000 }));
    const activity = { record: () => {}, notionalSince: () => 60 } as any;
    await tick(store, placer, { maxNotionalUsdc: 1e9, dailyMaxNotionalUsdc: 100 }, false, 5000, activity);
    expect(placer.calls).toHaveLength(0); // 60 + 100 > 100
  });

  it("uses a restart-stable cloid so a replay dedupes instead of double-opening", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const calls: any[] = [];
    const placer = { place: async (r: any) => { calls.push(r); return { ok: false }; } };
    store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 5000);
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 6000); // later `now`
    expect(calls).toHaveLength(2);
    expect(calls[0].cloid).toBe(calls[1].cloid);
  });
});
