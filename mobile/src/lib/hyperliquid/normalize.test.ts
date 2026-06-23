import { normalizeMarkets } from "./normalize";
import type { MetaAndAssetCtxs } from "./types";

const sample: MetaAndAssetCtxs = [
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 50 },
      { name: "ETH", szDecimals: 4, maxLeverage: 50 },
    ],
  },
  [
    { midPx: "102", prevDayPx: "100", funding: "0.0001", dayNtlVlm: "500", openInterest: "10" },
    { midPx: "99", prevDayPx: "100", funding: "0.0002", dayNtlVlm: "1500", openInterest: "20" },
  ],
];

describe("normalizeMarkets", () => {
  it("maps universe + ctxs into tickers", () => {
    const out = normalizeMarkets(sample);
    const btc = out.find((t) => t.coin === "BTC")!;
    expect(btc.midPx).toBe(102);
    expect(btc.prevDayPx).toBe(100);
    expect(btc.changePct).toBeCloseTo(2, 5);
    expect(btc.maxLeverage).toBe(50);
  });

  it("propagates szDecimals from meta (needed for order precision)", () => {
    const out = normalizeMarkets(sample);
    expect(out.find((t) => t.coin === "BTC")!.szDecimals).toBe(5);
    expect(out.find((t) => t.coin === "ETH")!.szDecimals).toBe(4);
  });

  it("computes negative change", () => {
    const eth = normalizeMarkets(sample).find((t) => t.coin === "ETH")!;
    expect(eth.changePct).toBeCloseTo(-1, 5);
  });

  it("sorts by 24h notional volume descending", () => {
    const out = normalizeMarkets(sample);
    expect(out.map((t) => t.coin)).toEqual(["ETH", "BTC"]);
  });

  it("treats prevDayPx of 0 as 0% change (no divide-by-zero)", () => {
    const data: MetaAndAssetCtxs = [
      { universe: [{ name: "NEW", szDecimals: 2, maxLeverage: 3 }] },
      [{ midPx: "5", prevDayPx: "0", funding: "0", dayNtlVlm: "1", openInterest: "0" }],
    ];
    expect(normalizeMarkets(data)[0].changePct).toBe(0);
  });

  it("carries open interest through normalization", () => {
    const data: MetaAndAssetCtxs = [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] },
      [{ midPx: "64000", prevDayPx: "63000", funding: "0.0001", dayNtlVlm: "1000", openInterest: "1950000000" }],
    ];
    expect(normalizeMarkets(data)[0].openInterest).toBe(1_950_000_000);
  });
});
