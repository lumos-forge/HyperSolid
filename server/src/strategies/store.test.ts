import { MemoryStrategyStore } from "./store";

describe("MemoryStrategyStore", () => {
  it("creates, lists by owner, toggles status, and records fills", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xo", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    expect(s.status).toBe("running");
    expect(s.nextRunAt).toBe(1000);
    expect(store.list("0xo")).toHaveLength(1);
    expect(store.list("0xother")).toHaveLength(0);

    store.setStatus(s.id, "paused");
    expect(store.get(s.id)!.status).toBe("paused");

    store.recordFill(s.id, 50, 24 * 3600 * 1000 + 1000);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(50);
    expect(store.get(s.id)!.nextRunAt).toBe(24 * 3600 * 1000 + 1000);
  });

  it("removes a strategy", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", { coin: "ETH", side: "buy", quoteAmountUsdc: 10, intervalHours: 1 });
    store.remove(s.id);
    expect(store.get(s.id)).toBeUndefined();
  });
});
