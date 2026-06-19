import { formatCompact, formatSignedPct, formatFundingPct, formatTimeHMS } from "./format";

describe("formatCompact", () => {
  it("formats billions/millions/thousands", () => {
    expect(formatCompact(1.234e9)).toBe("1.23B");
    expect(formatCompact(2.5e6)).toBe("2.50M");
    expect(formatCompact(3400)).toBe("3.40K");
    expect(formatCompact(12.5)).toBe("12.50");
  });
  it("handles negatives", () => {
    expect(formatCompact(-2.5e6)).toBe("-2.50M");
  });
});

describe("formatSignedPct", () => {
  it("adds + for non-negative", () => {
    expect(formatSignedPct(2.43)).toBe("+2.43%");
    expect(formatSignedPct(-0.86)).toBe("-0.86%");
    expect(formatSignedPct(0)).toBe("+0.00%");
  });
});

describe("formatFundingPct", () => {
  it("formats small funding fractions to 4dp percent", () => {
    expect(formatFundingPct(0.0000125)).toBe("+0.0013%");
    expect(formatFundingPct(-0.0001)).toBe("-0.0100%");
  });
});

describe("formatTimeHMS", () => {
  it("formats to HH:MM:SS", () => {
    const ms = new Date(2026, 0, 1, 9, 5, 3).getTime();
    expect(formatTimeHMS(ms)).toBe("09:05:03");
  });
});
