import { NotifyingActivityStore } from "./notifyingActivityStore";
import { fillNotification } from "./notifications";
import type { Activity, ActivityStore } from "../strategies/activityStore";
import type { Notification } from "./notifier";

function innerFake(): ActivityStore & { recorded: Omit<Activity, "id">[] } {
  const recorded: Omit<Activity, "id">[] = [];
  return {
    recorded,
    record(a) { recorded.push(a); return { id: "generated-id", ...a, owner: a.owner.toLowerCase() }; },
    list() { return [{ id: "L", strategyId: "s", owner: "o", time: 1, coin: "BTC", side: "buy", sz: 1, px: 1 }]; },
    listRecent() { return [{ id: "R", strategyId: "s", owner: "o", time: 1, coin: "ETH", side: "sell", sz: 2, px: 2 }]; },
    notionalSince() { return 123; },
  };
}

function notifierFake(opts: { throwSync?: boolean } = {}) {
  const calls: { owner: string; render: (locale: "en" | "zh") => Notification }[] = [];
  return {
    calls,
    async notify(owner: string, render: (locale: "en" | "zh") => Notification) {
      calls.push({ owner, render });
      if (opts.throwSync) throw new Error("boom");
      return { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    },
  };
}

const A = { strategyId: "s1", owner: "0xABC", time: 1000, coin: "BTC", side: "buy" as const, sz: 0.01, px: 50000 };

describe("NotifyingActivityStore", () => {
  it("delegates record to inner and returns its result", () => {
    const inner = innerFake();
    const notifier = notifierFake();
    const store = new NotifyingActivityStore(inner, notifier);
    const row = store.record(A);
    expect(row.id).toBe("generated-id");
    expect(inner.recorded).toHaveLength(1);
  });

  it("fires a fill notification for the recorded row's owner and content", () => {
    const inner = innerFake();
    const notifier = notifierFake();
    const store = new NotifyingActivityStore(inner, notifier);
    const row = store.record(A);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0].owner).toBe(row.owner); // lowercased by inner
    expect(notifier.calls[0].render("en")).toEqual(fillNotification(row, "en"));
    expect(notifier.calls[0].render("zh")).toEqual(fillNotification(row, "zh"));
  });

  it("still returns the inner result even if notify throws synchronously", () => {
    const inner = innerFake();
    const notifier = notifierFake({ throwSync: true });
    const store = new NotifyingActivityStore(inner, notifier);
    const row = store.record(A);
    expect(row.id).toBe("generated-id");
    expect(inner.recorded).toHaveLength(1);
  });

  it("passes list/listRecent/notionalSince through to inner", () => {
    const inner = innerFake();
    const store = new NotifyingActivityStore(inner, notifierFake());
    expect(store.list("o", "s")[0].id).toBe("L");
    expect(store.listRecent("o", 5)[0].id).toBe("R");
    expect(store.notionalSince("o", 0)).toBe(123);
  });
});
