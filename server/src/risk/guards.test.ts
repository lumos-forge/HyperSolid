import { withinCaps } from "./guards";

describe("withinCaps", () => {
  it("rejects an order above the per-order notional cap", () => {
    expect(withinCaps({ notionalUsdc: 200, killSwitch: false }, { maxNotionalUsdc: 100 }).ok).toBe(false);
  });
  it("rejects everything when the kill-switch is on", () => {
    expect(withinCaps({ notionalUsdc: 10, killSwitch: true }, { maxNotionalUsdc: 100 }).ok).toBe(false);
  });
  it("accepts an order within caps", () => {
    expect(withinCaps({ notionalUsdc: 50, killSwitch: false }, { maxNotionalUsdc: 100 }).ok).toBe(true);
  });

  it("enforces a per-coin cap (overriding the global cap for that coin)", () => {
    const limits = { maxNotionalUsdc: 1000, perCoinMaxNotionalUsdc: { BTC: 100 } };
    // BTC over its own tighter cap, even though under the global cap
    expect(withinCaps({ notionalUsdc: 200, killSwitch: false, coin: "BTC" }, limits).ok).toBe(false);
    // BTC under its own cap
    expect(withinCaps({ notionalUsdc: 80, killSwitch: false, coin: "BTC" }, limits).ok).toBe(true);
  });

  it("falls back to the global cap for a coin with no per-coin entry", () => {
    const limits = { maxNotionalUsdc: 100, perCoinMaxNotionalUsdc: { BTC: 1000 } };
    expect(withinCaps({ notionalUsdc: 150, killSwitch: false, coin: "ETH" }, limits).ok).toBe(false);
    expect(withinCaps({ notionalUsdc: 50, killSwitch: false, coin: "ETH" }, limits).ok).toBe(true);
  });
});
