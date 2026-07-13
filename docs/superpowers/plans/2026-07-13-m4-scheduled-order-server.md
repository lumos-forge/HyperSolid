# M4 Scheduled (Time-Triggered Entry) Strategy (server) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scheduled` strategy that opens a position at market once `now >= runAt`, gated by risk caps, completing after one fill.

**Architecture:** New `kind: "scheduled"` + `ScheduledParams { coin, side, sizeUsdc, runAt }`, a pure `scheduledDue`, and a time-gated scheduler block (outside the marks region) mirroring the DCA opening path with a restart-stable cloid. No persisted state / schema change.

**Tech Stack:** TypeScript, better-sqlite3, jest.

Spec: `docs/superpowers/specs/2026-07-13-m4-scheduled-order-server-design.md`

---

## Task 1: Types + `scheduled.ts` pure logic + build() case

**Files:**
- Modify: `server/src/strategies/types.ts`
- Modify: `server/src/strategies/store.ts`
- Create: `server/src/strategies/scheduled.ts`
- Create: `server/src/strategies/scheduled.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/strategies/scheduled.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/scheduled.test.ts`
Expected: FAIL — `Cannot find module './scheduled'` (and `ScheduledParams` not exported).

- [ ] **Step 3: Extend the types**

In `server/src/strategies/types.ts`:

Replace:
```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional";
```
with:
```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional" | "scheduled";
```

Add the params interface after `ConditionalParams`:
```ts
export interface ScheduledParams extends StrategyParamsCommon {
  coin: string;
  side: "buy" | "sell";
  /** Notional (USDC) to open at market when the time arrives. */
  sizeUsdc: number;
  /** Absolute trigger time (epoch ms); the client computes it from a date/delay. */
  runAt: number;
}
```

Add to the `StrategyParams` union:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams | ConditionalParams | ScheduledParams;
```

Add the `Strategy` union member (after the `conditional` member):
```ts
  | (StrategyBase & { kind: "scheduled"; params: ScheduledParams });
```

- [ ] **Step 4: Add the build() case (keeps the widened union typechecking)**

In `server/src/strategies/store.ts`, extend the `./types` import to include
`ScheduledParams`:
```ts
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, ConditionalParams, ScheduledParams } from "./types";
```
In the module `build(...)` function, add a `scheduled` case before the final `return`
(next to the `conditional` case):
```ts
  if (kind === "scheduled") return { ...base, kind, params: params as ScheduledParams };
```

- [ ] **Step 5: Implement the logic**

Create `server/src/strategies/scheduled.ts`:
```ts
import type { ScheduledParams } from "./types";

/** True when the scheduled trigger time has arrived. */
export function scheduledDue(p: ScheduledParams, now: number): boolean {
  return now >= p.runAt;
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `cd server && npx jest src/strategies/scheduled.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/types.ts server/src/strategies/store.ts server/src/strategies/scheduled.ts server/src/strategies/scheduled.test.ts && git commit -m "feat(m4): scheduled-order types + due logic + build case"
```

---

## Task 2: Validation

**Files:**
- Modify: `server/src/strategies/validate.ts`
- Modify: `server/src/strategies/validate.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/strategies/validate.test.ts`, add:
```ts
describe("validateParams scheduled", () => {
  it("accepts a valid scheduled config", () => {
    const r = validateParams("scheduled", { coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 1893456000000 });
    expect(r).toEqual({ ok: true, params: { coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 1893456000000 } });
  });

  it("carries deadMan through", () => {
    const r = validateParams("scheduled", { coin: "ETH", side: "sell", sizeUsdc: 50, runAt: 1893456000000, deadMan: true });
    expect(r).toEqual({ ok: true, params: { coin: "ETH", side: "sell", sizeUsdc: 50, runAt: 1893456000000, deadMan: true } });
  });

  it("rejects a bad side / size / runAt / coin", () => {
    expect(validateParams("scheduled", { coin: "BTC", side: "long", sizeUsdc: 100, runAt: 1893456000000 }).ok).toBe(false);
    expect(validateParams("scheduled", { coin: "BTC", side: "buy", sizeUsdc: 0, runAt: 1893456000000 }).ok).toBe(false);
    expect(validateParams("scheduled", { coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 0 }).ok).toBe(false);
    expect(validateParams("scheduled", { coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 1.5 }).ok).toBe(false);
    expect(validateParams("scheduled", { side: "buy", sizeUsdc: 100, runAt: 1893456000000 }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/validate.test.ts -t "scheduled"`
Expected: FAIL — the `scheduled` kind currently returns `unknown strategy kind`.

- [ ] **Step 3: Add the validation branch**

In `server/src/strategies/validate.ts`, add `ScheduledParams` to the type import:
```ts
import type { StrategyKind, StrategyParams, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, ConditionalParams, ScheduledParams } from "./types";
```
Then add this branch immediately before the final `return { ok: false, error: "unknown strategy kind" };`:
```ts
  if (kind === "scheduled") {
    const c = p as unknown as ScheduledParams;
    if (c.side !== "buy" && c.side !== "sell") return { ok: false, error: "scheduled side must be buy or sell" };
    if (!positiveNumber(c.sizeUsdc)) return { ok: false, error: "sizeUsdc must be > 0" };
    if (!positiveInteger(c.runAt)) return { ok: false, error: "runAt must be a positive epoch-ms timestamp" };
    return { ok: true, params: { coin, side: c.side, sizeUsdc: c.sizeUsdc, runAt: c.runAt, ...(deadMan ? { deadMan: true } : {}) } };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/strategies/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/validate.ts server/src/strategies/validate.test.ts && git commit -m "feat(m4): validate scheduled params (side/size/runAt)"
```

---

## Task 3: Sqlite persistence

**Files:**
- Modify: `server/src/strategies/sqliteStore.ts`
- Modify: `server/src/strategies/sqliteStore.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/strategies/sqliteStore.test.ts`, add:
```ts
  it("round-trips a scheduled strategy", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const s = store.create("0xOwner", "scheduled", { coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 1893456000000 });
    expect(store.get(s.id)).toMatchObject({
      kind: "scheduled",
      status: "running",
      params: { coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 1893456000000 },
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts -t "scheduled"`
Expected: FAIL — `toStrategy` maps the row to `dca` (fallback), so `kind` mismatches.

- [ ] **Step 3: Add the toStrategy branch + scheduled=0**

In `server/src/strategies/sqliteStore.ts`, add a `scheduled` branch in `toStrategy`
before the final `dca` return:
```ts
  if (row.kind === "scheduled") return { ...base, kind: "scheduled", params };
```
And add `"scheduled"` to the mark-driven/no-interval `scheduled` list in `create`:
```ts
    const scheduled = kind === "tpsl" || kind === "grid" || kind === "gridLimit" || kind === "trailing" || kind === "conditional" || kind === "scheduled" ? 0 : now;
```

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/sqliteStore.ts server/src/strategies/sqliteStore.test.ts && git commit -m "feat(m4): persist scheduled strategy (sqlite toStrategy + scheduled)"
```

---

## Task 4: Scheduler scheduled block

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Modify: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/src/engine/scheduler.test.ts`, add (using the existing `placerFake()` helper
and the 7-arg `tick(store, placer, limits, killSwitch, now, activity?, marks?)`; the
scheduled block does not use `marks`):
```ts
describe("scheduled entry", () => {
  const sched = (over: any = {}) => ({ coin: "BTC", side: "buy", sizeUsdc: 100, runAt: 5000, ...over });

  it("opens a market position and completes once runAt has passed", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 5000);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("fires a sell side too", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "scheduled", sched({ side: "sell", runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 6000);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "sell", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("does not fire before runAt", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 4999);
    expect(placer.calls).toHaveLength(0);
  });

  it("kill-switch blocks the scheduled entry", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, true, 5000);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the per-coin notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ sizeUsdc: 100, runAt: 5000 }));
    await tick(store, placer, { maxNotionalUsdc: 1000, perCoinMaxNotionalUsdc: { BTC: 50 } }, false, 5000);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the daily notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "scheduled", sched({ sizeUsdc: 100, runAt: 5000 }));
    const activity = { record: () => {}, notionalSince: () => 60 } as any;
    await tick(store, placer, { maxNotionalUsdc: 1e9, dailyMaxNotionalUsdc: 100 }, false, 5000, activity);
    expect(placer.calls).toHaveLength(0); // 60 + 100 > 100
  });

  it("uses a restart-stable cloid so a replay dedupes instead of double-opening", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const calls: any[] = [];
    const placer = { place: async (r: any) => { calls.push(r); return { ok: false }; } };
    store.create("0xo", "scheduled", sched({ runAt: 5000 }));
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 5000);
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 6000); // later `now`
    expect(calls).toHaveLength(2);
    expect(calls[0].cloid).toBe(calls[1].cloid);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/engine/scheduler.test.ts -t "scheduled entry"`
Expected: FAIL — no scheduled handling in the scheduler.

- [ ] **Step 3: Add the import**

In `server/src/engine/scheduler.ts`, add the logic import next to the conditional import:
```ts
import { scheduledDue } from "../strategies/scheduled";
```
and add `ScheduledParams` to the existing types import:
```ts
import type { DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, ConditionalParams, ScheduledParams } from "../strategies/types";
```

- [ ] **Step 4: Add the scheduled block**

In `server/src/engine/scheduler.ts`, immediately before the `// --- TP/SL:` comment
(i.e. after the TWAP `for (const s of dueTwap(all, now)) { ... }` block and OUTSIDE any
`if (marks)`), insert:
```ts
  // --- Scheduled: time-triggered market entry (one-shot) ---
  for (const s of all) {
    if (s.kind !== "scheduled" || s.status !== "running") continue;
    const p = s.params as ScheduledParams;
    if (!scheduledDue(p, now)) continue;
    const notionalUsdc = p.sizeUsdc;
    if (!withinCaps({ notionalUsdc, killSwitch, coin: p.coin }, limits).ok) continue;
    if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
      const spentToday = activity.notionalSince(s.owner, dayStartUtcMs(now));
      if (spentToday + notionalUsdc > limits.dailyMaxNotionalUsdc) continue;
    }
    const cloid = cloidForKey(s.id, "scheduled");
    const res = await placer.place({ owner: s.owner, coin: p.coin, sizeUsdc: notionalUsdc, cloid, side: p.side, reduceOnly: false });
    if (res.ok) {
      if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
        activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: p.side, sz: res.filledSz, px: res.avgPx });
      }
      store.recordTrigger(s.id, now);
    }
  }
```
(`withinCaps`, `dayStartUtcMs`, `cloidForKey` are already imported/defined. The cloid is
keyed on a restart-stable slot to avoid crash-replay double-opens, matching `conditional`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd server && npx jest src/engine/scheduler.test.ts && npm run typecheck`
Expected: PASS (scheduled + existing) and `tsc` clean.

- [ ] **Step 6: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts && git commit -m "feat(m4): scheduler scheduled-entry block (time-triggered market open, stable cloid)"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M4 roadmap note**

In `docs/BACKEND-ARCHITECTURE.md`, in the M4 row, replace the `/定时单）` fragment to
annotate the scheduled part as landed. Replace:
```
/定时单）
```
with:
```
/定时单【落地：`kind:"scheduled"`，params `{coin,side,sizeUsdc,runAt}`，`now>=runAt` 市价开仓（经风控 caps、稳定 cloid、一次性完成），mobile 建仓 UI 待做】）
```

(If the exact fragment differs, replace only the literal `/定时单）`.)

- [ ] **Step 2: Full server validation**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; full jest suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m4): mark scheduled-entry strategy landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m4-scheduled-order-server
gh pr create --title "feat(m4): scheduled (time-triggered entry) strategy (server)" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** types + params → Task 1. Pure `scheduledDue` → Task 1. build() case →
Task 1. Validation → Task 2. Sqlite toStrategy + scheduled → Task 3. Scheduler time-gated
opening block (caps + daily cap + stable cloid + one-shot complete) → Task 4. Roadmap →
Task 5. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after. Task 5
Step 4 PR body-file composed at execution time.

**Type consistency:** `ScheduledParams { coin, side, sizeUsdc, runAt }` is used identically
in scheduled.ts, validate.ts, store.ts (build case), sqliteStore.ts (toStrategy), and
scheduler.ts. `scheduledDue(p, now)` matches its scheduler call site. The scheduler
opening path (`withinCaps` + `dayStartUtcMs` + `cloidForKey(s.id, "scheduled")` +
`placer.place({ reduceOnly: false })` + `recordTrigger`) mirrors the DCA/conditional
blocks and uses the restart-stable cloid invariant. No new store method or column.
