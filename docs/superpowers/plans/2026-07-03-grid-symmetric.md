# Symmetric Long/Short Grid Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `mode: "longOnly" | "symmetric"` to the grid strategy so a grid can trade both long and short around the geometric center, while keeping the existing long-only grid as the default (zero behavior change).

**Architecture:** Extend `GridParams` with `mode` (default `longOnly`). In `symmetric` mode the scheduler's grid loop (a) seeds an initial position toward `targetNetUsdc(centerBand=(levels-1)/2)`, (b) places non-reduce-only orders on both sides (sells may open shorts), (c) drops the flat-sell guard, and (d) gates BOTH sides through the risk caps. Net exposure is naturally bounded by grid geometry, so no new exposure parameter is needed. No new persistence: net position lives on the exchange; the existing `lastLevel`/`actionsDone` state is reused.

**Tech Stack:** TypeScript, Fastify strategy engine (`server/`), Jest; Expo React Native mobile (`mobile/`), Jest + @testing-library/react-native.

---

### Task 1: Server — `GridParams.mode` type + validation

**Files:**
- Modify: `server/src/strategies/types.ts:23-31`
- Modify: `server/src/strategies/validate.ts:43-50`
- Test: `server/src/strategies/validate.test.ts:37-56`

- [ ] **Step 1: Update the existing grid validate test + add mode cases**

In `server/src/strategies/validate.test.ts`, replace the `describe("validateParams grid", ...)` block (lines 37-56) with:

```ts
describe("validateParams grid", () => {
  const ok = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("accepts a valid grid and defaults mode to longOnly", () => {
    const r = validateParams("grid", ok);
    expect(r).toEqual({ ok: true, params: { ...ok, mode: "longOnly" } });
  });
  it("accepts an explicit symmetric mode", () => {
    const r = validateParams("grid", { ...ok, mode: "symmetric" });
    expect(r).toEqual({ ok: true, params: { ...ok, mode: "symmetric" } });
  });
  it("rejects an invalid mode", () => {
    expect(validateParams("grid", { ...ok, mode: "wat" })).toEqual({ ok: false, error: "mode must be longOnly or symmetric" });
  });
  it("rejects upper <= lower", () => {
    expect(validateParams("grid", { ...ok, upperPrice: 100 }).ok).toBe(false);
  });
  it("rejects levels < 2", () => {
    expect(validateParams("grid", { ...ok, levels: 1 }).ok).toBe(false);
  });
  it("rejects a non-integer levels", () => {
    expect(validateParams("grid", { ...ok, levels: 3.5 }).ok).toBe(false);
  });
  it("rejects perLevelUsdc <= 0", () => {
    expect(validateParams("grid", { ...ok, perLevelUsdc: 0 }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx jest validate`
Expected: FAIL — the default/symmetric/invalid-mode cases fail (validate does not yet emit or check `mode`).

- [ ] **Step 3: Add `mode` to `GridParams`**

In `server/src/strategies/types.ts`, replace the `GridParams` interface (lines 23-31) with:

```ts
export interface GridParams {
  coin: string;
  lowerPrice: number;
  upperPrice: number;
  /** Number of grid lines (>= 2); steps = levels - 1. */
  levels: number;
  /** Notional (USDC) bought/sold per crossed grid line. */
  perLevelUsdc: number;
  /** longOnly (default): inventory-bounded long grid. symmetric: two-sided long/short grid. */
  mode?: "longOnly" | "symmetric";
}
```

- [ ] **Step 4: Validate + normalize `mode`**

In `server/src/strategies/validate.ts`, replace the `if (kind === "grid") { ... }` block (lines 43-50) with:

```ts
  if (kind === "grid") {
    const g = p as unknown as GridParams;
    if (!positiveNumber(g.lowerPrice)) return { ok: false, error: "lowerPrice must be > 0" };
    if (!positiveNumber(g.upperPrice) || g.upperPrice <= g.lowerPrice) return { ok: false, error: "upperPrice must be > lowerPrice" };
    if (!positiveInteger(g.levels) || g.levels < 2) return { ok: false, error: "levels must be an integer >= 2" };
    if (!positiveNumber(g.perLevelUsdc)) return { ok: false, error: "perLevelUsdc must be > 0" };
    const mode = g.mode ?? "longOnly";
    if (mode !== "longOnly" && mode !== "symmetric") return { ok: false, error: "mode must be longOnly or symmetric" };
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc, mode } };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx jest validate types`
Expected: PASS (both `validate.test.ts` and `types.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add server/src/strategies/types.ts server/src/strategies/validate.ts server/src/strategies/validate.test.ts
git commit --no-verify -m "feat(grid): add optional mode (longOnly|symmetric) to GridParams + validation

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Server — `targetNetUsdc` helper in `grid.ts`

**Files:**
- Modify: `server/src/strategies/grid.ts` (append new export)
- Test: `server/src/strategies/grid.test.ts` (append new describe block)

- [ ] **Step 1: Write the failing test**

Append to `server/src/strategies/grid.test.ts`:

```ts
describe("targetNetUsdc", () => {
  it("is perLevel*(centerBand-band); max long at the bottom, max short at the top (even levels)", () => {
    // levels=6 -> centerBand=2.5
    expect(targetNetUsdc(0, 6, 50)).toBe(125);
    expect(targetNetUsdc(5, 6, 50)).toBe(-125);
    expect(targetNetUsdc(2, 6, 50)).toBe(25);
    expect(targetNetUsdc(3, 6, 50)).toBe(-25);
  });
  it("is 0 at the exact center for odd levels", () => {
    // levels=5 -> centerBand=2
    expect(targetNetUsdc(2, 5, 50)).toBe(0);
    expect(targetNetUsdc(0, 5, 50)).toBe(100);
    expect(targetNetUsdc(4, 5, 50)).toBe(-100);
  });
});
```

Also update the import line at the top of `grid.test.ts` from:

```ts
import { gridStep, bandIndex, gridAction } from "./grid";
```

to:

```ts
import { gridStep, bandIndex, gridAction, targetNetUsdc } from "./grid";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest grid.test`
Expected: FAIL with "targetNetUsdc is not a function".

- [ ] **Step 3: Implement `targetNetUsdc`**

Append to `server/src/strategies/grid.ts`:

```ts
/**
 * Symmetric-grid target net position (USDC notional) at a given band:
 * centerBand = (levels-1)/2; target = (centerBand - band) * perLevelUsdc.
 * Positive = net long (max at the bottom band), negative = net short (max at the top band).
 */
export function targetNetUsdc(band: number, levels: number, perLevelUsdc: number): number {
  const centerBand = (levels - 1) / 2;
  return (centerBand - band) * perLevelUsdc;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest grid.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/grid.ts server/src/strategies/grid.test.ts
git commit --no-verify -m "feat(grid): add targetNetUsdc helper for symmetric grid centering

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Server — scheduler mode-aware crossing (non-reduce both sides, drop flat guard, gate both sides)

**Files:**
- Modify: `server/src/engine/scheduler.ts:143-195`
- Test: `server/src/engine/scheduler.test.ts` (append to `describe("grid tick", ...)`)

This task changes the CROSSING path only. The seed path stays a no-op for both modes (symmetric seed-to-target is added in Task 4); the new symmetric crossing tests seed directly via `store.seedGridLevel`, so they do not depend on Task 4.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("grid tick", () => { ... })` block in `server/src/engine/scheduler.test.ts` (before its closing `});`):

```ts
  const symParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "symmetric" as const };

  it("symmetric: opens a short on an up-cross while flat (non-reduce)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    store.seedGridLevel(s.id, 1); // mark was at 120
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.5, avgPx: 160 }; } };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 0 }; // band 3, flat
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "sell", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 1 });
  });

  it("symmetric: buys non-reduce on a down-cross while short (covers)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    store.seedGridLevel(s.id, 4); // mark was at 180
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 100, filledSz: 0.5, avgPx: 140 }; } };
    const marks = { resolveMark: async () => 140, resolvePosition: async () => -1 }; // band 2, short
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "buy", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2, actionsDone: 1 });
  });

  it("symmetric: gates the SELL side through the per-order cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    store.seedGridLevel(s.id, 1); // mark was at 120
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 0 }; // up-cross -> sell 100
    await tick(store, placer as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 1 });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest scheduler`
Expected: FAIL — the "opens a short" test currently hits the flat-sell guard (no order), and the sell is not cap-gated.

- [ ] **Step 3: Add `mode` + a shared caps helper, and make the crossing mode-aware**

In `server/src/engine/scheduler.ts`, replace the opening of the grid block (lines 143-149):

```ts
  // --- Grid: mark-crossing, inventory-bounded long grid ---
  if (marks) {
    for (const s of all) {
      if (s.kind !== "grid" || s.status !== "running") continue;
      if (killSwitch) continue;
      const p = s.params as GridParams;
      const mark = await marks.resolveMark(p.coin);
```

with:

```ts
  // --- Grid: mark-crossing grid (longOnly | symmetric) ---
  if (marks) {
    const gridCapsOk = (notionalUsdc: number, owner: string, coin: string): boolean => {
      if (!withinCaps({ notionalUsdc, killSwitch, coin }, limits).ok) return false;
      if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
        const spentToday = activity.notionalSince(owner, dayStartUtcMs(now));
        if (spentToday + notionalUsdc > limits.dailyMaxNotionalUsdc) return false;
      }
      return true;
    };
    for (const s of all) {
      if (s.kind !== "grid" || s.status !== "running") continue;
      if (killSwitch) continue;
      const p = s.params as GridParams;
      const mode = p.mode ?? "longOnly";
      const mark = await marks.resolveMark(p.coin);
```

Then replace the crossing section (lines 159-187, from `const act = gridAction(...)` through the `placer.place({ ... })` call):

```ts
      const act = gridAction(s.lastLevel, curBand, p.perLevelUsdc);
      if (!act || act.usdc <= 0) continue;

      if (act.side === "buy") {
        if (!withinCaps({ notionalUsdc: act.usdc, killSwitch, coin: p.coin }, limits).ok) continue;
        if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
          const spentToday = activity.notionalSince(s.owner, dayStartUtcMs(now));
          if (spentToday + act.usdc > limits.dailyMaxNotionalUsdc) continue;
        }
      }

      if (act.side === "sell") {
        const szi = await marks.resolvePosition(s.owner, p.coin);
        if (szi === undefined || szi <= 0) {
          // Flat: no long inventory to reduce. Track the price up without placing a doomed order.
          store.seedGridLevel(s.id, act.targetLevel);
          continue;
        }
      }

      const cloid = cloidFor(s.id, s.actionsDone ?? 0);
      const res = await placer.place({
        owner: s.owner,
        coin: p.coin,
        sizeUsdc: act.usdc,
        cloid,
        side: act.side,
        reduceOnly: act.side === "sell",
      });
```

with:

```ts
      const act = gridAction(s.lastLevel, curBand, p.perLevelUsdc);
      if (!act || act.usdc <= 0) continue;

      // Both sides open exposure in symmetric mode; longOnly only gates buys.
      if (act.side === "buy" || mode === "symmetric") {
        if (!gridCapsOk(act.usdc, s.owner, p.coin)) continue;
      }

      // longOnly sells are reduce-only and need long inventory; symmetric sells may open shorts.
      if (act.side === "sell" && mode === "longOnly") {
        const szi = await marks.resolvePosition(s.owner, p.coin);
        if (szi === undefined || szi <= 0) {
          // Flat: no long inventory to reduce. Track the price up without placing a doomed order.
          store.seedGridLevel(s.id, act.targetLevel);
          continue;
        }
      }

      const cloid = cloidFor(s.id, s.actionsDone ?? 0);
      const res = await placer.place({
        owner: s.owner,
        coin: p.coin,
        sizeUsdc: act.usdc,
        cloid,
        side: act.side,
        reduceOnly: mode === "longOnly" && act.side === "sell",
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest scheduler`
Expected: PASS — new symmetric crossing tests pass AND all existing longOnly grid tests still pass (longOnly buy uses the identical `gridCapsOk` logic; longOnly sell keeps reduce-only + flat guard).

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(grid): symmetric-mode crossing — two-sided non-reduce orders, both-side caps

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Server — scheduler symmetric seed-to-target

**Files:**
- Modify: `server/src/engine/scheduler.ts` (import line, new constant, seed block ~lines 154-157)
- Test: `server/src/engine/scheduler.test.ts` (append to `describe("grid tick", ...)`)

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("grid tick", () => { ... })` block (before its closing `});`):

```ts
  it("symmetric seed: builds a long toward target below center", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams); // levels 6 -> center 2.5
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 75, filledSz: 0.5, avgPx: 120 }; } };
    const marks = { resolveMark: async () => 120, resolvePosition: async () => 0 }; // band 1 -> target (2.5-1)*50 = 75
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "buy", reduceOnly: false, sizeUsdc: 75 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 1, actionsDone: 1 });
  });

  it("symmetric seed: builds a short toward target above center", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledSz: 0.7, avgPx: 180 }; } };
    const marks = { resolveMark: async () => 180, resolvePosition: async () => 0 }; // band 4 -> target (2.5-4)*50 = -125
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "sell", reduceOnly: false, sizeUsdc: 125 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 1 });
  });

  it("symmetric seed: places no order at the exact center (odd levels)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const oddParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 5, perLevelUsdc: 50, mode: "symmetric" as const };
    const s = store.create("0xo", "grid", oddParams); // center band 2 -> line 150
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 150, resolvePosition: async () => 0 }; // band 2 -> target 0
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2 });
  });

  it("symmetric seed: skips a sub-min-notional target without ordering", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const dustParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 10, mode: "symmetric" as const };
    const s = store.create("0xo", "grid", dustParams); // center 2.5
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 140, resolvePosition: async () => 0 }; // band 2 -> target (2.5-2)*10 = 5 (< MIN)
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2 });
  });

  it("symmetric seed: retries next tick when the seed order is capped (no lastLevel)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", symParams);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 120, resolvePosition: async () => 0 }; // seed target 75 > cap 10
    await tick(store, placer as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id).lastLevel).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest scheduler`
Expected: FAIL — symmetric seed currently just records the band and places no order.

- [ ] **Step 3: Import `targetNetUsdc`, add the min-notional constant, and implement seed-to-target**

In `server/src/engine/scheduler.ts`, update the grid import (line 8) from:

```ts
import { gridStep, bandIndex, gridAction } from "../strategies/grid";
```

to:

```ts
import { gridStep, bandIndex, gridAction, targetNetUsdc } from "../strategies/grid";
```

Add this module-level constant just above `export async function tick(` (line 62):

```ts
/** HL perp min order notional; symmetric seed deltas below this are treated as already on-target. */
const MIN_GRID_NOTIONAL = 10;
```

Then replace the seed block (lines 154-157):

```ts
      if (s.lastLevel === undefined) {
        store.seedGridLevel(s.id, curBand);
        continue;
      }
```

with:

```ts
      if (s.lastLevel === undefined) {
        if (mode === "symmetric") {
          const target = targetNetUsdc(curBand, p.levels, p.perLevelUsdc);
          const szi = (await marks.resolvePosition(s.owner, p.coin)) ?? 0;
          const deltaUsdc = target - szi * mark;
          const sizeUsdc = Math.abs(deltaUsdc);
          if (sizeUsdc < MIN_GRID_NOTIONAL) {
            store.seedGridLevel(s.id, curBand);
            continue;
          }
          const side: "buy" | "sell" = deltaUsdc >= 0 ? "buy" : "sell";
          if (!gridCapsOk(sizeUsdc, s.owner, p.coin)) continue; // retry next tick
          const cloid = cloidFor(s.id, s.actionsDone ?? 0);
          const res = await placer.place({ owner: s.owner, coin: p.coin, sizeUsdc, cloid, side, reduceOnly: false });
          if (res.ok) {
            store.recordGridAction(s.id, curBand, side === "buy" ? res.filledUsdc ?? sizeUsdc : 0);
            if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
              activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side, sz: res.filledSz, px: res.avgPx });
            }
          }
          continue;
        }
        store.seedGridLevel(s.id, curBand);
        continue;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest scheduler`
Expected: PASS — all new symmetric seed tests pass and every existing grid/DCA/TWAP/TPSL test remains green (longOnly seed still a no-op).

- [ ] **Step 5: Full server gate**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: PASS, total test count ≥ 156 (baseline) + the new grid tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(grid): symmetric seed-to-target builds the initial centered position

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Mobile — grid `mode` selector + type + i18n

**Files:**
- Modify: `mobile/src/services/strategyApi.ts:14-16`
- Modify: `mobile/src/screens/AgentScreen.tsx` (grid state, form, `onCreateGrid`)
- Modify: `mobile/src/i18n/messages.ts` (en block ~277-284 and zh block ~724-731)
- Test: `mobile/src/screens/AgentScreen.test.tsx:153-168`

- [ ] **Step 1: Update the grid-create test + add a symmetric-mode test**

In `mobile/src/screens/AgentScreen.test.tsx`, replace the `it("switches to the Grid template and creates a grid", ...)` test (lines 153-168) with:

```ts
  it("switches to the Grid template and creates a longOnly grid by default", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-grid")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-grid"));
    fireEvent.changeText(screen.getByTestId("grid-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("grid-lower"), "100");
    fireEvent.changeText(screen.getByTestId("grid-upper"), "200");
    fireEvent.changeText(screen.getByTestId("grid-levels"), "6");
    fireEvent.changeText(screen.getByTestId("grid-per-level"), "50");
    fireEvent.press(screen.getByTestId("grid-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "longOnly" }),
    );
  });

  it("creates a symmetric grid when the symmetric mode is selected", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-grid")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-grid"));
    fireEvent.changeText(screen.getByTestId("grid-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("grid-lower"), "100");
    fireEvent.changeText(screen.getByTestId("grid-upper"), "200");
    fireEvent.changeText(screen.getByTestId("grid-levels"), "6");
    fireEvent.changeText(screen.getByTestId("grid-per-level"), "50");
    fireEvent.press(screen.getByTestId("grid-mode-symmetric"));
    fireEvent.press(screen.getByTestId("grid-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "symmetric" }),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest AgentScreen`
Expected: FAIL — `grid-mode-symmetric` testID not found; default create call lacks `mode`.

- [ ] **Step 3: Add `mode` to the mobile `GridParams`**

In `mobile/src/services/strategyApi.ts`, replace the `GridParams` interface (lines 14-16):

```ts
export interface GridParams {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
}
```

with:

```ts
export interface GridParams {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
  mode?: "longOnly" | "symmetric";
}
```

- [ ] **Step 4: Add grid mode state**

In `mobile/src/screens/AgentScreen.tsx`, add this line immediately after the `const [gridPerLevel, setGridPerLevel] = useState("");` line (line 161):

```ts
  const [gridMode, setGridMode] = useState<"longOnly" | "symmetric">("longOnly");
```

- [ ] **Step 5: Pass `mode` from `onCreateGrid`**

In `mobile/src/screens/AgentScreen.tsx`, in `onCreateGrid`, replace the `ctrl.createGrid(...)` call (line 207):

```ts
    await ctrl.createGrid({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel });
```

with:

```ts
    await ctrl.createGrid({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel, mode: gridMode });
```

- [ ] **Step 6: Add the mode selector to the grid form**

In `mobile/src/screens/AgentScreen.tsx`, inside the `template === "grid"` card, insert the mode selector immediately after the `grid-per-level` `<Field ... />` line (line 347) and before the `grid-create` `<Pressable>`:

```tsx
          <View style={styles.sideRow}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("agent.gridMode")}</Text>
            <View style={styles.sideBtns}>
              {(["longOnly", "symmetric"] as const).map((m) => (
                <Pressable
                  key={m}
                  testID={`grid-mode-${m}`}
                  accessibilityRole="button"
                  onPress={() => setGridMode(m)}
                  style={[styles.sideBtn, { borderColor: theme.line }, gridMode === m && { backgroundColor: theme.surface }]}
                >
                  <Text style={[styles.segmentText, { color: gridMode === m ? theme.text : theme.muted }]}>
                    {t(m === "longOnly" ? "agent.gridModeLongOnly" : "agent.gridModeSymmetric")}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
```

(This reuses the existing `styles.sideRow` / `styles.sideBtns` / `styles.sideBtn` / `styles.segmentText` styles used by the TWAP side selector — no new styles or hardcoded colors.)

- [ ] **Step 7: Add i18n keys (en + zh)**

In `mobile/src/i18n/messages.ts`, in the English block, add after `"agent.gridPerLevel": "Per level · USDC",` (line 280):

```ts
    "agent.gridMode": "Mode",
    "agent.gridModeLongOnly": "Long only",
    "agent.gridModeSymmetric": "Long/Short",
```

In the Chinese block, add after `"agent.gridPerLevel": "每档 · USDC",` (line 727):

```ts
    "agent.gridMode": "模式",
    "agent.gridModeLongOnly": "仅多头",
    "agent.gridModeSymmetric": "多空双向",
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd mobile && npx jest AgentScreen`
Expected: PASS (both grid create tests).

- [ ] **Step 9: Run the mobile gates**

Run: `cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors && npx jest messages`
Expected: PASS — type-check clean, full suite ≥ baseline, `noHardcodedColors` green (no new hex), `messages` green (en/zh key + value parity).

- [ ] **Step 10: Emoji scan**

Run: `cd mobile && grep -rnP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]" src/screens/AgentScreen.tsx src/i18n/messages.ts || echo "no emoji"`
Expected: `no emoji`.

- [ ] **Step 11: Commit**

```bash
git add mobile/src/services/strategyApi.ts mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx mobile/src/i18n/messages.ts
git commit --no-verify -m "feat(grid): mobile grid mode selector (longOnly/symmetric)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification

- [ ] Server: `cd server && npx tsc --noEmit && npx jest` — all pass, ≥ 156 + new grid tests.
- [ ] Mobile: `cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors && npx jest messages` — all pass, ≥ baseline.
- [ ] Backend (Go): untouched this phase — no run required.
- [ ] Open PR `feat/grid-symmetric` → `main`; wait for CI green (mobile/server/backend jobs); code-review; merge with `gh pr merge <n> --merge`.

## Notes / Out of Scope

- No new persistence column: net position is held on the exchange; `lastLevel`/`actionsDone` are reused.
- Net exposure is bounded by grid geometry (`±` up to `centerBand·perLevelUsdc`); no separate max-exposure parameter.
- `perLevelUsdc` below the exchange min-notional for crossings is a pre-existing concern (longOnly too) and is out of scope; only the new symmetric SEED path guards against dust orders via `MIN_GRID_NOTIONAL`.
- True resting-limit grid (new order-lifecycle/fill-polling subsystem) is explicitly deferred to a future track.
