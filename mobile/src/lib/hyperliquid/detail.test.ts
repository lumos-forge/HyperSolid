import { normalizeOrderbook, normalizeTrades, normalizeCandles } from "./detail";
import type { RawL2Book, RawTrade, RawCandle } from "./types";

const book: RawL2Book = {
  coin: "BTC",
  time: 1,
  levels: [
    [
      { px: "100", sz: "2", n: 1 },
      { px: "99", sz: "3", n: 1 },
    ],
    [
      { px: "101", sz: "1", n: 1 },
      { px: "102", sz: "4", n: 1 },
    ],
  ],
};

describe("normalizeOrderbook", () => {
  it("computes cumulative totals per side", () => {
    const ob = normalizeOrderbook(book);
    expect(ob.bids.map((b) => b.total)).toEqual([2, 5]);
    expect(ob.asks.map((a) => a.total)).toEqual([1, 5]);
  });

  it("computes spread and spreadPct from best bid/ask", () => {
    const ob = normalizeOrderbook(book);
    expect(ob.spread).toBe(1); // 101 - 100
    expect(ob.spreadPct).toBeCloseTo((1 / 100.5) * 100, 5);
  });

  it("respects depth limit", () => {
    const ob = normalizeOrderbook(book, 1);
    expect(ob.bids).toHaveLength(1);
    expect(ob.asks).toHaveLength(1);
  });

  it("handles empty levels without divide-by-zero", () => {
    const ob = normalizeOrderbook({ coin: "X", time: 0, levels: [[], []] });
    expect(ob.spread).toBe(0);
    expect(ob.spreadPct).toBe(0);
  });
});

describe("normalizeTrades", () => {
  it("maps side B/A to buy/sell and numbers", () => {
    const raw: RawTrade[] = [
      { coin: "BTC", side: "B", px: "100", sz: "1", time: 5, tid: 1 },
      { coin: "BTC", side: "A", px: "99", sz: "2", time: 6, tid: 2 },
    ];
    const out = normalizeTrades(raw);
    expect(out[0]).toEqual({ px: 100, sz: 1, side: "buy", time: 5, tid: 1 });
    expect(out[1].side).toBe("sell");
  });
});

describe("normalizeCandles", () => {
  it("maps OHLCV strings to numbers", () => {
    const raw: RawCandle[] = [
      { t: 1, T: 2, s: "BTC", o: "10", c: "12", h: "13", l: "9", v: "100", n: 5 },
    ];
    const out = normalizeCandles(raw);
    expect(out[0]).toEqual({ t: 1, open: 10, close: 12, high: 13, low: 9, volume: 100 });
  });
});
