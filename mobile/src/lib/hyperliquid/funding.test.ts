import { aggregateFundingByCoin, totalFunding, fundingSince } from "./funding";
import type { FundingEvent } from "./types";

const fe = (over: Partial<FundingEvent>): FundingEvent => ({
  coin: "BTC",
  time: 1000,
  usdc: -0.25,
  szi: 0.01,
  fundingRate: 0.0000125,
  hash: ("0x" + "2".repeat(64)) as `0x${string}`,
  ...over,
});

describe("aggregateFundingByCoin", () => {
  it("groups by coin with net/paid/received/count (signed usdc)", () => {
    const out = aggregateFundingByCoin([
      fe({ coin: "BTC", usdc: -0.25 }),
      fe({ coin: "BTC", usdc: -0.15 }),
      fe({ coin: "ETH", usdc: 0.1 }),
      fe({ coin: "ETH", usdc: -0.3 }),
    ]);
    const btc = out.find((s) => s.coin === "BTC")!;
    const eth = out.find((s) => s.coin === "ETH")!;
    expect(btc.net).toBeCloseTo(-0.4, 6);
    expect(btc.paid).toBeCloseTo(0.4, 6); // sum of |usdc<0|
    expect(btc.received).toBe(0);
    expect(btc.count).toBe(2);
    expect(eth.net).toBeCloseTo(-0.2, 6);
    expect(eth.paid).toBeCloseTo(0.3, 6);
    expect(eth.received).toBeCloseTo(0.1, 6);
  });

  it("sorts by absolute net descending", () => {
    const out = aggregateFundingByCoin([
      fe({ coin: "AAA", usdc: -0.1 }),
      fe({ coin: "BBB", usdc: -5 }),
      fe({ coin: "CCC", usdc: 2 }),
    ]);
    expect(out.map((s) => s.coin)).toEqual(["BBB", "CCC", "AAA"]);
  });

  it("handles empty input", () => {
    expect(aggregateFundingByCoin([])).toEqual([]);
  });
});

describe("totalFunding", () => {
  it("nets all events (signed; negative = net paid)", () => {
    expect(totalFunding([fe({ usdc: -0.25 }), fe({ usdc: 0.1 }), fe({ usdc: -0.05 })])).toBeCloseTo(-0.2, 6);
    expect(totalFunding([])).toBe(0);
  });
});

describe("fundingSince", () => {
  it("sums only events at/after the window start", () => {
    const events = [fe({ time: 100, usdc: -1 }), fe({ time: 500, usdc: -2 }), fe({ time: 900, usdc: -3 })];
    expect(fundingSince(events, 500)).toBeCloseTo(-5, 6); // 500 and 900
  });
  it("returns 0 when nothing in window", () => {
    expect(fundingSince([fe({ time: 100 })], 1000)).toBe(0);
  });
});
