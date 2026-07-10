import { pushMessages, sideLabel, toPushLocale } from "./messages";

describe("push messages", () => {
  it("localizes side labels", () => {
    expect(sideLabel("en", "buy")).toBe("Buy");
    expect(sideLabel("en", "sell")).toBe("Sell");
    expect(sideLabel("zh", "buy")).toBe("买入");
    expect(sideLabel("zh", "sell")).toBe("卖出");
  });

  it("has en + zh templates for fill and dead-man", () => {
    expect(pushMessages.en.fillTitle).toBe("Order filled");
    expect(pushMessages.zh.fillTitle).toBe("订单成交");
    expect(pushMessages.en.fillBody("buy", "0.01", "BTC", "50,000")).toBe("Buy 0.01 BTC @ 50,000");
    expect(pushMessages.zh.fillBody("sell", "2", "ETH", "3,200")).toBe("卖出 2 ETH @ 3,200");
    expect(pushMessages.en.deadmanAlertBody(3)).toContain("3 consecutive");
    expect(pushMessages.zh.deadmanAlertBody(3)).toContain("连续 3 次");
  });

  it("normalizes any locale to a supported one (default en)", () => {
    expect(toPushLocale("zh")).toBe("zh");
    expect(toPushLocale("en")).toBe("en");
    expect(toPushLocale(null)).toBe("en");
    expect(toPushLocale("fr")).toBe("en");
    expect(toPushLocale(undefined)).toBe("en");
  });
});
