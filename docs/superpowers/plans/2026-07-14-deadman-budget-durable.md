# Durable Dead-Man Budget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the dead-man switch's arm budget (`{day, count, armedUntil}` per owner) in SQLite so the HL 10/day counting-arm budget survives engine restarts — a crash-loop can no longer silently exceed HL's limit and disable dead-man protection.

**Architecture:** Extract the two pure budget transitions (`decideBudget` / `nextBudget`) from the in-memory `makeDeadManBudget` in `deadMan.ts`; both the in-memory `Map` backend and a new `SqliteDeadManBudgetStore` call them, so behavior is identical by construction. Wire the SQLite store in `index.ts`. The `deadManHeartbeat` and the `DeadManBudget` interface are unchanged.

**Tech Stack:** TypeScript (server/), `better-sqlite3` (synchronous), Jest.

**Spec:** `docs/superpowers/specs/2026-07-14-deadman-budget-durable-design.md`

---

## Background / invariants (read first)

- `deadMan.ts` already defines `DAY_MS = 24*60*60*1000`, `DEADMAN_MAX_PER_DAY = 10`, `DeadManDecision`, the `DeadManBudget` interface (`decide`/`record`), and `makeDeadManBudget()` (in-memory `Map`, private `interface OwnerState { day; count; armedUntil }`).
- Current in-memory logic (to preserve exactly):
  - `decide(owner, nowMs, ttlMs)`: `time = nowMs+ttlMs`; `day = floor(nowMs/DAY_MS)`; `count = prev && prev.day===day ? prev.count : 0`; `armedUntil = prev ? prev.armedUntil : 0`; if `armedUntil > nowMs` → `{skip:false, time, counts:false}`; else if `count >= DEADMAN_MAX_PER_DAY` → `{skip:true}`; else `{skip:false, time, counts:true}`.
  - `record(owner, nowMs, time, counts)`: `day = floor(nowMs/DAY_MS)`; `base = prev && prev.day===day ? prev.count : 0`; store `{day, count: base + (counts?1:0), armedUntil: time}`.
- **Owner casing:** the in-memory budget keys by the raw `owner` string (NO lowercasing). The SQLite store MUST do the same (key by raw `owner`) to keep parity — do not lowercase.
- The existing `deadMan.test.ts` `makeDeadManBudget` cases must pass **unchanged** after the refactor.
- The SQLite store follows the existing pattern (`SqliteActivityStore.open(path)` in `server/src/strategies/activityStore.ts`): `new Database(path)`, `pragma("journal_mode = WAL")`, `CREATE TABLE IF NOT EXISTS`, a private constructor, a `close()`.

**Files:**
- Modify: `server/src/engine/deadMan.ts` — extract `OwnerBudget`, `decideBudget`, `nextBudget`; refactor `makeDeadManBudget` to use them.
- Create: `server/src/engine/sqliteDeadManBudget.ts` — `SqliteDeadManBudgetStore`.
- Create: `server/src/engine/sqliteDeadManBudget.test.ts`
- Modify: `server/src/index.ts` — use `SqliteDeadManBudgetStore.open(dbPath)`; drop the now-unused `makeDeadManBudget` import.

---

## Task 1: Extract pure budget transitions in `deadMan.ts`

**Files:**
- Modify: `server/src/engine/deadMan.ts`

- [ ] **Step 1: Refactor — replace the `OwnerState` interface + `makeDeadManBudget` body**

In `server/src/engine/deadMan.ts`, replace this block:

```ts
interface OwnerState {
  day: number;
  count: number;
  armedUntil: number;
}

export function makeDeadManBudget(): DeadManBudget {
  const state = new Map<string, OwnerState>();
  return {
    decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision {
      const time = nowMs + ttlMs;
      const day = Math.floor(nowMs / DAY_MS);
      const prev = state.get(owner);
      const count = prev && prev.day === day ? prev.count : 0;
      const armedUntil = prev ? prev.armedUntil : 0;
      if (armedUntil > nowMs) return { skip: false, time, counts: false };
      if (count >= DEADMAN_MAX_PER_DAY) return { skip: true };
      return { skip: false, time, counts: true };
    },
    record(owner: string, nowMs: number, time: number, counts: boolean): void {
      const day = Math.floor(nowMs / DAY_MS);
      const prev = state.get(owner);
      const base = prev && prev.day === day ? prev.count : 0;
      state.set(owner, { day, count: base + (counts ? 1 : 0), armedUntil: time });
    },
  };
}
```

with:

```ts
/** Per-owner dead-man arm budget: the UTC day, that day's counting-arm count, and the armed-until time
 *  (ms). Persisted so the 10/day budget survives restarts. */
export interface OwnerBudget {
  day: number;
  count: number;
  armedUntil: number;
}

/** Pure decision from the owner's prior budget (or undefined) at nowMs: a free refresh (still-future
 *  schedule), a counting new-arm, or skip when the day's budget is exhausted. Shared by every backend. */
export function decideBudget(prev: OwnerBudget | undefined, nowMs: number, ttlMs: number): DeadManDecision {
  const time = nowMs + ttlMs;
  const day = Math.floor(nowMs / DAY_MS);
  const count = prev && prev.day === day ? prev.count : 0;
  const armedUntil = prev ? prev.armedUntil : 0;
  if (armedUntil > nowMs) return { skip: false, time, counts: false };
  if (count >= DEADMAN_MAX_PER_DAY) return { skip: true };
  return { skip: false, time, counts: true };
}

/** Pure state transition for a SUCCESSFUL send: armedUntil=time; increment the day's counter iff counts
 *  (resetting the counter on a new UTC day). Shared by every backend. */
export function nextBudget(prev: OwnerBudget | undefined, nowMs: number, time: number, counts: boolean): OwnerBudget {
  const day = Math.floor(nowMs / DAY_MS);
  const base = prev && prev.day === day ? prev.count : 0;
  return { day, count: base + (counts ? 1 : 0), armedUntil: time };
}

export function makeDeadManBudget(): DeadManBudget {
  const state = new Map<string, OwnerBudget>();
  return {
    decide: (owner, nowMs, ttlMs) => decideBudget(state.get(owner), nowMs, ttlMs),
    record: (owner, nowMs, time, counts) => {
      state.set(owner, nextBudget(state.get(owner), nowMs, time, counts));
    },
  };
}
```

- [ ] **Step 2: Verify the in-memory budget tests still pass unchanged**

Run: `cd server && npx jest src/engine/deadMan.test.ts`
Expected: PASS (all existing `makeDeadManBudget` + heartbeat cases — the extraction is behavior-preserving).

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/engine/deadMan.ts
git commit -m "refactor(engine): extract pure dead-man budget transitions

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `SqliteDeadManBudgetStore`

**Files:**
- Create: `server/src/engine/sqliteDeadManBudget.ts`
- Create: `server/src/engine/sqliteDeadManBudget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/engine/sqliteDeadManBudget.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/engine/sqliteDeadManBudget.test.ts`
Expected: FAIL — `Cannot find module './sqliteDeadManBudget'`.

- [ ] **Step 3: Create `server/src/engine/sqliteDeadManBudget.ts`**

```ts
import Database from "better-sqlite3";
import { decideBudget, nextBudget, type DeadManBudget, type DeadManDecision, type OwnerBudget } from "./deadMan";

interface Row {
  day: number;
  count: number;
  armed_until: number;
}

/**
 * Durable `DeadManBudget` over SQLite: the per-owner `{day, count, armedUntil}` survives restarts, so a
 * crash-loop or frequent deploys cannot reset the 10/day counting-arm budget and exceed HL's real limit
 * (which would silently disable the dead-man switch). Shares the pure decision/transition logic with the
 * in-memory budget, so behavior is identical. One row per owner; day rollover is handled in the pure
 * functions, so no cleanup is needed. Owner is keyed as-is (no lowercasing), matching the in-memory budget.
 */
export class SqliteDeadManBudgetStore implements DeadManBudget {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqliteDeadManBudgetStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS dead_man_budget (
        owner TEXT PRIMARY KEY,
        day INTEGER NOT NULL,
        count INTEGER NOT NULL,
        armed_until INTEGER NOT NULL
      );
    `);
    return new SqliteDeadManBudgetStore(db);
  }

  private get(owner: string): OwnerBudget | undefined {
    const row = this.db
      .prepare("SELECT day, count, armed_until FROM dead_man_budget WHERE owner = ?")
      .get(owner) as Row | undefined;
    return row ? { day: row.day, count: row.count, armedUntil: row.armed_until } : undefined;
  }

  decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision {
    return decideBudget(this.get(owner), nowMs, ttlMs);
  }

  record(owner: string, nowMs: number, time: number, counts: boolean): void {
    const next = nextBudget(this.get(owner), nowMs, time, counts);
    this.db
      .prepare(
        `INSERT INTO dead_man_budget (owner, day, count, armed_until)
         VALUES (@owner, @day, @count, @armedUntil)
         ON CONFLICT(owner) DO UPDATE SET day = excluded.day, count = excluded.count, armed_until = excluded.armed_until`,
      )
      .run({ owner, day: next.day, count: next.count, armedUntil: next.armedUntil });
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest src/engine/sqliteDeadManBudget.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/engine/sqliteDeadManBudget.ts server/src/engine/sqliteDeadManBudget.test.ts
git commit -m "feat(engine): durable SQLite dead-man budget store

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Wire the durable budget in `index.ts` + validate

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add the import**

In `server/src/index.ts`, add (near the other engine imports):

```ts
import { SqliteDeadManBudgetStore } from "./engine/sqliteDeadManBudget";
```

- [ ] **Step 2: Drop the now-unused `makeDeadManBudget` import**

The existing import line is:

```ts
import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth, deadManClearAll, staleDeadManOwners } from "./engine/deadMan";
```

Change it to (remove `makeDeadManBudget`):

```ts
import { deadManHeartbeat, makeDeadManHealth, deadManClearAll, staleDeadManOwners } from "./engine/deadMan";
```

- [ ] **Step 3: Use the durable store**

Replace:

```ts
  const deadManBudget = makeDeadManBudget();
```

with:

```ts
  const deadManBudget = SqliteDeadManBudgetStore.open(dbPath);
```

- [ ] **Step 4: Typecheck + full suite**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (existing 456 + the new `sqliteDeadManBudget` cases; `deadMan.test.ts` unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(engine): use durable dead-man budget in the composition root

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Finish — PR, review, merge

- [ ] **Step 1: Full validation**

Run: `cd server && npm run typecheck && npm test`
Expected: tsc clean; all suites green.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/deadman-budget-durable
```

- [ ] **Step 3: Open the PR** (`gh pr create`) summarizing: durable dead-man budget (SQLite) so the HL 10/day counting-arm budget survives restarts; pure-function extraction gives in-memory/SQLite parity; heartbeat behavior unchanged.

- [ ] **Step 4:** Dispatch a background `code-review` agent on the branch diff AND `gh pr checks <n> --watch` in parallel.

- [ ] **Step 5:** Address any high-confidence findings; on clean review + green CI, squash-merge with `--delete-branch` and sync `main` (standing rule).

---

## Self-review notes (coverage vs spec)

- **Shared pure logic (`decideBudget`/`nextBudget`)** — Task 1; existing in-memory tests stay green (parity by construction). ✔
- **SQLite store (`dead_man_budget` table, decide read / record upsert)** — Task 2. ✔
- **Persist `day/count/armedUntil`; budget survives restart; crash-loop cannot exceed 10/day** — Task 2 tests (persist-across-reopen, cap-after-restart). ✔
- **Free refresh after restart (counts:false when still armed)** — Task 2 persist-across-reopen test. ✔
- **Day rollover resets count** — Task 2 test. ✔
- **Owner keyed as-is (no lowercasing) for parity** — noted in store JSDoc + parity test. ✔
- **Wiring in `index.ts`, heartbeat unchanged** — Task 3. ✔
- **Additive `CREATE TABLE IF NOT EXISTS`, no data migration** — Task 2 store. ✔
