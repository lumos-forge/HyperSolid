import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SqliteDeadManBudgetStore } from "./sqliteDeadManBudget";
import { makeDeadManBudget, DEADMAN_MAX_PER_DAY } from "./deadMan";

const TTL = 60_000;

function withFileStore(fn: (open: () => SqliteDeadManBudgetStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hs-deadman-"));
  const file = join(dir, "budget.db");
  const opened: SqliteDeadManBudgetStore[] = [];
  try {
    fn(() => {
      const s = SqliteDeadManBudgetStore.open(file);
      opened.push(s);
      return s;
    });
  } finally {
    for (const s of opened) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SqliteDeadManBudgetStore", () => {
  it("persists a counting arm across reopen (a restart does not reset the day's budget)", () => {
    withFileStore((open) => {
      const t = 0;
      const s1 = open();
      const d = s1.decide("0xo", t, TTL);
      expect(d).toEqual({ skip: false, time: t + TTL, counts: true });
      if (!d.skip) s1.record("0xo", t, d.time, d.counts);

      // reopen (simulated restart) — still same UTC day, schedule already future
      const s2 = open();
      expect(s2.decide("0xo", t + 1, TTL)).toEqual({ skip: false, time: t + 1 + TTL, counts: false });
    });
  });

  it("cannot exceed the daily budget after a restart (crash-loop safety)", () => {
    withFileStore((open) => {
      const s1 = open();
      // exhaust the day's counting budget; advance now past each armedUntil so each arm counts
      let t = 0;
      for (let i = 0; i < DEADMAN_MAX_PER_DAY; i++) {
        const d = s1.decide("0xo", t, 1_000);
        expect(d.skip).toBe(false);
        if (!d.skip) {
          expect(d.counts).toBe(true);
          s1.record("0xo", t, d.time, d.counts);
        }
        t += 2_000; // past the previous armedUntil so the next arm counts
      }
      // reopen — budget must remain exhausted for the same day
      const s2 = open();
      expect(s2.decide("0xo", t, 1_000)).toEqual({ skip: true });
    });
  });

  it("resets the counter on a new UTC day", () => {
    withFileStore((open) => {
      const DAY = 24 * 60 * 60 * 1000;
      const s1 = open();
      const d0 = s1.decide("0xo", 0, 10_000);
      if (!d0.skip) s1.record("0xo", 0, d0.time, d0.counts);
      const s2 = open();
      // next day, prior schedule long expired → a fresh counting arm
      expect(s2.decide("0xo", DAY + 1, 10_000)).toEqual({ skip: false, time: DAY + 1 + 10_000, counts: true });
    });
  });

  it("tracks owners independently", () => {
    withFileStore((open) => {
      const s = open();
      const da = s.decide("0xa", 0, TTL);
      if (!da.skip) s.record("0xa", 0, da.time, da.counts);
      expect(s.decide("0xb", 0, TTL)).toEqual({ skip: false, time: TTL, counts: true });
    });
  });

  it("matches the in-memory budget for the same call sequence (parity)", () => {
    withFileStore((open) => {
      const sql = open();
      const mem = makeDeadManBudget();
      const seq: Array<{ owner: string; now: number; ttl: number }> = [
        { owner: "0xo", now: 0, ttl: TTL },
        { owner: "0xo", now: 10, ttl: TTL }, // refresh (still armed) → counts:false
        { owner: "0xo", now: TTL + 5, ttl: TTL }, // armed expired → counts:true
        { owner: "0xp", now: TTL + 5, ttl: TTL },
      ];
      for (const c of seq) {
        const a = sql.decide(c.owner, c.now, c.ttl);
        const b = mem.decide(c.owner, c.now, c.ttl);
        expect(a).toEqual(b);
        if (!a.skip) sql.record(c.owner, c.now, a.time, a.counts);
        if (!b.skip) mem.record(c.owner, c.now, b.time, b.counts);
      }
    });
  });
});
