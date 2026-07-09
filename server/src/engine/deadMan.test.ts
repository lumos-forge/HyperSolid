import { makeDeadManBudget } from "./deadMan";

const DAY = 24 * 60 * 60 * 1000;

describe("makeDeadManBudget", () => {
  it("first arm counts; a refresh while still armed is free", () => {
    const b = makeDeadManBudget();
    const t0 = 1_000_000;
    const d1 = b.decide("0xo", t0, 60_000);
    expect(d1).toEqual({ skip: false, time: t0 + 60_000, counts: true });
    b.record("0xo", t0, d1.skip ? 0 : d1.time, d1.skip ? false : d1.counts);
    const t1 = t0 + 30_000;
    const d2 = b.decide("0xo", t1, 60_000);
    expect(d2).toEqual({ skip: false, time: t1 + 60_000, counts: false });
  });

  it("skips a new arm once the daily budget of 10 is exhausted", () => {
    const b = makeDeadManBudget();
    let t = 1_000_000;
    for (let i = 0; i < 10; i++) {
      const d = b.decide("0xo", t, 1_000);
      expect(d.skip).toBe(false);
      if (!d.skip) {
        expect(d.counts).toBe(true);
        b.record("0xo", t, d.time, d.counts);
      }
      t += 2_000;
    }
    expect(b.decide("0xo", t, 1_000)).toEqual({ skip: true });
  });

  it("re-arms (counts) after the schedule expired", () => {
    const b = makeDeadManBudget();
    const t0 = 1_000_000;
    const d0 = b.decide("0xo", t0, 10_000);
    b.record("0xo", t0, (d0 as any).time, (d0 as any).counts);
    const t1 = t0 + 20_000;
    expect(b.decide("0xo", t1, 10_000)).toEqual({ skip: false, time: t1 + 10_000, counts: true });
  });

  it("resets the daily count at the UTC day boundary but keeps an armed schedule free", () => {
    const b = makeDeadManBudget();
    const t0 = 5 * DAY + 1_000;
    const d0 = b.decide("0xo", t0, 3 * DAY);
    b.record("0xo", t0, (d0 as any).time, (d0 as any).counts);
    const t1 = 6 * DAY + 1_000;
    const d1 = b.decide("0xo", t1, 3 * DAY);
    expect(d1).toEqual({ skip: false, time: t1 + 3 * DAY, counts: false });
  });

  it("tracks owners independently", () => {
    const b = makeDeadManBudget();
    const t = 1_000_000;
    const da = b.decide("0xa", t, 60_000);
    b.record("0xa", t, (da as any).time, (da as any).counts);
    expect(b.decide("0xb", t, 60_000)).toEqual({ skip: false, time: t + 60_000, counts: true });
  });
});
