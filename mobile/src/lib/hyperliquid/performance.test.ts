import { periodReturns } from "./performance";

describe("periodReturns", () => {
  it("computes signed percent change for each anchor against the latest close", () => {
    // 11 daily closes, latest = 110, 1-day-ago = 100 -> +10%
    const closes = [50, 60, 70, 80, 90, 95, 100, 102, 105, 100, 110];
    const out = periodReturns(closes, [{ label: "1D", days: 1 }, { label: "10D", days: 10 }]);
    expect(out[0]).toEqual({ label: "1D", pct: 10 }); // (110-100)/100
    expect(out[1]).toEqual({ label: "10D", pct: 120 }); // (110-50)/50
  });

  it("returns null pct when there is not enough history", () => {
    const out = periodReturns([100, 110], [{ label: "30D", days: 30 }]);
    expect(out[0]).toEqual({ label: "30D", pct: null });
  });
});
