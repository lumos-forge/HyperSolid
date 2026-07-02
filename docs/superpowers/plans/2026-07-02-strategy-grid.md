# Grid Strategy Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mark-crossing, inventory-bounded long **Grid** as the 4th strategy `kind` in the `server/` automation engine and expose it as an Agent-tab template in the mobile app.

**Architecture:** Reuse the existing tick-driven IoC-order engine. Each tick resolves the mark price; if the mark crossed grid lines since the last tick, place one aggressive IoC order sized to the crossed distance (buy on down-cross, reduce-only sell on up-cross). No resting orders, no fill polling. Crash-safe/oscillation-safe via a monotonic `actionsDone` cloid key.

**Tech Stack:** Server = TypeScript / Fastify / better-sqlite3 / Jest. Mobile = Expo SDK 56 / React Native 0.85 / TypeScript / Jest + @testing-library/react-native v14. Spec: `docs/superpowers/specs/2026-07-02-strategy-grid-design.md`.

---

## Baselines (must stay green)

- **Server:** `cd server && npx tsc --noEmit` → 0 errors; `npx jest` → **120 tests / 20 suites**. Each task grows jest by its new tests.
- **Mobile:** `cd mobile && npx tsc --noEmit` → 0 errors; `npx jest` → **731 tests / 126 suites**; plus `npx jest noHardcodedColors` and `npx jest messages` stay green.

## Conventions (apply to every task)

- **TDD:** write the failing test first, run it and watch it fail, implement minimally, run it and watch it pass, commit.
- **Commit:** `git commit --no-verify -m "<msg>"` with trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Commit locally per task; push only when the user says so.
- **No real network / no real orders** in tests: inject fakes; the engine already isolates the HL client behind `OrderPlacer`/`ExchangeLike`.
- **Mobile colors via theme tokens only** (no hex outside `src/theme/tokens.ts`); no emoji; all user-facing strings via `useT()` with keys in BOTH en + zh.

## File Structure

**Server (`server/src/`)**
- `strategies/types.ts` — add `"grid"` kind, `GridParams`, union member, `StrategyBase.lastLevel?`/`actionsDone?`.
- `strategies/grid.ts` *(new)* — pure `gridStep`, `bandIndex`, `gridAction`.
- `strategies/validate.ts` — grid validation branch.
- `strategies/store.ts` — grid `build` defaults, `seedGridLevel`, `recordGridAction`, interface additions (MemoryStrategyStore).
- `strategies/sqliteStore.ts` — `last_level`/`actions_done` columns + the two new methods.
- `engine/scheduler.ts` — rename `TpslDeps`→`MarkDeps` / `tpsl`→`marks`; add the grid loop.
- `http/app.ts` — expose `lastLevel` on the DTO.

**Mobile (`mobile/src/`)**
- `services/strategyApi.ts` — `"grid"` type, `GridParams`, `Strategy.lastLevel?`.
- `hooks/useStrategyController.ts` — `createGrid`.
- `i18n/messages.ts` — new `agent.*` grid keys (en + zh).
- `screens/AgentScreen.tsx` — grid template segment, form, strategy-row rendering.

---

## Task 1: Backend types — add the `grid` kind

**Files:**
- Modify: `server/src/strategies/types.ts`
- Test: `server/src/strategies/types.test.ts`

- [ ] **Step 1: Write the failing test** — append to `server/src/strategies/types.test.ts`:

```ts
import type { Strategy, GridParams } from "./types";

describe("grid kind", () => {
  it("builds a grid strategy shape with lastLevel + actionsDone", () => {
    const params: GridParams = { coin: "BTC", lowerPrice: 60000, upperPrice: 70000, levels: 6, perLevelUsdc: 50 };
    const s: Strategy = {
      id: "1", owner: "0xo", status: "running", createdAt: 0,
      kind: "grid", params, actionsDone: 0,
    };
    expect(s.kind).toBe("grid");
    expect(s.params.perLevelUsdc).toBe(50);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest src/strategies/types.test.ts -t "grid kind"`
Expected: FAIL (TS: `GridParams` not exported / `kind: "grid"` not assignable).

- [ ] **Step 3: Implement** — edit `server/src/strategies/types.ts`:

Change the kind union:
```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid";
```

Add the params interface after `TpslParams`:
```ts
export interface GridParams {
  coin: string;
  lowerPrice: number;
  upperPrice: number;
  /** Number of grid lines (>= 2); steps = levels - 1. */
  levels: number;
  /** Notional (USDC) bought/sold per crossed grid line. */
  perLevelUsdc: number;
}
```

Add `GridParams` to the params union:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams;
```

Add the two optional state fields to `StrategyBase` (after `triggeredAt?: number;`):
```ts
  /** Grid: the grid-line index the mark last occupied. */
  lastLevel?: number;
  /** Grid: monotonic count of executed grid actions (drives the cloid). */
  actionsDone?: number;
```

Add the union member (after the `tpsl` member):
```ts
  | (StrategyBase & { kind: "grid"; params: GridParams });
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest src/strategies/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/types.ts server/src/strategies/types.test.ts
git commit --no-verify -m "feat(strategies): grid StrategyKind + GridParams types

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Backend pure grid logic (`grid.ts`)

**Files:**
- Create: `server/src/strategies/grid.ts`
- Test: `server/src/strategies/grid.test.ts`

- [ ] **Step 1: Write the failing test** — create `server/src/strategies/grid.test.ts`:

```ts
import { gridStep, bandIndex, gridAction } from "./grid";
import type { GridParams } from "./types";

const P: GridParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
// levels=6 -> step=20, lines: 100,120,140,160,180,200 (indices 0..5)

describe("gridStep", () => {
  it("is (upper-lower)/(levels-1)", () => {
    expect(gridStep(P)).toBe(20);
  });
  it("is 0 for a single level", () => {
    expect(gridStep({ ...P, levels: 1 })).toBe(0);
  });
});

describe("bandIndex", () => {
  const step = gridStep(P);
  it("maps a mark to the nearest grid line", () => {
    expect(bandIndex(139, P.lowerPrice, step, P.levels)).toBe(2); // 140
    expect(bandIndex(151, P.lowerPrice, step, P.levels)).toBe(3); // 160 (nearest)
  });
  it("clamps below the range to 0 and above to levels-1", () => {
    expect(bandIndex(50, P.lowerPrice, step, P.levels)).toBe(0);
    expect(bandIndex(999, P.lowerPrice, step, P.levels)).toBe(5);
  });
});

describe("gridAction", () => {
  it("buys the crossed distance on a down-cross", () => {
    expect(gridAction(4, 2, P.perLevelUsdc)).toEqual({ side: "buy", usdc: 100, targetLevel: 2 });
  });
  it("sells the crossed distance on an up-cross", () => {
    expect(gridAction(1, 3, P.perLevelUsdc)).toEqual({ side: "sell", usdc: 100, targetLevel: 3 });
  });
  it("returns null when the band is unchanged", () => {
    expect(gridAction(3, 3, P.perLevelUsdc)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest src/strategies/grid.test.ts`
Expected: FAIL (`Cannot find module './grid'`).

- [ ] **Step 3: Implement** — create `server/src/strategies/grid.ts`:

```ts
import type { GridParams } from "./types";

/** Grid-line spacing = (upper - lower) / (levels - 1); 0 for a degenerate single-level grid. */
export function gridStep(p: GridParams): number {
  return p.levels > 1 ? (p.upperPrice - p.lowerPrice) / (p.levels - 1) : 0;
}

/** Nearest grid-line index for `mark`, clamped to [0, levels-1]. Out-of-range marks clamp to an end. */
export function bandIndex(mark: number, lowerPrice: number, step: number, levels: number): number {
  if (!(step > 0)) return 0;
  const raw = Math.round((mark - lowerPrice) / step);
  return Math.max(0, Math.min(levels - 1, raw));
}

export interface GridAction {
  side: "buy" | "sell";
  usdc: number;
  targetLevel: number;
}

/**
 * The action implied by the mark moving from `lastLevel` to `curBand`:
 * down-cross -> buy the crossed distance; up-cross -> sell it (reduce-only at the call site);
 * unchanged -> null.
 */
export function gridAction(lastLevel: number, curBand: number, perLevelUsdc: number): GridAction | null {
  if (curBand < lastLevel) return { side: "buy", usdc: (lastLevel - curBand) * perLevelUsdc, targetLevel: curBand };
  if (curBand > lastLevel) return { side: "sell", usdc: (curBand - lastLevel) * perLevelUsdc, targetLevel: curBand };
  return null;
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest src/strategies/grid.test.ts`
Expected: PASS (7 assertions across 3 describes).

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/grid.ts server/src/strategies/grid.test.ts
git commit --no-verify -m "feat(strategies): pure grid logic (gridStep/bandIndex/gridAction)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Backend grid validation

**Files:**
- Modify: `server/src/strategies/validate.ts`
- Test: `server/src/strategies/validate.test.ts`

- [ ] **Step 1: Write the failing test** — append to `server/src/strategies/validate.test.ts`:

```ts
describe("validateParams grid", () => {
  const ok = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("accepts a valid grid", () => {
    const r = validateParams("grid", ok);
    expect(r).toEqual({ ok: true, params: ok });
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

(`validateParams` is already imported at the top of the file.)

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest src/strategies/validate.test.ts -t "grid"`
Expected: FAIL (grid falls through to "unknown strategy kind").

- [ ] **Step 3: Implement** — edit `server/src/strategies/validate.ts`:

Update the import to include `GridParams`:
```ts
import type { StrategyKind, StrategyParams, DcaParams, TwapParams, TpslParams, GridParams } from "./types";
```

Insert this branch immediately before the final `return { ok: false, error: "unknown strategy kind" };`:
```ts
  if (kind === "grid") {
    const g = p as unknown as GridParams;
    if (!positiveNumber(g.lowerPrice)) return { ok: false, error: "lowerPrice must be > 0" };
    if (!positiveNumber(g.upperPrice) || g.upperPrice <= g.lowerPrice) return { ok: false, error: "upperPrice must be > lowerPrice" };
    if (!positiveInteger(g.levels) || g.levels < 2) return { ok: false, error: "levels must be an integer >= 2" };
    if (!positiveNumber(g.perLevelUsdc)) return { ok: false, error: "perLevelUsdc must be > 0" };
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc } };
  }
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest src/strategies/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/validate.ts server/src/strategies/validate.test.ts
git commit --no-verify -m "feat(strategies): validate grid params

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Memory store — grid build + `seedGridLevel` + `recordGridAction`

**Files:**
- Modify: `server/src/strategies/store.ts`
- Test: `server/src/strategies/store.test.ts`

- [ ] **Step 1: Write the failing test** — append to `server/src/strategies/store.test.ts`:

```ts
describe("grid store state", () => {
  const params = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("creates a grid with actionsDone=0 and no lastLevel", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    expect(s).toMatchObject({ kind: "grid", status: "running", actionsDone: 0, filledTotalUsdc: 0 });
    expect(s.lastLevel).toBeUndefined();
  });

  it("seedGridLevel sets lastLevel without bumping actionsDone", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 3);
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 0 });
  });

  it("recordGridAction advances lastLevel/actionsDone and adds bought notional", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.recordGridAction(s.id, 2, 100); // a buy
    store.recordGridAction(s.id, 4, 0);   // a reduce-only sell adds no bought notional
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 2, filledTotalUsdc: 100 });
  });
});
```

(`MemoryStrategyStore` is already imported in this test file.)

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest src/strategies/store.test.ts -t "grid store state"`
Expected: FAIL (`seedGridLevel`/`recordGridAction` not a function; grid create returns no `actionsDone`).

- [ ] **Step 3: Implement** — edit `server/src/strategies/store.ts`:

Add `GridParams` to the type import:
```ts
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, DcaParams, TwapParams, TpslParams, GridParams } from "./types";
```

Add the two methods to the `StrategyStore` interface (after `recordTrigger`):
```ts
  /** Grid: set the baseline grid-line index on the first tick (no order, no counter bump). */
  seedGridLevel(id: string, level: number): void;
  /** Grid: advance to `newLevel`, bump the action counter, add `boughtUsdc` (0 for reduce-only sells). */
  recordGridAction(id: string, newLevel: number, boughtUsdc: number): void;
```

In `build(...)`, add a grid branch before the final `return` (the tpsl fallthrough):
```ts
  if (kind === "grid") return { ...base, kind, params: params as GridParams, filledTotalUsdc: 0, actionsDone: 0 };
```

Add the two methods to `MemoryStrategyStore` (after `recordTrigger`):
```ts
  seedGridLevel(id: string, level: number): void {
    const s = this.byId.get(id);
    if (s) s.lastLevel = level;
  }

  recordGridAction(id: string, newLevel: number, boughtUsdc: number): void {
    const s = this.byId.get(id);
    if (!s) return;
    s.lastLevel = newLevel;
    s.actionsDone = (s.actionsDone ?? 0) + 1;
    s.filledTotalUsdc = (s.filledTotalUsdc ?? 0) + boughtUsdc;
  }
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest src/strategies/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/store.ts server/src/strategies/store.test.ts
git commit --no-verify -m "feat(strategies): memory store grid build + seed/record grid action

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: SQLite store — grid columns + methods

**Files:**
- Modify: `server/src/strategies/sqliteStore.ts`
- Test: `server/src/strategies/sqliteStore.test.ts`

- [ ] **Step 1: Write the failing test** — append to `server/src/strategies/sqliteStore.test.ts`:

```ts
describe("sqlite grid state", () => {
  const params = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("round-trips a grid with seed + record", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 0);
    const s = store.create("0xO", "grid", params);
    expect(store.get(s.id)).toMatchObject({ kind: "grid", actionsDone: 0, filledTotalUsdc: 0 });
    expect(store.get(s.id)!.lastLevel).toBeUndefined();

    store.seedGridLevel(s.id, 3);
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 0 });

    store.recordGridAction(s.id, 2, 100);
    store.recordGridAction(s.id, 4, 0);
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 2, filledTotalUsdc: 100 });
    store.close();
  });
});
```

(This test file already imports `SqliteStrategyStore` and instantiates via `SqliteStrategyStore.open(":memory:", () => …)` + `store.close()`, matching the existing tests — reuse that pattern; no new imports.)

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts -t "grid state"`
Expected: FAIL (no `last_level`/`actions_done` columns; methods missing).

- [ ] **Step 3: Implement** — edit `server/src/strategies/sqliteStore.ts`:

Add `GridParams` to the type import:
```ts
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, TwapParams, GridParams } from "./types";
```

Extend the `Row` interface (add two fields):
```ts
  last_level: number | null; actions_done: number;
```

In `toStrategy`, add a grid branch before the final `dca` return:
```ts
  if (row.kind === "grid") return { ...base, kind: "grid", params, filledTotalUsdc: row.filled_total_usdc, actionsDone: row.actions_done, lastLevel: row.last_level ?? undefined };
```

In `migrate`, add two column migrations after the `triggered_at`/`created_at` block:
```ts
  if (!cols.has("last_level")) db.exec("ALTER TABLE strategies ADD COLUMN last_level INTEGER");
  if (!cols.has("actions_done")) db.exec("ALTER TABLE strategies ADD COLUMN actions_done INTEGER NOT NULL DEFAULT 0");
```

In `create(...)`, grid is tick-driven (no `next_run_at`); include it in the "scheduled = 0" set and pass the two new columns:
```ts
    const scheduled = kind === "tpsl" || kind === "grid" ? 0 : now;
    this.db
      .prepare(
        "INSERT INTO strategies (id, owner, status, params, kind, next_run_at, filled_total_usdc, slices_done, triggered_at, created_at, last_level, actions_done) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, owner.toLowerCase(), "running", JSON.stringify(params), kind, scheduled, 0, 0, null, now, null, 0);
```

Add the two methods (after `recordTrigger`):
```ts
  seedGridLevel(id: string, level: number): void {
    this.db.prepare("UPDATE strategies SET last_level = ? WHERE id = ?").run(level, id);
  }

  recordGridAction(id: string, newLevel: number, boughtUsdc: number): void {
    this.db
      .prepare("UPDATE strategies SET last_level = ?, actions_done = actions_done + 1, filled_total_usdc = filled_total_usdc + ? WHERE id = ?")
      .run(newLevel, boughtUsdc, id);
  }
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest src/strategies/sqliteStore.test.ts`
Expected: PASS (grid round-trip + all existing sqlite tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/sqliteStore.ts server/src/strategies/sqliteStore.test.ts
git commit --no-verify -m "feat(strategies): sqlite grid columns + seed/record grid action

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Scheduler — generalize mark deps + grid loop

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: Write the failing test** — append to `server/src/engine/scheduler.test.ts`:

```ts
describe("grid tick", () => {
  const params = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
  // step=20; lines 100,120,140,160,180,200 (idx 0..5)

  it("seeds lastLevel on the first tick without placing an order", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 0 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3 });
  });

  it("buys the crossed distance on a down-cross (non-reduce)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 4); // mark was at 180
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 100, filledSz: 0.5, avgPx: 200 }; } };
    const marks = { resolveMark: async () => 140, resolvePosition: async () => 0 }; // band 2
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ coin: "BTC", side: "buy", reduceOnly: false, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 2, actionsDone: 1, filledTotalUsdc: 100 });
  });

  it("sells reduce-only on an up-cross and does not add bought notional", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 1); // mark was at 120
    const placed: any[] = [];
    const placer = { place: async (r: any) => { placed.push(r); return { ok: true, filledUsdc: 100, filledSz: 0.5, avgPx: 160 }; } };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 1 }; // band 3
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placed[0]).toMatchObject({ side: "sell", reduceOnly: true, sizeUsdc: 100 });
    expect(store.get(s.id)).toMatchObject({ lastLevel: 3, actionsDone: 1, filledTotalUsdc: 0 });
  });

  it("does nothing when the band is unchanged", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 3);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 160, resolvePosition: async () => 0 }; // band 3
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
  });

  it("halts entirely under the kill-switch", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 4);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 100, resolvePosition: async () => 0 };
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, true, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4 });
  });

  it("blocks a grid buy over the per-order cap but leaves state for retry", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 4);
    const placer = { place: jest.fn(async () => ({ ok: true })) };
    const marks = { resolveMark: async () => 140, resolvePosition: async () => 0 }; // buy 100 usdc
    await tick(store, placer as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks);
    expect(placer.place).not.toHaveBeenCalled();
    expect(store.get(s.id)).toMatchObject({ lastLevel: 4, actionsDone: 0 });
  });

  it("uses a monotonic actionsDone cloid so revisiting a level re-places", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "grid", params);
    store.seedGridLevel(s.id, 3);
    const seen: string[] = [];
    const placer = { place: async (r: any) => { seen.push(r.cloid); return { ok: true, filledUsdc: 50, filledSz: 0.3, avgPx: 150 }; } };
    // down to band 2 (buy), then back up to band 3 (sell): two distinct cloids
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 140, resolvePosition: async () => 0 });
    await tick(store, placer as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 160, resolvePosition: async () => 1 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest src/engine/scheduler.test.ts -t "grid tick"`
Expected: FAIL (no grid loop; grids are ignored).

- [ ] **Step 3: Implement** — edit `server/src/engine/scheduler.ts`:

3a. Add grid imports (next to the other strategy imports):
```ts
import { gridStep, bandIndex, gridAction } from "../strategies/grid";
import type { DcaParams, TwapParams, TpslParams, GridParams } from "../strategies/types";
```
(Extend the existing `types` import line to include `GridParams` rather than adding a duplicate import.)

3b. Rename the deps type + tick param. Replace:
```ts
/** Optional resolvers enabling the TP/SL trigger path (Phase 2). */
export interface TpslDeps {
  resolveMark(coin: string): Promise<number>;
  /** Signed position size (szi): >0 long, <0 short, undefined/0 = flat. */
  resolvePosition(owner: string, coin: string): Promise<number | undefined>;
}
```
with:
```ts
/** Mark/position resolvers shared by the TP/SL trigger path and the Grid path. */
export interface MarkDeps {
  resolveMark(coin: string): Promise<number>;
  /** Signed position size (szi): >0 long, <0 short, undefined/0 = flat. */
  resolvePosition(owner: string, coin: string): Promise<number | undefined>;
}
```

In the `tick(...)` signature, rename the last param:
```ts
  marks?: MarkDeps,
```

In the existing TP/SL block, rename `tpsl` → `marks` (three references): `if (marks) {`, `await marks.resolvePosition(...)`, `await marks.resolveMark(...)`.

3c. Add the grid loop at the end of `tick`, after the TP/SL block, before the closing brace of `tick`:
```ts
  // --- Grid: mark-crossing, inventory-bounded long grid ---
  if (marks) {
    for (const s of all) {
      if (s.kind !== "grid" || s.status !== "running") continue;
      if (killSwitch) continue;
      const p = s.params as GridParams;
      const mark = await marks.resolveMark(p.coin);
      if (!Number.isFinite(mark) || mark <= 0) continue;
      const step = gridStep(p);
      const curBand = bandIndex(mark, p.lowerPrice, step, p.levels);

      if (s.lastLevel === undefined) {
        store.seedGridLevel(s.id, curBand);
        continue;
      }

      const act = gridAction(s.lastLevel, curBand, p.perLevelUsdc);
      if (!act || act.usdc <= 0) continue;

      if (act.side === "buy") {
        if (!withinCaps({ notionalUsdc: act.usdc, killSwitch, coin: p.coin }, limits).ok) continue;
        if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
          const spentToday = activity.notionalSince(s.owner, dayStartUtcMs(now));
          if (spentToday + act.usdc > limits.dailyMaxNotionalUsdc) continue;
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
      if (res.ok) {
        const bought = act.side === "buy" ? res.filledUsdc ?? act.usdc : 0;
        store.recordGridAction(s.id, act.targetLevel, bought);
        if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
          activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: act.side, sz: res.filledSz, px: res.avgPx });
        }
      }
    }
  }
```

- [ ] **Step 4: Run the whole scheduler suite, expect pass**

Run: `cd server && npx jest src/engine/scheduler.test.ts`
Expected: PASS (existing DCA/TWAP/TP-SL tests still green — they pass the deps object positionally, unaffected by the rename — plus the 7 new grid tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(engine): grid tick (mark-crossing buys/reduce-only sells) + shared MarkDeps

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: HTTP — expose `lastLevel` on the DTO + grid create test

**Files:**
- Modify: `server/src/http/app.ts`
- Test: `server/src/http/app.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the existing `describe("HTTP app", …)` in `server/src/http/app.test.ts`. Reuse the file's existing `build()` (returns the app over a `MemoryStrategyStore`) and `tokenFor(app)` helpers, exactly like the DCA create test:

```ts
it("creates a grid strategy and returns it", async () => {
  const app = build();
  const token = await tokenFor(app);
  const auth = { authorization: `Bearer ${token}` };
  const res = await app.inject({
    method: "POST",
    url: "/strategies",
    headers: auth,
    payload: { type: "grid", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ type: "grid", status: "running", params: { levels: 6 } });
});

it("rejects an invalid grid (upper <= lower) with 400", async () => {
  const app = build();
  const token = await tokenFor(app);
  const auth = { authorization: `Bearer ${token}` };
  const res = await app.inject({
    method: "POST",
    url: "/strategies",
    headers: auth,
    payload: { type: "grid", params: { coin: "BTC", lowerPrice: 200, upperPrice: 100, levels: 6, perLevelUsdc: 50 } },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx jest src/http/app.test.ts -t "grid"`
Expected: the create test PASSES already (the POST handler is kind-generic and `validateParams` now handles grid from Task 3); the invalid-grid test returns 400. Both lock the contract. The DTO `lastLevel` field is added next so the mobile row can show the current level.

- [ ] **Step 3: Implement the DTO field** — edit `server/src/http/app.ts`:

Add to the `StrategyDto` interface (after `triggeredAt?: number;`):
```ts
  lastLevel?: number;
```

Add to the `toDto` return object (after the `triggeredAt` spread):
```ts
    ...(s.lastLevel !== undefined ? { lastLevel: s.lastLevel } : {}),
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest src/http/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Full server gate + commit**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: tsc 0 errors; all suites green (≥ 120 + new grid tests).

```bash
git add server/src/http/app.ts server/src/http/app.test.ts
git commit --no-verify -m "feat(http): expose grid lastLevel on the strategy DTO + grid create tests

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Mobile `strategyApi` — grid type + params

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Test: `mobile/src/services/strategyApi.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the existing `describe` in `mobile/src/services/strategyApi.test.ts` (reuse its `res` helper):

```ts
it("creates a grid strategy", async () => {
  const fetchMock = jest.fn(async (_u: string, _i?: RequestInit) => res({ id: "s4", type: "grid", params: {}, status: "running" }));
  const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
  await api.createStrategy("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
  const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({ type: "grid", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 } });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts -t "grid"`
Expected: FAIL (TS: `"grid"` not assignable to `StrategyType`).

- [ ] **Step 3: Implement** — edit `mobile/src/services/strategyApi.ts`:

Change the type union:
```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid";
```

Add the params interface after `TpslParams`:
```ts
export interface GridParams {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
}
```

Add it to the params union:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams;
```

Add `lastLevel` to the `Strategy` interface (after `triggeredAt?: number;`):
```ts
  lastLevel?: number;
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts
git commit --no-verify -m "feat(mobile): grid StrategyType + GridParams in strategyApi

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: Mobile controller — `createGrid`

**Files:**
- Modify: `mobile/src/hooks/useStrategyController.ts`
- Test: `mobile/src/hooks/useStrategyController.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the existing `describe` in `mobile/src/hooks/useStrategyController.test.ts` (reuse its `makeApi`, `approveAgent`, `renderHook`, `act`):

```ts
it("createGrid creates a grid then refreshes", async () => {
  const api = makeApi();
  const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "n"));
  await act(async () => {
    await result.current.createGrid({ coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
  });
  expect(api.createStrategy).toHaveBeenCalledWith("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/hooks/useStrategyController.test.ts -t "createGrid"`
Expected: FAIL (`createGrid` is not a function).

- [ ] **Step 3: Implement** — edit `mobile/src/hooks/useStrategyController.ts`:

Add `GridParams` to the type import:
```ts
import type { StrategyApi, Strategy, DcaParams, TwapParams, TpslParams, GridParams, AgentStatus, Activity } from "../services/strategyApi";
```

Add the callback (after `createTpsl`):
```ts
  const createGrid = useCallback(async (params: GridParams) => {
    await api.createStrategy("grid", params);
    await refresh();
  }, [api, refresh]);
```

Add `createGrid` to the returned object:
```ts
  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, createGrid, toggle, killAll, refresh };
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/hooks/useStrategyController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/hooks/useStrategyController.ts mobile/src/hooks/useStrategyController.test.ts
git commit --no-verify -m "feat(mobile): createGrid in the strategy controller

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: Mobile i18n — grid keys (en + zh)

**Files:**
- Modify: `mobile/src/i18n/messages.ts`
- Test: `mobile/src/i18n/messages.test.ts` (parity is auto-checked; no new test needed)

- [ ] **Step 1: Run the parity guard first to confirm it is green**

Run: `cd mobile && npx jest messages`
Expected: PASS (baseline). This test fails if en/zh keys diverge — it is our gate for this task.

- [ ] **Step 2: Add the English keys** — in `mobile/src/i18n/messages.ts`, inside the **en** map, next to the other `agent.*` template keys (after `"agent.templateTpsl"`), add:

```ts
    "agent.templateGrid": "Grid",
    "agent.newGrid": "New Grid",
    "agent.gridLower": "Lower price",
    "agent.gridUpper": "Upper price",
    "agent.gridLevels": "Levels",
    "agent.gridPerLevel": "Per level · USDC",
    "agent.createGrid": "Create Grid",
    "agent.invalidGrid": "Enter lower < upper, levels ≥ 2, and a positive per-level amount",
    "agent.strategyGrid": "{coin} Grid",
    "agent.gridProgress": "level {level}/{levels} · ${filled} bought",
```

- [ ] **Step 3: Add the matching Chinese keys** — in the **zh** map, next to the zh `agent.*` template keys (after `"agent.templateTpsl"`), add:

```ts
    "agent.templateGrid": "网格",
    "agent.newGrid": "新建网格",
    "agent.gridLower": "下限价",
    "agent.gridUpper": "上限价",
    "agent.gridLevels": "档数",
    "agent.gridPerLevel": "每档 · USDC",
    "agent.createGrid": "创建网格",
    "agent.invalidGrid": "请填写 下限<上限、档数≥2、每档为正数",
    "agent.strategyGrid": "{coin} 网格",
    "agent.gridProgress": "档位 {level}/{levels} · 已买入 ${filled}",
```

- [ ] **Step 4: Run the parity guard, expect pass**

Run: `cd mobile && npx jest messages`
Expected: PASS (en and zh now have identical key sets including the 10 new keys).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/i18n/messages.ts
git commit --no-verify -m "feat(i18n): grid template strings (en + zh)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 11: Mobile Agent screen — grid template, form, strategy row

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx`
- Test: `mobile/src/screens/AgentScreen.test.tsx`

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe("AgentScreen", …)` in `mobile/src/screens/AgentScreen.test.tsx`:

```ts
it("switches to the Grid template and creates a grid", async () => {
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
    expect(mockApiFake.createStrategy).toHaveBeenCalledWith("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }),
  );
});

it("renders a grid strategy row", async () => {
  mockApiFake.listStrategies.mockResolvedValue([
    { id: "g1", type: "grid", status: "running", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }, lastLevel: 2, filledTotalUsdc: 100 },
  ]);
  render(<AgentScreen />);
  fireEvent.press(screen.getByTestId("strategy-connect-btn"));
  await waitFor(() => expect(screen.getByTestId("strategy-g1")).toBeTruthy());
});
```

- [ ] **Step 2: Run them, expect fail**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "Grid"`
Expected: FAIL (`template-grid` / grid fields not found).

- [ ] **Step 3: Implement** — edit `mobile/src/screens/AgentScreen.tsx`:

3a. Widen the `Template` type (line ~25):
```ts
type Template = "dca" | "twap" | "tpsl" | "grid";
```

3b. Import `GridParams` in the existing strategyApi import (line ~14):
```ts
import { StrategyApi, type Strategy, type DcaParams, type TwapParams, type TpslParams, type GridParams, type Activity } from "../services/strategyApi";
```

3c. Add grid form state (next to the tpsl state, after `const [sl, setSl] = useState("");`):
```ts
  const [gridLower, setGridLower] = useState("");
  const [gridUpper, setGridUpper] = useState("");
  const [gridLevels, setGridLevels] = useState("6");
  const [gridPerLevel, setGridPerLevel] = useState("");
```

3d. Add the create handler (after `onCreateTpsl`):
```ts
  async function onCreateGrid() {
    const lower = Number(gridLower), upper = Number(gridUpper), levels = Number(gridLevels), perLevel = Number(gridPerLevel);
    if (!(lower > 0) || !(upper > lower) || !Number.isInteger(levels) || levels < 2 || !(perLevel > 0)) {
      Alert.alert(t("agent.invalidParams"), t("agent.invalidGrid"));
      return;
    }
    await ctrl.createGrid({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel });
    setGridLower(""); setGridUpper(""); setGridPerLevel("");
  }
```

3e. Add `"grid"` to the template picker array + its label (line ~254). Replace the picker's `.map` array and label expression:
```ts
        {(["dca", "twap", "tpsl", "grid"] as Template[]).map((k) => (
```
and replace the inner label `Text` content expression with:
```ts
              {t(
                k === "dca" ? "agent.templateDca"
                : k === "twap" ? "agent.templateTwap"
                : k === "tpsl" ? "agent.templateTpsl"
                : "agent.templateGrid",
              )}
```

3f. Add the grid form card after the tpsl card block (after the `template === "tpsl" && (…)` block, before the kill-switch `Pressable`):
```tsx
      {template === "grid" ? (
        <SurfaceCard theme={theme} rule={false} testID="new-grid" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newGrid")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="grid-coin" />
          <Field theme={theme} label={t("agent.gridLower")} value={gridLower} onChangeText={setGridLower} keyboard testID="grid-lower" />
          <Field theme={theme} label={t("agent.gridUpper")} value={gridUpper} onChangeText={setGridUpper} keyboard testID="grid-upper" />
          <Field theme={theme} label={t("agent.gridLevels")} value={gridLevels} onChangeText={setGridLevels} keyboard testID="grid-levels" />
          <Field theme={theme} label={t("agent.gridPerLevel")} value={gridPerLevel} onChangeText={setGridPerLevel} keyboard testID="grid-per-level" />
          <Pressable onPress={onCreateGrid} accessibilityRole="button" testID="grid-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createGrid")}</Text>
          </Pressable>
        </SurfaceCard>
      ) : null}
```

3g. Handle the grid row in `StrategyRow` (the `title` and `sub` computations, ~line 348). Extend the `title` chain to include grid:
```ts
  const title =
    strategy.type === "twap" ? t("agent.strategyTwap", { coin: strategy.params.coin })
    : strategy.type === "tpsl" ? t("agent.strategyTpsl", { coin: strategy.params.coin })
    : strategy.type === "grid" ? t("agent.strategyGrid", { coin: (strategy.params as GridParams).coin })
    : t("agent.strategyDca", { coin: (strategy.params as DcaParams).coin });
```
Extend the `sub` chain to include grid (add this branch before the final DCA fallback string):
```ts
      : strategy.type === "grid"
      ? t("agent.gridProgress", {
          level: String((strategy.lastLevel ?? 0) + 1),
          levels: String((strategy.params as GridParams).levels),
          filled: String(Math.round(strategy.filledTotalUsdc ?? 0)),
        })
```
i.e. the final `sub` reads: `twap ? … : tpsl ? … : grid ? … : \`$${dca…}\``.

- [ ] **Step 4: Run the Agent screen suite, expect pass**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx`
Expected: PASS (existing + 2 new grid tests).

- [ ] **Step 5: Full mobile gate + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors && npx jest messages`
Expected: tsc 0; all suites green (≥ 731 + new); noHardcodedColors PASS; messages PASS.
Emoji scan: `rg -n "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src/screens/AgentScreen.tsx src/i18n/messages.ts || echo "no emoji"` → "no emoji".

```bash
git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx
git commit --no-verify -m "feat(mobile): Grid strategy template — picker, form, strategy row

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final verification

- [ ] **Server:** `cd server && npx tsc --noEmit && npx jest` — 0 tsc errors; green, ≥ 120 tests + new grid tests (types/grid/validate/store/sqlite/scheduler/app).
- [ ] **Mobile:** `cd mobile && npx tsc --noEmit && npx jest` (≥ 731) `&& npx jest noHardcodedColors && npx jest messages`; emoji scan on `AgentScreen.tsx` + `messages.ts` → "no emoji".
- [ ] Report final server + mobile pass counts vs baselines (server 120, mobile 731). Await the user's explicit "push".

## Self-review notes (spec coverage)

- Execution model (mark-crossing IoC) → Task 6 grid loop. ✓
- Inventory-bounded long (buy non-reduce, sell reduce-only, never net short) → Task 6 (`reduceOnly: act.side === "sell"`). ✓
- Params + validation → Tasks 1 + 3. ✓
- State `lastLevel`/`actionsDone` + seed-on-first-tick + monotonic cloid → Tasks 1, 4, 5, 6. ✓
- Guardrails (per-order cap, daily cap on buys, kill-switch halts) → Task 6. ✓
- Persistence (memory + sqlite) → Tasks 4 + 5. ✓
- HTTP contract (generic POST + DTO `lastLevel`) → Task 7. ✓
- Mobile api/controller/i18n/screen → Tasks 8–11. ✓
- Activity recording on fill → Task 6 (`activity.record`). ✓
