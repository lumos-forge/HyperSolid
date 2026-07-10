import { fillNotification, deadManAlertNotification, deadManRecoveredNotification } from "./notifications";
import type { Activity } from "../strategies/activityStore";

function fill(over: Partial<Activity> = {}): Activity {
  return { id: "a1", strategyId: "s1", owner: "0xabc", time: 1000, coin: "BTC", side: "buy", sz: 0.01, px: 50000, ...over };
}

describe("notification catalog", () => {
  it("fillNotification en", () => {
    const n = fillNotification(fill(), "en");
    expect(n.title).toBe("Order filled");
    expect(n.body).toBe("Buy 0.01 BTC @ 50,000");
    expect(n.data).toEqual({ kind: "fill", strategyId: "s1", coin: "BTC", side: "buy", sz: 0.01, px: 50000 });
  });

  it("fillNotification zh", () => {
    const n = fillNotification(fill({ side: "sell", coin: "ETH", sz: 2, px: 3200 }), "zh");
    expect(n.title).toBe("订单成交");
    expect(n.body).toBe("卖出 2 ETH @ 3,200");
  });

  it("deadManAlertNotification en/zh", () => {
    expect(deadManAlertNotification({ consecutiveFailures: 3 }, "en").body).toContain("3 consecutive");
    expect(deadManAlertNotification({ consecutiveFailures: 3 }, "zh").title).toBe("策略保护异常");
    expect(deadManAlertNotification({ consecutiveFailures: 3 }, "zh").data).toEqual({ kind: "deadman_alert", consecutiveFailures: 3 });
  });

  it("deadManRecoveredNotification en/zh", () => {
    expect(deadManRecoveredNotification("en").data).toEqual({ kind: "deadman_recovered" });
    expect(deadManRecoveredNotification("zh").title).toBe("策略保护已恢复");
  });
});
