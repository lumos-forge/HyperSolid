import { formatCountdown } from "./formatCountdown";

describe("formatCountdown", () => {
  it("shows minutes only under one hour", () => {
    expect(formatCountdown(900_000)).toBe("15m");
    expect(formatCountdown(60_000)).toBe("1m");
    expect(formatCountdown(30_000)).toBe("0m");
  });
  it("shows hours and minutes at or above one hour", () => {
    expect(formatCountdown(3_600_000)).toBe("1h 0m");
    expect(formatCountdown(8_100_000)).toBe("2h 15m");
  });
});
