import { decideArm, nextArm, DEADMAN_MAX_PER_DAY } from "./deadManBudget";

describe("deadManBudget", () => {
  it("first arm counts; a still-future refresh is free", () => {
    const d0 = decideArm(undefined, 0, 60_000);
    expect(d0).toEqual({ skip: false, time: 60_000, counts: true });
    const b0 = nextArm(undefined, 0, 60_000, true);
    expect(decideArm(b0, 10_000, 60_000)).toEqual({ skip: false, time: 70_000, counts: false });
  });

  it("skips once the daily budget is exhausted", () => {
    let b = nextArm(undefined, 0, 1_000, true);
    let t = 2_000;
    for (let i = 1; i < DEADMAN_MAX_PER_DAY; i++) {
      const d = decideArm(b, t, 1_000);
      expect(d.skip).toBe(false);
      if (!d.skip) b = nextArm(b, t, d.time, d.counts);
      t += 2_000;
    }
    expect(decideArm(b, t, 1_000)).toEqual({ skip: true });
  });

  it("resets the counter on a new UTC day", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const b = nextArm(undefined, 0, 1_000, true);
    expect(decideArm(b, DAY + 1, 10_000)).toEqual({ skip: false, time: DAY + 1 + 10_000, counts: true });
  });
});
