import { MemoryStrategyStore } from "../strategies/store";
import { tick, cloidFor, type OrderPlacer } from "./scheduler";

function placerFake(): OrderPlacer & { calls: { cloid: string; sizeUsdc: number }[] } {
  const calls: { cloid: string; sizeUsdc: number }[] = [];
  return {
    calls,
    async place(req) {
      calls.push({ cloid: req.cloid, sizeUsdc: req.sizeUsdc });
      return { ok: true, filledUsdc: req.sizeUsdc };
    },
  };
}

describe("scheduler tick", () => {
  const limits = { maxNotionalUsdc: 1000 };

  it("places one order per due strategy with the slot-deterministic cloid, then advances it", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xo", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const placer = placerFake();

    await tick(store, placer, limits, false, 2000);
    expect(placer.calls).toHaveLength(1);
    expect(placer.calls[0].cloid).toBe(cloidFor(s.id, 1000));
    expect(placer.calls[0].sizeUsdc).toBe(50);

    await tick(store, placer, limits, false, 2000);
    expect(placer.calls).toHaveLength(1);
  });

  it("places nothing when the kill-switch is on", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    store.create("0xo", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const placer = placerFake();
    await tick(store, placer, limits, true, 2000);
    expect(placer.calls).toHaveLength(0);
  });

  it("does not advance the strategy if the placer reports failure", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xo", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const failing: OrderPlacer = { async place() { return { ok: false }; } };
    await tick(store, failing, limits, false, 2000);
    expect(store.get(s.id)!.nextRunAt).toBe(1000);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(0);
  });
});
