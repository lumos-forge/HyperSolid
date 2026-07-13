# M4 Trailing-Stop Strategy (server) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `trailing` strategy that tracks a position's favorable mark extreme and reduce-only-closes it when the mark retraces by `trailPct`%.

**Architecture:** New `kind: "trailing"` + `TrailingParams { coin, trailPct }` + a persisted `trailPeak` water-mark. Pure logic in `trailing.ts` (mirrors `tpsl.ts`), a scheduler block mirroring the tpsl close, plus store/validate/decorator plumbing for the new kind and state field.

**Tech Stack:** TypeScript, better-sqlite3, jest.

Spec: `docs/superpowers/specs/2026-07-13-m4-trailing-stop-server-design.md`

---

## Task 1: Types + `trailing.ts` pure logic

**Files:**
- Modify: `server/src/strategies/types.ts`
- Create: `server/src/strategies/trailing.ts`
- Create: `server/src/strategies/trailing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/strategies/trailing.test.ts`:
```ts
import { updateTrailPeak, trailingTriggered } from "./trailing";
import type { TrailingParams } from "./types";

const P = (trailPct: number): TrailingParams => ({ coin: "BTC", trailPct });

describe("updateTrailPeak", () => {
  it("long: seeds at mark then keeps the running max", () => {
    expect(updateTrailPeak(1, 100, undefined)).toBe(100);
    expect(updateTrailPeak(1, 110, 100)).toBe(110);
    expect(updateTrailPeak(1, 105, 110)).toBe(110); // dip ignored
  });

  it("short: seeds at mark then keeps the running min", () => {
    expect(updateTrailPeak(-1, 100, undefined)).toBe(100);
    expect(updateTrailPeak(-1, 90, 100)).toBe(90);
    expect(updateTrailPeak(-1, 95, 90)).toBe(90); // rise ignored
  });
});

describe("trailingTriggered", () => {
  it("long triggers when mark retraces trailPct% below the peak", () => {
    expect(trailingTriggered(P(5), 1, 95, 100)).toBe(true);  // 95 <= 95
    expect(trailingTriggered(P(5), 1, 96, 100)).toBe(false); // 96 > 95
  });

  it("short triggers when mark retraces trailPct% above the trough", () => {
    expect(trailingTriggered(P(5), -1, 105, 100)).toBe(true);  // 105 >= 105
    expect(trailingTriggered(P(5), -1, 104, 100)).toBe(false); // 104 < 105
  });

  it("flat position never triggers", () => {
    expect(trailingTriggered(P(5), 0, 50, 100)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/trailing.test.ts`
Expected: FAIL — `Cannot find module './trailing'` (and `TrailingParams` not exported).

- [ ] **Step 3: Extend the types**

In `server/src/strategies/types.ts`:

Replace:
```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";
```
with:
```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";
```

Add the params interface after `TpslParams` (before `GridParams`):
```ts
export interface TrailingParams extends StrategyParamsCommon {
  coin: string;
  /** Callback rate: retrace percent from the favorable extreme that triggers the close. 0 < trailPct < 100. */
  trailPct: number;
}
```

Add to the `StrategyParams` union:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams;
```

Add `trailPeak` to `StrategyBase` (after `actionsDone?`):
```ts
  /** Trailing stop: the persisted favorable mark extreme (peak for long, trough for short). */
  trailPeak?: number;
```

Add the `Strategy` union member (after the `gridLimit` member):
```ts
  | (StrategyBase & { kind: "trailing"; params: TrailingParams });
```

- [ ] **Step 4: Implement the logic**

Create `server/src/strategies/trailing.ts`:
```ts
import type { TrailingParams } from "./types";

/** Advance the favorable extreme: for a long (szi>0) the running max mark; for a
 *  short (szi<0) the running min mark. `prev` undefined seeds it at `mark`. */
export function updateTrailPeak(szi: number, mark: number, prev: number | undefined): number {
  if (prev === undefined) return mark;
  return szi > 0 ? Math.max(prev, mark) : Math.min(prev, mark);
}

/** True when the mark has retraced trailPct% from the extreme, closing the position.
 *  Long: mark <= peak*(1 - trailPct/100). Short: mark >= trough*(1 + trailPct/100). */
export function trailingTriggered(p: TrailingParams, szi: number, mark: number, peak: number): boolean {
  const r = p.trailPct / 100;
  if (szi > 0) return mark <= peak * (1 - r);
  if (szi < 0) return mark >= peak * (1 + r);
  return false;
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd server && npx jest src/strategies/trailing.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/types.ts server/src/strategies/trailing.ts server/src/strategies/trailing.test.ts && git commit -m "feat(m4): trailing-stop types + water-mark/trigger logic"
```

---

## Task 2: Validation

**Files:**
- Modify: `server/src/strategies/validate.ts`
- Modify: `server/src/strategies/validate.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/strategies/validate.test.ts`, add a `describe`/tests block (match the
file's existing import of `validateParams`):
```ts
describe("validateParams trailing", () => {
  it("accepts a valid trailing config", () => {
    const r = validateParams("trailing", { coin: "BTC", trailPct: 5 });
    expect(r).toEqual({ ok: true, params: { coin: "BTC", trailPct: 5 } });
  });

  it("carries deadMan through", () => {
    const r = validateParams("trailing", { coin: "BTC", trailPct: 5, deadMan: true });
    expect(r).toEqual({ ok: true, params: { coin: "BTC", trailPct: 5, deadMan: true } });
  });

  it("rejects a non-positive or out-of-range trailPct", () => {
    expect(validateParams("trailing", { coin: "BTC", trailPct: 0 }).ok).toBe(false);
    expect(validateParams("trailing", { coin: "BTC", trailPct: 100 }).ok).toBe(false);
    expect(validateParams("trailing", { coin: "BTC", trailPct: "5" }).ok).toBe(false);
  });

  it("rejects a missing coin", () => {
    expect(validateParams("trailing", { trailPct: 5 }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/validate.test.ts -t "trailing"`
Expected: FAIL — the `trailing` kind currently returns `{ ok: false, error: "unknown strategy kind" }`.

- [ ] **Step 3: Add the validation branch**

In `server/src/strategies/validate.ts`, add `TrailingParams` to the type import:
```ts
import type { StrategyKind, StrategyParams, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams } from "./types";
```
Then add this branch immediately before the final `return { ok: false, error: "unknown strategy kind" };`:
```ts
  if (kind === "trailing") {
    const x = p as unknown as TrailingParams;
    if (!positiveNumber(x.trailPct) || x.trailPct >= 100) return { ok: false, error: "trailPct must be between 0 and 100" };
    return { ok: true, params: { coin, trailPct: x.trailPct, ...(deadMan ? { deadMan: true } : {}) } };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/strategies/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/validate.ts server/src/strategies/validate.test.ts && git commit -m "feat(m4): validate trailing params (0 < trailPct < 100)"
```

---

## Task 3: Store plumbing (`setTrailPeak` + trailing persistence)

**Files:**
- Modify: `server/src/strategies/store.ts`
- Modify: `server/src/strategies/sqliteStore.ts`
- Modify: `server/src/strategies/notifyingStrategyStore.ts`
- Modify: `server/src/strategies/sqliteStore.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/strategies/sqliteStore.test.ts`, add a test (match the file's existing
`SqliteStrategyStore` usage):
```ts
  it("round-trips a trailing strategy and persists trailPeak", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const s = store.create("0xOwner", "trailing", { coin: "BTC", trailPct: 5 });
    expect(store.get(s.id)).toMatchObject({ kind: "trailing", params: { coin: "BTC", trailPct: 5 }, status: "running" });
    expect(store.get(s.id)?.trailPeak).toBeUndefined();
    store.setTrailPeak(s.id, 12345);
    expect(store.get(s.id)?.trailPeak).toBe(12345);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts -t "trailing"`
Expected: FAIL — `setTrailPeak` does not exist / trailing not mapped.

- [ ] **Step 3: Add `setTrailPeak` to the interface + Memory store**

In `server/src/strategies/store.ts`:

Add to the `StrategyStore` interface (after `addFilledUsdc`):
```ts
  /** Trailing stop: persist the favorable mark extreme. */
  setTrailPeak(id: string, peak: number): void;
```

Import the type — extend the existing `./types` import to include `TrailingParams`:
```ts
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams } from "./types";
```

In the module `build(...)` function, add a `trailing` case before the final `return`:
```ts
  if (kind === "trailing") return { ...base, kind, params: params as TrailingParams };
```

In `MemoryStrategyStore`, add the method (near `addFilledUsdc`):
```ts
  setTrailPeak(id: string, peak: number): void {
    const s = this.byId.get(id);
    if (s) s.trailPeak = peak;
  }
```

- [ ] **Step 4: Add trailing persistence to the Sqlite store**

In `server/src/strategies/sqliteStore.ts`:

Extend the `./types` import to include `TrailingParams` (it is unused directly but keeps
parity; if the linter flags it, skip — `toStrategy` casts via `JSON.parse`). Actually no
import change is needed since `params` is `JSON.parse`d; leave imports as-is.

Add `trail_peak` to the `Row` interface:
```ts
  last_level: number | null; actions_done: number; trail_peak: number | null;
```

In `toStrategy`, add a `trailing` branch before the final `dca` return:
```ts
  if (row.kind === "trailing") return { ...base, kind: "trailing", params, trailPeak: row.trail_peak ?? undefined };
```

In `migrate`, add an idempotent column (after the `actions_done` ALTER):
```ts
  if (!cols.has("trail_peak")) db.exec("ALTER TABLE strategies ADD COLUMN trail_peak REAL");
```

In `create`, include `"trailing"` in the mark-driven `scheduled` list:
```ts
    const scheduled = kind === "tpsl" || kind === "grid" || kind === "gridLimit" || kind === "trailing" ? 0 : now;
```

Add the `setTrailPeak` method to the class (near `addFilledUsdc`):
```ts
  setTrailPeak(id: string, peak: number): void {
    this.db.prepare("UPDATE strategies SET trail_peak = ? WHERE id = ?").run(peak, id);
  }
```

- [ ] **Step 5: Add the decorator pass-through**

In `server/src/strategies/notifyingStrategyStore.ts`, add to the pass-throughs section:
```ts
  setTrailPeak(id: string, peak: number): void { this.inner.setTrailPeak(id, peak); }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts src/strategies/notifyingStrategyStore.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/store.ts server/src/strategies/sqliteStore.ts server/src/strategies/notifyingStrategyStore.ts server/src/strategies/sqliteStore.test.ts && git commit -m "feat(m4): persist trailing strategy + trailPeak (memory/sqlite/decorator)"
```

---

## Task 4: Scheduler trailing block

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Modify: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/src/engine/scheduler.test.ts`, add these tests (they use the 7-arg
`tick(store, placer, limits, killSwitch, now, activity?, marks?)` signature;
`MemoryStrategyStore` is already imported). The close/complete cases use a custom
placer returning `filledSz` covering the position (mirroring the existing tpsl
completion test); the no-close cases use a `jest.fn` placer:
```ts
describe("trailing stop", () => {
  it("advances the peak while the mark rises, then closes on retrace and completes", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.5, avgPx: 94 }; } };
    const s = store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const rising = { resolveMark: async () => 100, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, rising);
    expect(placed).toHaveLength(0);            // 100 not <= 95
    expect(store.get(s.id)?.trailPeak).toBe(100);
    const retrace = { resolveMark: async () => 94, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, retrace);
    expect(placed[0]).toMatchObject({ coin: "BTC", side: "sell", reduceOnly: true, sizeCoin: 0.5 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("closes a short when the mark rises past the trough callback", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.5, avgPx: 106 }; } };
    const s = store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const down = { resolveMark: async () => 100, resolvePosition: async () => -0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, down);
    expect(placed).toHaveLength(0);            // 100 not >= 105
    const up = { resolveMark: async () => 106, resolvePosition: async () => -0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, up);
    expect(placed[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: true, sizeCoin: 0.5 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("does not close while the mark keeps rising (long)", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const m1 = { resolveMark: async () => 100, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, m1);
    const m2 = { resolveMark: async () => 120, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, m2);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("skips when there is no position", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const none = { resolveMark: async () => 50, resolvePosition: async () => undefined };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, none);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("kill-switch blocks the trailing close", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    store.create("0xo", "trailing", { coin: "BTC", trailPct: 5 });
    const retrace = { resolveMark: async () => 80, resolvePosition: async () => 0.5 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, true, 0, undefined, retrace);
    expect(placer.place).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/engine/scheduler.test.ts -t "trailing"`
Expected: FAIL — no trailing handling in the scheduler, so no close/complete happens.

- [ ] **Step 3: Add the imports**

In `server/src/engine/scheduler.ts`, add the logic import next to the tpsl import:
```ts
import { updateTrailPeak, trailingTriggered } from "../strategies/trailing";
```
and add `TrailingParams` to the existing types import:
```ts
import type { DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams } from "../strategies/types";
```

- [ ] **Step 4: Add the trailing block**

In `server/src/engine/scheduler.ts`, immediately after the closing `}` of the tpsl
block (the block that starts with the comment `// --- TP/SL: reduce-only close ...`
and ends with `}` + `}` closing its `if (marks)`), insert:
```ts
  // --- Trailing stop: reduce-only close on retrace from the favorable extreme ---
  if (marks) {
    for (const s of all) {
      if (s.kind !== "trailing" || s.status !== "running") continue;
      if (killSwitch) continue;
      const p = s.params as TrailingParams;
      const szi = await marks.resolvePosition(s.owner, p.coin);
      if (szi === undefined || szi === 0) continue;
      const mark = await marks.resolveMark(p.coin);
      if (!Number.isFinite(mark) || mark <= 0) continue;
      const peak = updateTrailPeak(szi, mark, s.trailPeak);
      if (peak !== s.trailPeak) store.setTrailPeak(s.id, peak);
      if (!trailingTriggered(p, szi, mark, peak)) continue;
      const cloid = cloidFor(s.id, now);
      const side = closeSide(szi);
      const res = await placer.place({ owner: s.owner, coin: p.coin, sizeCoin: Math.abs(szi), cloid, side, reduceOnly: true });
      if (res.ok) {
        if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
          activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side, sz: res.filledSz, px: res.avgPx });
        }
        const covered = res.filledSz === undefined || res.filledSz + 1e-9 >= Math.abs(szi);
        if (covered) store.recordTrigger(s.id, now);
      }
    }
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd server && npx jest src/engine/scheduler.test.ts && npm run typecheck`
Expected: PASS (trailing + existing scheduler tests) and `tsc` clean.

- [ ] **Step 6: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts && git commit -m "feat(m4): scheduler trailing-stop block (reduce-only close on retrace)"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M4 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, in the M4 row, replace the strategy list fragment
`移动止损、` (inside `L1 规则（TP/SL、移动止损、DCA、网格、条件/定时单）`) so the
trailing item is annotated as landed. Replace:
```
（TP/SL、移动止损、DCA、网格、条件/定时单）
```
with:
```
（TP/SL、移动止损【落地：`kind:"trailing"`，params `{coin,trailPct}`，持久化 `trailPeak` water-mark，回撤 trailPct% 触发 reduce-only 平仓，mobile 建仓 UI 待做】、DCA、网格、条件/定时单）
```

(If the exact fragment differs, replace only the literal `移动止损、` with
`移动止损【落地：trailing kind + trailPct 回撤触发 reduce-only 平仓，mobile UI 待做】、`.)

- [ ] **Step 2: Full server validation**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; full jest suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m4): mark trailing-stop strategy landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m4-trailing-stop-server
gh pr create --title "feat(m4): trailing-stop strategy (server)" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** types + params + trailPeak → Task 1. Pure logic (updateTrailPeak /
trailingTriggered) → Task 1. Validation → Task 2. Store interface + Memory + Sqlite +
decorator + migration → Task 3. Scheduler block → Task 4. Roadmap → Task 5. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after.
(Task 5 Step 4 PR body-file composed at execution time.)

**Type consistency:** `TrailingParams { coin, trailPct }` and `StrategyBase.trailPeak`
are used identically in trailing.ts, validate.ts, store.ts, sqliteStore.ts, and
scheduler.ts. `setTrailPeak(id, peak)` matches across the `StrategyStore` interface,
both implementations, and the `NotifyingStrategyStore` pass-through. `updateTrailPeak`
/ `trailingTriggered` signatures match their scheduler call sites. `closeSide` and
`cloidFor` are already available in the scheduler (imported/defined). Completion via
`recordTrigger` reuses the existing lifecycle-notification path (Task from P4.5).
