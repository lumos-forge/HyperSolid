import { gridStep, bandIndex, gridAction, targetNetUsdc } from "./grid";
import type { GridParams } from "./types";

const P: GridParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
// levels=6 -> step=20, lines: 100,120,140,160,180,200 (indices 0..5)

describe("gridStep", () => {
  it("is (upper-lower)/(levels-1)", () => {
    expect(gridStep(P)).toBe(20);
  });
  it("is 0 for a single level", () => {
    expect(gridStep({ ...P, levels: 1 })).toBe(0);
  });
});

describe("bandIndex", () => {
  const step = gridStep(P);
  it("maps a mark to the nearest grid line", () => {
    expect(bandIndex(139, P.lowerPrice, step, P.levels)).toBe(2); // 140
    expect(bandIndex(151, P.lowerPrice, step, P.levels)).toBe(3); // 160 (nearest)
  });
  it("clamps below the range to 0 and above to levels-1", () => {
    expect(bandIndex(50, P.lowerPrice, step, P.levels)).toBe(0);
    expect(bandIndex(999, P.lowerPrice, step, P.levels)).toBe(5);
  });
});

describe("gridAction", () => {
  it("buys the crossed distance on a down-cross", () => {
    expect(gridAction(4, 2, P.perLevelUsdc)).toEqual({ side: "buy", usdc: 100, targetLevel: 2 });
  });
  it("sells the crossed distance on an up-cross", () => {
    expect(gridAction(1, 3, P.perLevelUsdc)).toEqual({ side: "sell", usdc: 100, targetLevel: 3 });
  });
  it("returns null when the band is unchanged", () => {
    expect(gridAction(3, 3, P.perLevelUsdc)).toBeNull();
  });
});

describe("targetNetUsdc", () => {
  it("is perLevel*(centerBand-band); max long at the bottom, max short at the top (even levels)", () => {
    // levels=6 -> centerBand=2.5
    expect(targetNetUsdc(0, 6, 50)).toBe(125);
    expect(targetNetUsdc(5, 6, 50)).toBe(-125);
    expect(targetNetUsdc(2, 6, 50)).toBe(25);
    expect(targetNetUsdc(3, 6, 50)).toBe(-25);
  });
  it("is 0 at the exact center for odd levels", () => {
    // levels=5 -> centerBand=2
    expect(targetNetUsdc(2, 5, 50)).toBe(0);
    expect(targetNetUsdc(0, 5, 50)).toBe(100);
    expect(targetNetUsdc(4, 5, 50)).toBe(-100);
  });
});
