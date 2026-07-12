import { NotifyingStrategyStore } from "./notifyingStrategyStore";
import { MemoryStrategyStore } from "./store";

function notifierFake() {
  const calls: { owner: string; category: string }[] = [];
  return {
    calls,
    async notify(owner: string, category: string) {
      calls.push({ owner, category });
      return { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    },
  };
}

const OWNER = "0xowner";

describe("NotifyingStrategyStore", () => {
  it("fires one lifecycle notification when a TWAP completes its last slice", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "twap", { coin: "ETH", side: "buy", totalUsdc: 100, slices: 2, durationHours: 1 } as any);
    store.recordFill(s.id, 50, 2000); // slice 1 of 2 → still running
    expect(notifier.calls).toHaveLength(0);
    store.recordFill(s.id, 50, 3000); // slice 2 of 2 → completed
    expect(notifier.calls).toEqual([{ owner: OWNER, category: "lifecycle" }]);
  });

  it("fires on a tpsl trigger", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "tpsl", { coin: "BTC", side: "sell", sz: 1, takeProfitPx: 70000 } as any);
    store.recordTrigger(s.id, 5000);
    expect(notifier.calls).toEqual([{ owner: OWNER, category: "lifecycle" }]);
  });

  it("does not fire when a fill leaves the strategy running", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "twap", { coin: "ETH", side: "buy", totalUsdc: 100, slices: 3, durationHours: 1 } as any);
    store.recordFill(s.id, 33, 2000);
    expect(notifier.calls).toHaveLength(0);
  });

  it("does not fire on a non-completed setStatus", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "dca", { coin: "ETH", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } as any);
    store.setStatus(s.id, "paused");
    expect(notifier.calls).toHaveLength(0);
  });

  it("does not re-fire for an already-completed strategy", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "tpsl", { coin: "BTC", side: "sell", sz: 1, takeProfitPx: 70000 } as any);
    store.recordTrigger(s.id, 5000); // completes → 1 notify
    store.setStatus(s.id, "completed"); // already completed → no new notify
    expect(notifier.calls).toHaveLength(1);
  });

  it("does not break the delegated write when the notifier throws synchronously", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = { notify: () => { throw new Error("boom"); } };
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "tpsl", { coin: "BTC", side: "sell", sz: 1, takeProfitPx: 70000 } as any);
    store.recordTrigger(s.id, 5000);
    expect(inner.get(s.id)?.status).toBe("completed");
  });

  it("passes reads and other methods through to the inner store", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const store = new NotifyingStrategyStore(inner, notifierFake());
    const s = store.create(OWNER, "dca", { coin: "ETH", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } as any);
    expect(store.get(s.id)?.id).toBe(s.id);
    expect(store.list(OWNER)).toHaveLength(1);
    expect(store.listAll()).toHaveLength(1);
    store.remove(s.id);
    expect(store.get(s.id)).toBeUndefined();
  });
});
