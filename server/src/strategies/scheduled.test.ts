import { scheduledDue } from "./scheduled";
import type { ScheduledParams } from "./types";

const P = (runAt: number): ScheduledParams => ({ coin: "BTC", side: "buy", sizeUsdc: 100, runAt });

describe("scheduledDue", () => {
  it("is false before runAt", () => {
    expect(scheduledDue(P(2000), 1999)).toBe(false);
  });

  it("is true at or after runAt", () => {
    expect(scheduledDue(P(2000), 2000)).toBe(true);
    expect(scheduledDue(P(2000), 2001)).toBe(true);
  });
});
