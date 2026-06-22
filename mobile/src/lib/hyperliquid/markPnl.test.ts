import {
  unrealizedPnlFromMark,
  distanceToLiqPct,
  roePct,
  marginRatioPct,
  applyMarks,
} from "./markPnl";
import type { PortfolioSnapshot, Position } from "./types";

const pos = (over: Partial<Position>): Position => ({
  coin: "BTC",
  size: 0.5,
  side: "long",
  entryPx: 60000,
  positionValue: 30000,
  unrealizedPnl: 0,
  liquidationPx: 50000,
  marginUsed: 3000,
  leverage: 10,
  ...over,
});

describe("unrealizedPnlFromMark (mark price, not last trade)", () => {
  it("long: (mark - entry) * size", () => {
    expect(unrealizedPnlFromMark(pos({ side: "long", entryPx: 60000, size: 0.5 }), 62000)).toBe(1000);
    expect(unrealizedPnlFromMark(pos({ side: "long", entryPx: 60000, size: 0.5 }), 58000)).toBe(-1000);
  });
  it("short: (entry - mark) * size", () => {
    expect(unrealizedPnlFromMark(pos({ side: "short", entryPx: 60000, size: 0.5 }), 58000)).toBe(1000);
    expect(unrealizedPnlFromMark(pos({ side: "short", entryPx: 60000, size: 0.5 }), 62000)).toBe(-1000);
  });
});

describe("distanceToLiqPct", () => {
  it("computes |mark - liq| / mark * 100", () => {
    expect(distanceToLiqPct(60000, 54000)).toBeCloseTo(10, 6);
  });
  it("null when no liquidation price or non-positive mark", () => {
    expect(distanceToLiqPct(60000, null)).toBeNull();
    expect(distanceToLiqPct(0, 54000)).toBeNull();
  });
});

describe("roePct / marginRatioPct", () => {
  it("roe = uPnl / marginUsed * 100, 0 when no margin", () => {
    expect(roePct(300, 3000)).toBe(10);
    expect(roePct(300, 0)).toBe(0);
  });
  it("margin ratio = totalMarginUsed / accountValue * 100, null when no account value", () => {
    expect(marginRatioPct(10000, 2500)).toBe(25);
    expect(marginRatioPct(0, 2500)).toBeNull();
  });
});

describe("applyMarks (re-price portfolio from live marks)", () => {
  const snapshot: PortfolioSnapshot = {
    summary: {
      accountValue: 10000,
      totalNtlPos: 30000,
      totalMarginUsed: 3000,
      withdrawable: 7000,
      totalUnrealizedPnl: 0,
    },
    positions: [
      pos({ coin: "BTC", side: "long", entryPx: 60000, size: 0.5 }),
      pos({ coin: "ETH", side: "short", entryPx: 3000, size: 2, liquidationPx: 3600 }),
    ],
  };

  it("recomputes unrealizedPnl + positionValue from marks (string or number)", () => {
    const out = applyMarks(snapshot, { BTC: "62000", ETH: 2900 });
    const btc = out.positions.find((p) => p.coin === "BTC")!;
    const eth = out.positions.find((p) => p.coin === "ETH")!;
    expect(btc.unrealizedPnl).toBe(1000); // (62000-60000)*0.5
    expect(btc.positionValue).toBe(31000); // 62000*0.5
    expect(eth.unrealizedPnl).toBe(200); // (3000-2900)*2
    expect(eth.positionValue).toBe(5800); // 2900*2
  });

  it("recomputes account totals from re-priced positions", () => {
    const out = applyMarks(snapshot, { BTC: "62000", ETH: 2900 });
    expect(out.summary.totalUnrealizedPnl).toBe(1200);
    expect(out.summary.totalNtlPos).toBe(36800);
    expect(out.summary.accountValue).toBe(10000); // untouched
  });

  it("keeps snapshot values for positions without a mark, ignores invalid marks", () => {
    const out = applyMarks(snapshot, { BTC: "0" }); // 0 invalid; ETH absent
    const btc = out.positions.find((p) => p.coin === "BTC")!;
    expect(btc.unrealizedPnl).toBe(0); // unchanged
    expect(btc.positionValue).toBe(30000); // unchanged
  });

  it("handles an empty portfolio", () => {
    const empty: PortfolioSnapshot = { ...snapshot, positions: [] };
    const out = applyMarks(empty, { BTC: "62000" });
    expect(out.positions).toEqual([]);
    expect(out.summary.totalUnrealizedPnl).toBe(0);
    expect(out.summary.totalNtlPos).toBe(0);
  });
});
