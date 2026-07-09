import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth, deadManClearAll, staleDeadManOwners } from "./deadMan";

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

describe("deadManHeartbeat", () => {
  const ttl = 60_000;
  const now = 2_000_000;

  it("arms and records each active owner once", async () => {
    const armed: Array<{ owner: string; time: number }> = [];
    const executor = { arm: jest.fn(async (owner: string, time: number) => { armed.push({ owner, time }); return true; }), clear: jest.fn(async () => true) };
    const budget = makeDeadManBudget();
    await deadManHeartbeat({ activeOwners: () => ["0xa", "0xb"], budget, executor, now: () => now, ttlMs: ttl });
    expect(armed).toEqual([{ owner: "0xa", time: now + ttl }, { owner: "0xb", time: now + ttl }]);
    expect(executor.arm).toHaveBeenCalledTimes(2);
  });

  it("dedups repeated owners", async () => {
    const executor = { arm: jest.fn(async () => true), clear: jest.fn(async () => true) };
    await deadManHeartbeat({ activeOwners: () => ["0xa", "0xa", "0xa"], budget: makeDeadManBudget(), executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).toHaveBeenCalledTimes(1);
  });

  it("does not arm when the budget says skip", async () => {
    const executor = { arm: jest.fn(async () => true), clear: jest.fn(async () => true) };
    const budget = { decide: () => ({ skip: true as const }), record: jest.fn() };
    await deadManHeartbeat({ activeOwners: () => ["0xa"], budget, executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).not.toHaveBeenCalled();
  });

  it("does not record when arm fails (retry next tick)", async () => {
    const executor = { arm: jest.fn(async () => false), clear: jest.fn(async () => true) };
    const record = jest.fn();
    const budget = { decide: () => ({ skip: false as const, time: now + ttl, counts: true }), record };
    await deadManHeartbeat({ activeOwners: () => ["0xa"], budget, executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).toHaveBeenCalledWith("0xa", now + ttl);
    expect(record).not.toHaveBeenCalled();
  });

  it("records a health failure and emits the event when arm fails", async () => {
    const events: Array<{ owner: string; kind: string }> = [];
    const executor = { arm: jest.fn(async () => false), clear: jest.fn(async () => true) };
    const health = makeDeadManHealth(1);
    await deadManHeartbeat({
      activeOwners: () => ["0xa"], budget: makeDeadManBudget(), executor,
      now: () => now, ttlMs: ttl, health,
      onHealthEvent: (owner, ev) => events.push({ owner, kind: ev.kind }),
    });
    expect(executor.arm).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ owner: "0xa", kind: "alert" }]);
  });

  it("counts a budget skip as an unprotected failure (no arm, health records false)", async () => {
    const events: Array<{ owner: string; kind: string }> = [];
    const executor = { arm: jest.fn(async () => true), clear: jest.fn(async () => true) };
    const budget = { decide: () => ({ skip: true as const }), record: jest.fn() };
    const health = makeDeadManHealth(1);
    await deadManHeartbeat({
      activeOwners: () => ["0xa"], budget, executor, now: () => now, ttlMs: ttl, health,
      onHealthEvent: (owner, ev) => events.push({ owner, kind: ev.kind }),
    });
    expect(executor.arm).not.toHaveBeenCalled();
    expect(events).toEqual([{ owner: "0xa", kind: "alert" }]);
  });

  it("records health success and emits recovered after an alert", async () => {
    const events: string[] = [];
    const health = makeDeadManHealth(1);
    health.record("0xa", false); // prime an alert
    const executor = { arm: jest.fn(async () => true), clear: jest.fn(async () => true) };
    await deadManHeartbeat({
      activeOwners: () => ["0xa"], budget: makeDeadManBudget(), executor,
      now: () => now, ttlMs: ttl, health,
      onHealthEvent: (_owner, ev) => events.push(ev.kind),
    });
    expect(events).toEqual(["recovered"]);
  });

  it("works without a health tracker (unchanged behavior)", async () => {
    const executor = { arm: jest.fn(async () => true), clear: jest.fn(async () => true) };
    await deadManHeartbeat({ activeOwners: () => ["0xa"], budget: makeDeadManBudget(), executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).toHaveBeenCalledWith("0xa", now + ttl);
  });
});

describe("makeDeadManHealth", () => {
  it("alerts only when consecutive failures reach the threshold", () => {
    const h = makeDeadManHealth(3);
    expect(h.record("0xo", false)).toEqual({ kind: "none" });
    expect(h.record("0xo", false)).toEqual({ kind: "none" });
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 3 });
  });

  it("does not repeat the alert while it stays failing", () => {
    const h = makeDeadManHealth(2);
    h.record("0xo", false);
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 2 });
    expect(h.record("0xo", false)).toEqual({ kind: "none" });
    expect(h.record("0xo", false)).toEqual({ kind: "none" });
  });

  it("emits recovered once after an alert, then stays quiet", () => {
    const h = makeDeadManHealth(2);
    h.record("0xo", false);
    h.record("0xo", false);
    expect(h.record("0xo", true)).toEqual({ kind: "recovered" });
    expect(h.record("0xo", true)).toEqual({ kind: "none" });
  });

  it("resets the streak on a success below the threshold (no alert)", () => {
    const h = makeDeadManHealth(3);
    h.record("0xo", false);
    h.record("0xo", false);
    expect(h.record("0xo", true)).toEqual({ kind: "none" });
    expect(h.record("0xo", false)).toEqual({ kind: "none" });
    expect(h.record("0xo", false)).toEqual({ kind: "none" });
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 3 });
  });

  it("can alert again after recovering", () => {
    const h = makeDeadManHealth(2);
    h.record("0xo", false);
    h.record("0xo", false);
    h.record("0xo", true);
    h.record("0xo", false);
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 2 });
  });

  it("tracks owners independently", () => {
    const h = makeDeadManHealth(2);
    h.record("0xa", false);
    expect(h.record("0xb", false)).toEqual({ kind: "none" });
    expect(h.record("0xa", false)).toEqual({ kind: "alert", consecutiveFailures: 2 });
  });

  it("defaults the threshold to 3", () => {
    const h = makeDeadManHealth();
    h.record("0xo", false);
    h.record("0xo", false);
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 3 });
  });
});

describe("deadManClearAll", () => {
  it("clears each deduped owner once", async () => {
    const cleared: string[] = [];
    const executor = { clear: jest.fn(async (owner: string) => { cleared.push(owner); return true; }) };
    await deadManClearAll({ activeOwners: () => ["0xa", "0xb", "0xa"], executor });
    expect(cleared).toEqual(["0xa", "0xb"]);
  });
  it("no-ops on an empty owner list", async () => {
    const executor = { clear: jest.fn(async () => true) };
    await deadManClearAll({ activeOwners: () => [], executor });
    expect(executor.clear).not.toHaveBeenCalled();
  });
  it("continues past a failing clear (best-effort)", async () => {
    const cleared: string[] = [];
    const executor = { clear: jest.fn(async (owner: string) => { cleared.push(owner); return owner !== "0xa"; }) };
    await deadManClearAll({ activeOwners: () => ["0xa", "0xb"], executor });
    expect(cleared).toEqual(["0xa", "0xb"]);
  });
});

describe("staleDeadManOwners", () => {
  it("returns deduped running owners that are not opted in", () => {
    expect(staleDeadManOwners(["0xa", "0xb", "0xa", "0xc"], ["0xb"])).toEqual(["0xa", "0xc"]);
  });
  it("returns empty when all running owners are opted in", () => {
    expect(staleDeadManOwners(["0xa", "0xb"], ["0xa", "0xb"])).toEqual([]);
  });
});
