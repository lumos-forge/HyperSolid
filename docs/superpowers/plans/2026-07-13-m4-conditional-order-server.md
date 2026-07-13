# M4 Conditional (Price-Triggered Entry) Strategy (server) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `conditional` strategy that opens a position at market when the mark crosses a trigger price, gated by risk caps, completing after one fill.

**Architecture:** New `kind: "conditional"` + `ConditionalParams { coin, side, sizeUsdc, triggerPrice, triggerDirection }`, a pure `conditionalTriggered`, a scheduler block that mirrors the DCA opening path (withinCaps + daily cap) but is price-gated and one-shot. No persisted state / schema change.

**Tech Stack:** TypeScript, better-sqlite3, jest.

Spec: `docs/superpowers/specs/2026-07-13-m4-conditional-order-server-design.md`

---

## Task 1: Types + `conditional.ts` pure logic + build() case

**Files:**
- Modify: `server/src/strategies/types.ts`
- Modify: `server/src/strategies/store.ts`
- Create: `server/src/strategies/conditional.ts`
- Create: `server/src/strategies/conditional.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/strategies/conditional.test.ts`:
```ts
import { conditionalTriggered } from "./conditional";
import type { ConditionalParams } from "./types";

const P = (over: Partial<ConditionalParams> = {}): ConditionalParams => ({
  coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 100, triggerDirection: "above", ...over,
});

describe("conditionalTriggered", () => {
  it("above: fires at/above the trigger price, not below", () => {
    expect(conditionalTriggered(P({ triggerDirection: "above" }), 100)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "above" }), 101)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "above" }), 99)).toBe(false);
  });

  it("below: fires at/below the trigger price, not above", () => {
    expect(conditionalTriggered(P({ triggerDirection: "below" }), 100)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "below" }), 99)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "below" }), 101)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/conditional.test.ts`
Expected: FAIL — `Cannot find module './conditional'` (and `ConditionalParams` not exported).

- [ ] **Step 3: Extend the types**

In `server/src/strategies/types.ts`:

Replace:
```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";
```
with:
```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional";
```

Add the params interface after `TrailingParams`:
```ts
export interface ConditionalParams extends StrategyParamsCommon {
  coin: string;
  side: "buy" | "sell";
  /** Notional (USDC) to open at market when the trigger fires. */
  sizeUsdc: number;
  triggerPrice: number;
  /** "above": fire when mark >= triggerPrice (breakout). "below": fire when mark <= triggerPrice (dip). */
  triggerDirection: "above" | "below";
}
```

Add to the `StrategyParams` union:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams | ConditionalParams;
```

Add the `Strategy` union member (after the `trailing` member):
```ts
  | (StrategyBase & { kind: "conditional"; params: ConditionalParams });
```

- [ ] **Step 4: Add the build() case (keeps the widened union typechecking)**

In `server/src/strategies/store.ts`, extend the `./types` import to include
`ConditionalParams`:
```ts
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, ConditionalParams } from "./types";
```
In the module `build(...)` function, add a `conditional` case before the final `return`
(next to the `trailing` case):
```ts
  if (kind === "conditional") return { ...base, kind, params: params as ConditionalParams };
```

- [ ] **Step 5: Implement the logic**

Create `server/src/strategies/conditional.ts`:
```ts
import type { ConditionalParams } from "./types";

/** True when the mark has crossed the trigger in the configured direction. */
export function conditionalTriggered(p: ConditionalParams, mark: number): boolean {
  return p.triggerDirection === "above" ? mark >= p.triggerPrice : mark <= p.triggerPrice;
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `cd server && npx jest src/strategies/conditional.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/types.ts server/src/strategies/store.ts server/src/strategies/conditional.ts server/src/strategies/conditional.test.ts && git commit -m "feat(m4): conditional-order types + trigger logic + build case"
```

---

## Task 2: Validation

**Files:**
- Modify: `server/src/strategies/validate.ts`
- Modify: `server/src/strategies/validate.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/strategies/validate.test.ts`, add:
```ts
describe("validateParams conditional", () => {
  it("accepts a valid conditional config (above buy)", () => {
    const r = validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" });
    expect(r).toEqual({ ok: true, params: { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" } });
  });

  it("accepts a below sell with deadMan", () => {
    const r = validateParams("conditional", { coin: "ETH", side: "sell", sizeUsdc: 50, triggerPrice: 2000, triggerDirection: "below", deadMan: true });
    expect(r).toEqual({ ok: true, params: { coin: "ETH", side: "sell", sizeUsdc: 50, triggerPrice: 2000, triggerDirection: "below", deadMan: true } });
  });

  it("rejects a bad side / size / price / direction / coin", () => {
    expect(validateParams("conditional", { coin: "BTC", side: "long", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" }).ok).toBe(false);
    expect(validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 0, triggerPrice: 30000, triggerDirection: "above" }).ok).toBe(false);
    expect(validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 0, triggerDirection: "above" }).ok).toBe(false);
    expect(validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "sideways" }).ok).toBe(false);
    expect(validateParams("conditional", { side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/validate.test.ts -t "conditional"`
Expected: FAIL — the `conditional` kind currently returns `unknown strategy kind`.

- [ ] **Step 3: Add the validation branch**

In `server/src/strategies/validate.ts`, add `ConditionalParams` to the type import:
```ts
import type { StrategyKind, StrategyParams, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, ConditionalParams } from "./types";
```
Then add this branch immediately before the final `return { ok: false, error: "unknown strategy kind" };`:
```ts
  if (kind === "conditional") {
    const c = p as unknown as ConditionalParams;
    if (c.side !== "buy" && c.side !== "sell") return { ok: false, error: "conditional side must be buy or sell" };
    if (!positiveNumber(c.sizeUsdc)) return { ok: false, error: "sizeUsdc must be > 0" };
    if (!positiveNumber(c.triggerPrice)) return { ok: false, error: "triggerPrice must be > 0" };
    if (c.triggerDirection !== "above" && c.triggerDirection !== "below") return { ok: false, error: "triggerDirection must be above or below" };
    return { ok: true, params: { coin, side: c.side, sizeUsdc: c.sizeUsdc, triggerPrice: c.triggerPrice, triggerDirection: c.triggerDirection, ...(deadMan ? { deadMan: true } : {}) } };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/strategies/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/validate.ts server/src/strategies/validate.test.ts && git commit -m "feat(m4): validate conditional params (side/size/trigger/direction)"
```

---

## Task 3: Sqlite persistence

**Files:**
- Modify: `server/src/strategies/sqliteStore.ts`
- Modify: `server/src/strategies/sqliteStore.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/strategies/sqliteStore.test.ts`, add:
```ts
  it("round-trips a conditional strategy", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const s = store.create("0xOwner", "conditional", { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" });
    expect(store.get(s.id)).toMatchObject({
      kind: "conditional",
      status: "running",
      params: { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" },
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts -t "conditional"`
Expected: FAIL — `toStrategy` maps the row to `dca` (fallback), so `kind` mismatches.

- [ ] **Step 3: Add the toStrategy branch + scheduled=0**

In `server/src/strategies/sqliteStore.ts`, add a `conditional` branch in `toStrategy`
before the final `dca` return:
```ts
  if (row.kind === "conditional") return { ...base, kind: "conditional", params };
```
And add `"conditional"` to the mark-driven `scheduled` list in `create`:
```ts
    const scheduled = kind === "tpsl" || kind === "grid" || kind === "gridLimit" || kind === "trailing" || kind === "conditional" ? 0 : now;
```

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/sqliteStore.ts server/src/strategies/sqliteStore.test.ts && git commit -m "feat(m4): persist conditional strategy (sqlite toStrategy + scheduled)"
```

---

## Task 4: Scheduler conditional block

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Modify: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/src/engine/scheduler.test.ts`, add (using the existing `placerFake()` helper
and the 7-arg `tick(store, placer, limits, killSwitch, now, activity?, marks?)`):
```ts
describe("conditional entry", () => {
  const cond = (over: any = {}) => ({ coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 100, triggerDirection: "above", ...over });

  it("opens a market position and completes when the mark crosses above", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "conditional", cond());
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("fires a below-direction sell when the mark crosses down", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    const s = store.create("0xo", "conditional", cond({ side: "sell", triggerDirection: "below" }));
    const marks = { resolveMark: async () => 95, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.calls[0]).toMatchObject({ coin: "BTC", side: "sell", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ status: "completed" });
  });

  it("does not fire before the trigger is crossed", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond());
    const marks = { resolveMark: async () => 90, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.calls).toHaveLength(0);
  });

  it("kill-switch blocks the conditional entry", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond());
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1e9 }, true, 0, undefined, marks);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the per-coin notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond({ sizeUsdc: 100 }));
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    await tick(store, placer, { maxNotionalUsdc: 1000, perCoinMaxNotionalUsdc: { BTC: 50 } }, false, 0, undefined, marks);
    expect(placer.calls).toHaveLength(0);
  });

  it("respects the daily notional cap", async () => {
    const store = new MemoryStrategyStore(() => 1000);
    const placer = placerFake();
    store.create("0xo", "conditional", cond({ sizeUsdc: 100 }));
    const marks = { resolveMark: async () => 105, resolvePosition: async () => 0 };
    const activity = { record: () => {}, notionalSince: () => 60 } as any;
    await tick(store, placer, { maxNotionalUsdc: 1e9, dailyMaxNotionalUsdc: 100 }, false, 0, activity, marks);
    expect(placer.calls).toHaveLength(0); // 60 + 100 > 100
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/engine/scheduler.test.ts -t "conditional"`
Expected: FAIL — no conditional handling in the scheduler, so nothing is placed/completed.

- [ ] **Step 3: Add the import**

In `server/src/engine/scheduler.ts`, add the logic import next to the trailing import:
```ts
import { conditionalTriggered } from "../strategies/conditional";
```
and add `ConditionalParams` to the existing types import:
```ts
import type { DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, ConditionalParams } from "../strategies/types";
```

- [ ] **Step 4: Add the conditional block**

In `server/src/engine/scheduler.ts`, immediately after the trailing block (the block
that starts with the comment `// --- Trailing stop:` and ends with its closing `}` +
`}` for the `if (marks)`), insert:
```ts
  // --- Conditional: price-triggered market entry (one-shot) ---
  if (marks) {
    for (const s of all) {
      if (s.kind !== "conditional" || s.status !== "running") continue;
      const p = s.params as ConditionalParams;
      const mark = await marks.resolveMark(p.coin);
      if (!Number.isFinite(mark) || mark <= 0) continue;
      if (!conditionalTriggered(p, mark)) continue;
      const notionalUsdc = p.sizeUsdc;
      if (!withinCaps({ notionalUsdc, killSwitch, coin: p.coin }, limits).ok) continue;
      if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
        const spentToday = activity.notionalSince(s.owner, dayStartUtcMs(now));
        if (spentToday + notionalUsdc > limits.dailyMaxNotionalUsdc) continue;
      }
      const cloid = cloidFor(s.id, now);
      const res = await placer.place({ owner: s.owner, coin: p.coin, sizeUsdc: notionalUsdc, cloid, side: p.side, reduceOnly: false });
      if (res.ok) {
        if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
          activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: p.side, sz: res.filledSz, px: res.avgPx });
        }
        store.recordTrigger(s.id, now);
      }
    }
  }
```
(`withinCaps`, `dayStartUtcMs`, `cloidFor` are already imported/defined.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd server && npx jest src/engine/scheduler.test.ts && npm run typecheck`
Expected: PASS (conditional + existing) and `tsc` clean.

- [ ] **Step 6: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts && git commit -m "feat(m4): scheduler conditional-entry block (price-triggered market open)"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M4 roadmap note**

In `docs/BACKEND-ARCHITECTURE.md`, in the M4 row's strategy list, replace the
`条件/定时单` fragment to annotate the conditional part as landed. Replace:
```
、条件/定时单）
```
with:
```
、条件单【落地：`kind:"conditional"`，params `{coin,side,sizeUsdc,triggerPrice,triggerDirection}`，mark 越过触发价市价开仓（经风控 caps、一次性完成），mobile 建仓 UI 待做】/定时单）
```

(If the exact fragment differs, replace only the literal `条件/定时单` with
`条件单【落地：conditional kind + 价格触发市价开仓，mobile UI 待做】/定时单`.)

- [ ] **Step 2: Full server validation**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; full jest suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m4): mark conditional-entry strategy landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m4-conditional-order-server
gh pr create --title "feat(m4): conditional (price-triggered entry) strategy (server)" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** types + params → Task 1. Pure `conditionalTriggered` → Task 1.
build() case → Task 1. Validation → Task 2. Sqlite toStrategy + scheduled → Task 3.
Scheduler opening-order block (caps + daily cap + one-shot complete) → Task 4. Roadmap
→ Task 5. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after.
(Task 5 Step 4 PR body-file composed at execution time.)

**Type consistency:** `ConditionalParams { coin, side, sizeUsdc, triggerPrice, triggerDirection }`
is used identically in conditional.ts, validate.ts, store.ts (build case), sqliteStore.ts
(toStrategy), and scheduler.ts. `conditionalTriggered(p, mark)` matches its scheduler call
site. The scheduler opening path (`withinCaps` + `dayStartUtcMs` + `placer.place({ reduceOnly: false })`
+ `recordTrigger`) mirrors the existing DCA block, and `recordTrigger` reuses the existing
lifecycle-notification path. No new store method or column.
