import { gridLimitStep, gridLimitLine, rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable } from "./gridLimit";
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
