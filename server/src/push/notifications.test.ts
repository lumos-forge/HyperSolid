import { fillNotification, deadManAlertNotification, deadManRecoveredNotification } from "./notifications";
import type { Activity } from "../strategies/activityStore";

function fill(over: Partial<Activity> = {}): Activity {
  return { id: "a1", strategyId: "s1", owner: "0xabc", time: 1000, coin: "BTC", side: "buy", sz: 0.01, px: 50000, ...over };
}

describe("notification catalog", () => {
  it("fillNotification: buy with formatted price and structured data", () => {
    const n = fillNotification(fill());
    expect(n.title).toBe("Order filled");
    expect(n.body).toBe("Buy 0.01 BTC @ 50,000");
    expect(n.data).toEqual({ kind: "fill", strategyId: "s1", coin: "BTC", side: "buy", sz: 0.01, px: 50000 });
  });

  it("fillNotification: sell capitalizes side", () => {
    const n = fillNotification(fill({ side: "sell", coin: "ETH", sz: 2, px: 3200.5 }));
    expect(n.body).toBe("Sell 2 ETH @ 3,200.5");
    expect(n.data).toMatchObject({ side: "sell", coin: "ETH" });
  });

  it("deadManAlertNotification: mentions the failure count", () => {
    const n = deadManAlertNotification({ consecutiveFailures: 3 });
    expect(n.title).toContain("protection");
    expect(n.body).toContain("3 consecutive");
    expect(n.data).toEqual({ kind: "deadman_alert", consecutiveFailures: 3 });
  });

  it("deadManRecoveredNotification: recovered kind", () => {
    const n = deadManRecoveredNotification();
    expect(n.title).toContain("restored");
    expect(n.data).toEqual({ kind: "deadman_recovered" });
  });
});
