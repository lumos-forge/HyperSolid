import { gridLimitStep, gridLimitLine, rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable, rungCenter, rungIsShort, armableShort, rungShortSizeCoin } from "./gridLimit";
import type { GridLimitParams } from "./types";

const P: GridLimitParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
// step 20; lines 100,120,140,160,180,200 (idx 0..5); rungs 0..4

describe("grid-limit geometry", () => {
  it("computes step and lines", () => {
    expect(gridLimitStep(P)).toBe(20);
    expect(gridLimitLine(P, 0)).toBe(100);
    expect(gridLimitLine(P, 5)).toBe(200);
  });
  it("has levels-1 rungs with buy@i / sell@i+1", () => {
    expect(rungCount(P)).toBe(5);
    expect(rungBuyPrice(P, 2)).toBe(140);
    expect(rungSellPrice(P, 2)).toBe(160);
  });
  it("sizes a rung's buy in coin = perLevelUsdc / buyPrice", () => {
    expect(rungSizeCoin(P, 4)).toBeCloseTo(50 / 180, 9); // line[4]=180
  });
  it("is armable only when the buy line is strictly below mark", () => {
    expect(armable(P, 2, 150)).toBe(true); // 140 < 150
    expect(armable(P, 3, 150)).toBe(false); // 160 !< 150
    expect(armable(P, 2, 140)).toBe(false); // 140 !< 140
  });
});

describe("grid-limit symmetric geometry", () => {
  it("computes rung center as the midpoint of its buy/sell lines", () => {
    expect(rungCenter(P, 2)).toBe(150); // (140+160)/2
    expect(rungCenter(P, 0)).toBe(110); // (100+120)/2
  });
  it("marks a rung short when its center is at/above the mark", () => {
    expect(rungIsShort(P, 2, 150)).toBe(true);  // center 150 >= 150
    expect(rungIsShort(P, 1, 150)).toBe(false); // center 130 < 150
    expect(rungIsShort(P, 3, 150)).toBe(true);  // center 170 >= 150
  });
  it("arms a maker sell only when the sell line is strictly above the mark", () => {
    expect(armableShort(P, 2, 150)).toBe(true);  // sell 160 > 150
    expect(armableShort(P, 2, 160)).toBe(false); // sell 160 not > 160
  });
  it("sizes a short rung in coin = perLevelUsdc / sellPrice", () => {
    expect(rungShortSizeCoin(P, 2)).toBeCloseTo(50 / 160, 9); // sell line[3]=160
  });
});
