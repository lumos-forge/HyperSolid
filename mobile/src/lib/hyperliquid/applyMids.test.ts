import { applyMids } from "./normalize";
import type { MarketTicker } from "./types";

const base: MarketTicker[] = [
  { coin: "BTC", midPx: 100, prevDayPx: 100, changePct: 0, funding: 0, dayNtlVlm: 9, maxLeverage: 50 },
  { coin: "ETH", midPx: 50, prevDayPx: 50, changePct: 0, funding: 0, dayNtlVlm: 8, maxLeverage: 50 },
];

describe("applyMids", () => {
  it("updates midPx and recomputes changePct for known coins", () => {
    const out = applyMids(base, { BTC: "110" });
    const btc = out.find((t) => t.coin === "BTC")!;
    expect(btc.midPx).toBe(110);
    expect(btc.changePct).toBeCloseTo(10, 5);
  });

  it("leaves coins not present in the update unchanged", () => {
    const out = applyMids(base, { BTC: "110" });
    const eth = out.find((t) => t.coin === "ETH")!;
    expect(eth.midPx).toBe(50);
  });

  it("does not mutate the input array", () => {
    const snapshot = JSON.parse(JSON.stringify(base));
    applyMids(base, { BTC: "999" });
    expect(base).toEqual(snapshot);
  });
});
