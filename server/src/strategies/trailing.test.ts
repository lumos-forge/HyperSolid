import { updateTrailPeak, trailingTriggered } from "./trailing";
import type { TrailingParams } from "./types";

const P = (trailPct: number): TrailingParams => ({ coin: "BTC", trailPct });

describe("updateTrailPeak", () => {
  it("long: seeds at mark then keeps the running max", () => {
    expect(updateTrailPeak(1, 100, undefined)).toBe(100);
    expect(updateTrailPeak(1, 110, 100)).toBe(110);
    expect(updateTrailPeak(1, 105, 110)).toBe(110); // dip ignored
  });

  it("short: seeds at mark then keeps the running min", () => {
    expect(updateTrailPeak(-1, 100, undefined)).toBe(100);
    expect(updateTrailPeak(-1, 90, 100)).toBe(90);
    expect(updateTrailPeak(-1, 95, 90)).toBe(90); // rise ignored
  });
});

describe("trailingTriggered", () => {
  it("long triggers when mark retraces trailPct% below the peak", () => {
    expect(trailingTriggered(P(5), 1, 95, 100)).toBe(true);  // 95 <= 95
    expect(trailingTriggered(P(5), 1, 96, 100)).toBe(false); // 96 > 95
  });

  it("short triggers when mark retraces trailPct% above the trough", () => {
    expect(trailingTriggered(P(5), -1, 105, 100)).toBe(true);  // 105 >= 105
    expect(trailingTriggered(P(5), -1, 104, 100)).toBe(false); // 104 < 105
  });

  it("flat position never triggers", () => {
    expect(trailingTriggered(P(5), 0, 50, 100)).toBe(false);
  });
});
