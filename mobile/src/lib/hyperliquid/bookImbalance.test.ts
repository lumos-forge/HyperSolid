import { bookImbalance } from "./bookImbalance";

describe("bookImbalance", () => {
  it("returns bid/ask share of the top-N cumulative size", () => {
    const book = {
      bids: [{ px: 100, sz: 3, total: 3 }, { px: 99, sz: 1, total: 4 }],
      asks: [{ px: 101, sz: 1, total: 1 }, { px: 102, sz: 1, total: 2 }],
      spread: 1,
      spreadPct: 1,
    };
    const r = bookImbalance(book as never, 2);
    expect(r.bidPct).toBeCloseTo(66.67, 1); // 4 / (4+2)
    expect(r.askPct).toBeCloseTo(33.33, 1);
  });

  it("returns 50/50 for an empty book", () => {
    expect(bookImbalance({ bids: [], asks: [], spread: 0, spreadPct: 0 } as never, 5)).toEqual({
      bidPct: 50,
      askPct: 50,
    });
  });
});
