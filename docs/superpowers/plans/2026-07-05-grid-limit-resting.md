# gridLimit Resting Limit Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new long-only resting-limit grid strategy (`gridLimit`) that rests ALO/post-only limit orders on grid lines, detects fills by diffing open orders, and re-places the paired reduce-only take-profit / buy order — server engine + mobile UI.

**Architecture:** A new strategy kind `gridLimit` with a per-rung state machine (`idle`/`armed`/`holding`) persisted in a new one-to-many `grid_orders` table. A new agent-signed `RestingExecutor` places ALO orders + cancels by cloid; a new `OpenOrdersReader` polls `frontendOpenOrders`. The scheduler gets a `gridLimit` reconcile branch (fill detection via open-order diff, place/cancel, caps gating, drain-on-stop/kill). Mobile adds a `gridLimit` template + row.

**Tech Stack:** TypeScript, Fastify strategy engine (`server/`), better-sqlite3, `@nktkas/hyperliquid` (ExchangeClient.order/cancelByCloid, InfoClient.frontendOpenOrders); Expo React Native (`mobile/`), Jest.

**Key HL SDK facts (verified):** ALO order `t: { limit: { tif: "Alo" } }` (post-only; rejects if it would cross). `cancelByCloid({ cancels: [{ asset: assetIndex, cloid }] })`. `frontendOpenOrders({ user })` → array of `{ cloid: 0x..|null, oid, coin, side: "B"|"A", limitPx, sz }`. Order tuple: `{ a: assetIndex, b: isBuy, p: priceStr, s: sizeStr, r: reduceOnly, t: { limit: { tif } }, c: cloid }`, call `client.order({ orders: [tuple], grouping: "na" })`.

---

### Task 1: Types + validation for `gridLimit`

**Files:**
- Modify: `server/src/strategies/types.ts`
- Modify: `server/src/strategies/validate.ts`
- Test: `server/src/strategies/validate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/strategies/validate.test.ts`:

```ts
describe("validateParams gridLimit", () => {
  const ok = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
  it("accepts a valid gridLimit", () => {
    expect(validateParams("gridLimit", ok)).toEqual({ ok: true, params: ok });
  });
  it("rejects upper <= lower", () => {
    expect(validateParams("gridLimit", { ...ok, upperPrice: 100 }).ok).toBe(false);
  });
  it("rejects levels < 2", () => {
    expect(validateParams("gridLimit", { ...ok, levels: 1 }).ok).toBe(false);
  });
  it("rejects perLevelUsdc <= 0", () => {
    expect(validateParams("gridLimit", { ...ok, perLevelUsdc: 0 }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx jest validate`
Expected: FAIL — `gridLimit` is not a known kind.

- [ ] **Step 3: Extend the types**

In `server/src/strategies/types.ts`, replace the first two lines:

```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid";
export type StrategyStatus = "running" | "paused" | "completed";
```

with:

```ts
export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";
export type StrategyStatus = "running" | "paused" | "completed" | "canceling";
```

Add the `GridLimitParams` interface immediately after the `GridParams` interface (after its closing `}`):

```ts
export interface GridLimitParams {
  coin: string;
  lowerPrice: number;
  upperPrice: number;
  /** Number of grid lines (>= 2); rungs = levels - 1. */
  levels: number;
  /** Notional (USDC) rested as a buy per rung. */
  perLevelUsdc: number;
}
```

Update the `StrategyParams` union:

```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams;
```

Add a member to the `Strategy` discriminated union (after the `grid` member):

```ts
  | (StrategyBase & { kind: "gridLimit"; params: GridLimitParams });
```

- [ ] **Step 4: Add the validate branch**

In `server/src/strategies/validate.ts`, update the import to add `GridLimitParams`:

```ts
import type { StrategyKind, StrategyParams, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams } from "./types";
```

Immediately before the final `return { ok: false, error: "unknown strategy kind" };`, add:

```ts
  if (kind === "gridLimit") {
    const g = p as unknown as GridLimitParams;
    if (!positiveNumber(g.lowerPrice)) return { ok: false, error: "lowerPrice must be > 0" };
    if (!positiveNumber(g.upperPrice) || g.upperPrice <= g.lowerPrice) return { ok: false, error: "upperPrice must be > lowerPrice" };
    if (!positiveInteger(g.levels) || g.levels < 2) return { ok: false, error: "levels must be an integer >= 2" };
    if (!positiveNumber(g.perLevelUsdc)) return { ok: false, error: "perLevelUsdc must be > 0" };
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc } };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx jest validate types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/strategies/types.ts server/src/strategies/validate.ts server/src/strategies/validate.test.ts
git commit --no-verify -m "feat(gridLimit): strategy kind, params, canceling status + validation

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Pure grid-limit geometry (`gridLimit.ts`)

**Files:**
- Create: `server/src/strategies/gridLimit.ts`
- Test: `server/src/strategies/gridLimit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/strategies/gridLimit.test.ts`:

```ts
import { gridLimitStep, gridLimitLine, rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable } from "./gridLimit";
import type { GridLimitParams } from "./types";

const P: GridLimitParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
// step 20; lines 100,120,140,160,180,200 (idx 0..5); rungs 0..4

describe("grid-limit geometry", () => {
  it("computes step and lines", () => {
    expect(gridLimitStep(P)).toBe(20);
    expect(gridLimitLine(P, 0)).toBe(100);
    expect(gridLimitLine(P, 5)).toBe(200);
  });
  it("has levels-1 rungs with buy@i / sell@i+1", () => {
    expect(rungCount(P)).toBe(5);
    expect(rungBuyPrice(P, 2)).toBe(140);
    expect(rungSellPrice(P, 2)).toBe(160);
  });
  it("sizes a rung's buy in coin = perLevelUsdc / buyPrice", () => {
    expect(rungSizeCoin(P, 4)).toBeCloseTo(50 / 180, 9); // line[4]=180
  });
  it("is armable only when the buy line is strictly below mark", () => {
    expect(armable(P, 2, 150)).toBe(true); // 140 < 150
    expect(armable(P, 3, 150)).toBe(false); // 160 !< 150
    expect(armable(P, 2, 140)).toBe(false); // 140 !< 140
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest gridLimit.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helpers**

Create `server/src/strategies/gridLimit.ts`:

```ts
import type { GridLimitParams } from "./types";

/** Per-rung persisted state. A rung holds at most one resting order at a time. */
export interface RungState {
  rung: number;
  state: "idle" | "armed" | "holding";
  side: "buy" | "sell" | null;
  cloid: string | null;
  px: number | null;
  seq: number;
}

/** Grid-line spacing = (upper - lower) / (levels - 1); 0 for a degenerate single-level grid. */
export function gridLimitStep(p: GridLimitParams): number {
  return p.levels > 1 ? (p.upperPrice - p.lowerPrice) / (p.levels - 1) : 0;
}

/** Absolute price of grid line `i` (0-based). */
export function gridLimitLine(p: GridLimitParams, i: number): number {
  return p.lowerPrice + i * gridLimitStep(p);
}

/** Number of rungs = grid lines - 1 (each rung is buy@i / sell@i+1). */
export function rungCount(p: GridLimitParams): number {
  return Math.max(0, p.levels - 1);
}

/** The resting-buy price of rung `i` = line[i]. */
export function rungBuyPrice(p: GridLimitParams, i: number): number {
  return gridLimitLine(p, i);
}

/** The reduce-only take-profit sell price of rung `i` = line[i+1]. */
export function rungSellPrice(p: GridLimitParams, i: number): number {
  return gridLimitLine(p, i + 1);
}

/** Coin size for rung `i` = perLevelUsdc valued at the buy line. */
export function rungSizeCoin(p: GridLimitParams, i: number): number {
  const px = rungBuyPrice(p, i);
  return px > 0 ? p.perLevelUsdc / px : 0;
}

/** A rung can rest a maker BUY only when its buy line is strictly below the mark. */
export function armable(p: GridLimitParams, i: number, mark: number): boolean {
  return rungBuyPrice(p, i) < mark;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest gridLimit.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/gridLimit.ts server/src/strategies/gridLimit.test.ts
git commit --no-verify -m "feat(gridLimit): pure grid geometry + RungState type

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `cloidForKey` (string-keyed deterministic cloid)

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/engine/scheduler.test.ts` (add `cloidForKey` to the existing import from `./scheduler`):

```ts
describe("cloidForKey", () => {
  it("is deterministic per (strategyId, key) and 34-char hex", () => {
    const a = cloidForKey("s1", "gl:2:3");
    expect(a).toBe(cloidForKey("s1", "gl:2:3"));
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
  });
  it("differs across keys and strategies", () => {
    expect(cloidForKey("s1", "gl:2:3")).not.toBe(cloidForKey("s1", "gl:2:4"));
    expect(cloidForKey("s1", "gl:2:3")).not.toBe(cloidForKey("s2", "gl:2:3"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest scheduler -t cloidForKey`
Expected: FAIL — `cloidForKey` not exported.

- [ ] **Step 3: Add the helper**

In `server/src/engine/scheduler.ts`, immediately after the existing `cloidFor` function, add:

```ts
/** Like {@link cloidFor} but keyed by an arbitrary string slot (e.g. gridLimit `gl:${rung}:${seq}`). */
export function cloidForKey(strategyId: string, key: string): string {
  const h = createHash("sha256").update(`${strategyId}:${key}`).digest("hex");
  return `0x${h.slice(0, 32)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest scheduler -t cloidForKey`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(gridLimit): cloidForKey string-slot deterministic cloid

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Store — gridLimit rung state (MemoryStrategyStore)

**Files:**
- Modify: `server/src/strategies/store.ts`
- Test: `server/src/strategies/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/strategies/store.test.ts`:

```ts
describe("gridLimit rung state (memory)", () => {
  it("builds a gridLimit strategy and defaults to no rung rows", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    expect(s.kind).toBe("gridLimit");
    expect(s.filledTotalUsdc).toBe(0);
    expect(store.gridLimitRungs(s.id)).toEqual([]);
  });
  it("upserts a rung and reads it back; addFilledUsdc accumulates", () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    store.setGridLimitRung(s.id, { rung: 2, state: "armed", side: "buy", cloid: "0xabc", px: 140, seq: 1 });
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xdef", px: 160, seq: 2 });
    expect(store.gridLimitRungs(s.id)).toEqual([{ rung: 2, state: "holding", side: "sell", cloid: "0xdef", px: 160, seq: 2 }]);
    store.addFilledUsdc(s.id, 10);
    store.addFilledUsdc(s.id, 5);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest store.test`
Expected: FAIL — `gridLimitRungs`/`setGridLimitRung`/`addFilledUsdc` do not exist.

- [ ] **Step 3: Extend the store interface + Memory implementation**

In `server/src/strategies/store.ts`, add the import at the top:

```ts
import type { RungState } from "./gridLimit";
```

Add to the `StrategyStore` interface (after `recordGridAction`):

```ts
  /** gridLimit: all persisted rung states for a strategy (rungs never touched are absent). */
  gridLimitRungs(id: string): RungState[];
  /** gridLimit: upsert a rung's state. */
  setGridLimitRung(id: string, rung: RungState): void;
  /** Increment realized notional/pnl (used by gridLimit take-profit + generic accounting). */
  addFilledUsdc(id: string, usdc: number): void;
```

In `build(...)`, add a `gridLimit` branch before the final `return`:

```ts
  if (kind === "gridLimit") return { ...base, kind, params: params as GridLimitParams, filledTotalUsdc: 0 };
```

Update the `build` import line at the top of the file to include `GridLimitParams`:

```ts
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams } from "./types";
```

In `MemoryStrategyStore`, add a rungs map field and the three methods:

```ts
  private rungs = new Map<string, Map<number, RungState>>();

  gridLimitRungs(id: string): RungState[] {
    return [...(this.rungs.get(id)?.values() ?? [])].sort((a, b) => a.rung - b.rung);
  }
  setGridLimitRung(id: string, rung: RungState): void {
    let m = this.rungs.get(id);
    if (!m) { m = new Map(); this.rungs.set(id, m); }
    m.set(rung.rung, { ...rung });
  }
  addFilledUsdc(id: string, usdc: number): void {
    const s = this.byId.get(id);
    if (s) s.filledTotalUsdc = (s.filledTotalUsdc ?? 0) + usdc;
  }
```

In `MemoryStrategyStore.remove`, also drop the rungs (find the existing `remove` and add the rungs cleanup):

```ts
  remove(id: string): void {
    this.byId.delete(id);
    this.rungs.delete(id);
  }
```

(If the existing `remove` only deletes from `byId`, add the `this.rungs.delete(id);` line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest store.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/store.ts server/src/strategies/store.test.ts
git commit --no-verify -m "feat(gridLimit): MemoryStrategyStore rung state + addFilledUsdc

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Store — `grid_orders` table (SqliteStrategyStore)

**Files:**
- Modify: `server/src/strategies/sqliteStore.ts`
- Test: `server/src/strategies/sqliteStore.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/strategies/sqliteStore.test.ts` (reuse the file's existing DB setup pattern — open an in-memory store the same way the other tests in this file do; if they use a helper like `openStore()`, use it):

```ts
describe("gridLimit persistence (sqlite)", () => {
  it("creates a gridLimit strategy, upserts rungs, accumulates filled, cascades delete", () => {
    const db = new Database(":memory:");
    const store = SqliteStrategyStore.fromDb(db, () => 0);
    const s = store.create("0xo", "gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    expect(store.get(s.id)!.kind).toBe("gridLimit");
    expect(store.gridLimitRungs(s.id)).toEqual([]);

    store.setGridLimitRung(s.id, { rung: 1, state: "armed", side: "buy", cloid: "0xa", px: 120, seq: 1 });
    store.setGridLimitRung(s.id, { rung: 1, state: "holding", side: "sell", cloid: "0xb", px: 140, seq: 2 });
    store.setGridLimitRung(s.id, { rung: 3, state: "armed", side: "buy", cloid: "0xc", px: 160, seq: 1 });
    expect(store.gridLimitRungs(s.id)).toEqual([
      { rung: 1, state: "holding", side: "sell", cloid: "0xb", px: 140, seq: 2 },
      { rung: 3, state: "armed", side: "buy", cloid: "0xc", px: 160, seq: 1 },
    ]);

    store.addFilledUsdc(s.id, 7);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(7);

    store.remove(s.id);
    expect(store.gridLimitRungs(s.id)).toEqual([]);
  });
});
```

Ensure `import Database from "better-sqlite3";` exists at the top of the test file (it does if other tests open `:memory:` DBs; add it if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest sqliteStore.test`
Expected: FAIL — methods/table missing.

- [ ] **Step 3: Add the migration + methods**

In `server/src/strategies/sqliteStore.ts`, update the top import to include `GridLimitParams` and `RungState`:

```ts
import type { RungState } from "./gridLimit";
```

In `migrate(db)`, after the existing `strategies` table setup + `ALTER TABLE` blocks, add:

```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS grid_orders (
      strategy_id TEXT NOT NULL,
      rung INTEGER NOT NULL,
      state TEXT NOT NULL,
      side TEXT,
      cloid TEXT,
      px REAL,
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (strategy_id, rung)
    )
  `);
```

In `toStrategy(row)`, add a `gridLimit` branch (before the final `dca` fallthrough `return`):

```ts
  if (row.kind === "gridLimit") return { ...base, kind: "gridLimit", params, filledTotalUsdc: row.filled_total_usdc };
```

In `create(...)`, include `gridLimit` in the "scheduled 0" set (grid/tpsl/gridLimit have no `nextRunAt` schedule):

```ts
    const scheduled = kind === "tpsl" || kind === "grid" || kind === "gridLimit" ? 0 : now;
```

Add the three methods to `SqliteStrategyStore` (near `recordGridAction`):

```ts
  gridLimitRungs(id: string): RungState[] {
    const rows = this.db
      .prepare("SELECT rung, state, side, cloid, px, seq FROM grid_orders WHERE strategy_id = ? ORDER BY rung")
      .all(id) as Array<{ rung: number; state: string; side: string | null; cloid: string | null; px: number | null; seq: number }>;
    return rows.map((r) => ({ rung: r.rung, state: r.state as RungState["state"], side: (r.side ?? null) as RungState["side"], cloid: r.cloid, px: r.px, seq: r.seq }));
  }
  setGridLimitRung(id: string, r: RungState): void {
    this.db
      .prepare("INSERT INTO grid_orders (strategy_id, rung, state, side, cloid, px, seq) VALUES (?,?,?,?,?,?,?) ON CONFLICT(strategy_id, rung) DO UPDATE SET state=excluded.state, side=excluded.side, cloid=excluded.cloid, px=excluded.px, seq=excluded.seq")
      .run(id, r.rung, r.state, r.side, r.cloid, r.px, r.seq);
  }
  addFilledUsdc(id: string, usdc: number): void {
    this.db.prepare("UPDATE strategies SET filled_total_usdc = filled_total_usdc + ? WHERE id = ?").run(usdc, id);
  }
```

Update `remove(id)` to cascade-delete rungs:

```ts
  remove(id: string): void {
    this.db.prepare("DELETE FROM grid_orders WHERE strategy_id = ?").run(id);
    this.db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest sqliteStore.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/sqliteStore.ts server/src/strategies/sqliteStore.test.ts
git commit --no-verify -m "feat(gridLimit): grid_orders table + sqlite rung persistence

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: `RestingExecutor` (ALO place + cancel by cloid)

**Files:**
- Create: `server/src/agent/restingExecutor.ts`
- Test: `server/src/agent/restingExecutor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/restingExecutor.test.ts`:

```ts
import { makeRestingExecutor, type RestingClientLike } from "./restingExecutor";

function deps(client: RestingClientLike | undefined, opts: { orders?: unknown[] } = {}) {
  return {
    clientFor: () => client,
    resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }),
    _opts: opts,
  };
}

const restingRes = { response: { data: { statuses: [{ resting: { oid: 999 } }] } } };
const rejectRes = { response: { data: { statuses: [{ error: "Post only order would have immediately matched" }] } } };
const filledRes = { response: { data: { statuses: [{ filled: { totalSz: "0.5", avgPx: "120" } }] } } };

describe("makeRestingExecutor.placeLimit", () => {
  it("sends an Alo limit tuple and returns the resting oid", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async (p) => { calls.push(p); return restingRes; }, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client));
    const r = await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.357, side: "buy", reduceOnly: false, cloid: "0xc" });
    expect(r).toEqual({ ok: true, oid: 999 });
    expect(calls[0].orders[0]).toMatchObject({ a: 3, b: true, r: false, c: "0xc", t: { limit: { tif: "Alo" } } });
    expect(calls[0].orders[0].s).toBe("0.36"); // roundSize to szDecimals=2
  });
  it("flags an ALO post-only rejection", async () => {
    const client: RestingClientLike = { order: async () => rejectRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "sell", reduceOnly: true, cloid: "0xc" })).toEqual({ ok: false, rejected: true });
  });
  it("returns an immediate fill when the order crosses (rare)", async () => {
    const client: RestingClientLike = { order: async () => filledRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: true, filledSz: 0.5, avgPx: 120 });
  });
  it("fails closed with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: false });
  });
});

describe("makeRestingExecutor.cancelCloid", () => {
  it("cancels by cloid and returns true", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(true);
    expect(calls[0]).toEqual({ cancels: [{ asset: 3, cloid: "0xc" }] });
  });
  it("swallows a cancel error (already gone) and returns true", async () => {
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => { throw new Error("order not found"); } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(true);
  });
  it("returns false with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest restingExecutor.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the executor**

Create `server/src/agent/restingExecutor.ts`:

```ts
import { roundSize, formatPrice } from "../hl/format";

/** Agent-signed client surface used by the resting executor. */
export interface RestingClientLike {
  order(params: unknown): Promise<unknown>;
  cancelByCloid(params: unknown): Promise<unknown>;
}

export interface RestingExecutorDeps {
  clientFor(owner: string): RestingClientLike | undefined;
  resolveAsset(coin: string): Promise<{ assetIndex: number; szDecimals: number }>;
}

export interface PlaceLimitRequest {
  owner: string;
  coin: string;
  price: number;
  sizeCoin: number;
  side: "buy" | "sell";
  reduceOnly: boolean;
  cloid: string;
}

export type PlaceLimitResult =
  | { ok: true; oid: number }
  | { ok: true; filledSz: number; avgPx: number }
  | { ok: false; rejected?: boolean };

export interface RestingExecutor {
  placeLimit(req: PlaceLimitRequest): Promise<PlaceLimitResult>;
  cancelCloid(req: { owner: string; coin: string; cloid: string }): Promise<boolean>;
}

interface OrderStatus {
  filled?: { totalSz: string; avgPx: string };
  resting?: { oid: number };
  error?: string;
}

function statusOf(res: unknown): OrderStatus | undefined {
  return (res as { response?: { data?: { statuses?: OrderStatus[] } } })?.response?.data?.statuses?.[0];
}

/**
 * Build the resting-order executor on an agent-signed client. Every placement is an ALO (post-only,
 * maker-only) limit at an exact price; a cross would be rejected by HL (returned as
 * `{ ok:false, rejected:true }`). Fails closed (`{ ok:false }`) on no client / error.
 */
export function makeRestingExecutor(deps: RestingExecutorDeps): RestingExecutor {
  return {
    async placeLimit(req: PlaceLimitRequest): Promise<PlaceLimitResult> {
      const client = deps.clientFor(req.owner);
      if (!client) return { ok: false };
      try {
        const { assetIndex, szDecimals } = await deps.resolveAsset(req.coin);
        const size = roundSize(req.sizeCoin, szDecimals);
        if (!(size > 0) || !(req.price > 0)) return { ok: false };
        const order = {
          a: assetIndex,
          b: req.side === "buy",
          p: formatPrice(req.price, szDecimals),
          s: size.toString(),
          r: req.reduceOnly,
          t: { limit: { tif: "Alo" as const } },
          c: req.cloid,
        };
        const res = await client.order({ orders: [order], grouping: "na" });
        const st = statusOf(res);
        if (st?.resting?.oid !== undefined) return { ok: true, oid: st.resting.oid };
        if (st?.filled) {
          const sz = Number(st.filled.totalSz);
          const px = Number(st.filled.avgPx);
          if (Number.isFinite(sz) && Number.isFinite(px)) return { ok: true, filledSz: sz, avgPx: px };
        }
        if (st?.error) return { ok: false, rejected: /post only/i.test(st.error) };
        return { ok: false };
      } catch {
        return { ok: false };
      }
    },

    async cancelCloid(req: { owner: string; coin: string; cloid: string }): Promise<boolean> {
      const client = deps.clientFor(req.owner);
      if (!client) return false;
      try {
        const { assetIndex } = await deps.resolveAsset(req.coin);
        await client.cancelByCloid({ cancels: [{ asset: assetIndex, cloid: req.cloid }] });
        return true;
      } catch {
        return true; // already gone / filled — treat as cancelled (idempotent)
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest restingExecutor.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/restingExecutor.ts server/src/agent/restingExecutor.test.ts
git commit --no-verify -m "feat(gridLimit): RestingExecutor (ALO place + cancel by cloid)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: `OpenOrdersReader` (poll frontendOpenOrders → cloid map)

**Files:**
- Create: `server/src/agent/openOrdersReader.ts`
- Test: `server/src/agent/openOrdersReader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/openOrdersReader.test.ts`:

```ts
import { makeOpenOrdersReader } from "./openOrdersReader";

describe("makeOpenOrdersReader.openCloids", () => {
  it("maps cloid -> order (B/A side), dropping null-cloid orders", async () => {
    const info = {
      frontendOpenOrders: async ({ user }: { user: string }) => {
        expect(user).toBe("0xo");
        return [
          { cloid: "0xaa", oid: 1, coin: "BTC", side: "B", limitPx: "140", sz: "0.5" },
          { cloid: null, oid: 2, coin: "BTC", side: "A", limitPx: "160", sz: "0.5" },
          { cloid: "0xbb", oid: 3, coin: "ETH", side: "A", limitPx: "3000", sz: "1" },
        ];
      },
    };
    const reader = makeOpenOrdersReader(info as never);
    const map = await reader.openCloids("0xo");
    expect([...map.keys()].sort()).toEqual(["0xaa", "0xbb"]);
    expect(map.get("0xaa")).toEqual({ oid: 1, coin: "BTC", side: "buy", px: 140 });
    expect(map.get("0xbb")).toEqual({ oid: 3, coin: "ETH", side: "sell", px: 3000 });
  });
  it("returns an empty map for a non-array response", async () => {
    const reader = makeOpenOrdersReader({ frontendOpenOrders: async () => null } as never);
    expect((await reader.openCloids("0xo")).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest openOrdersReader.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reader**

Create `server/src/agent/openOrdersReader.ts`:

```ts
export interface OpenOrderInfo {
  oid: number;
  coin: string;
  side: "buy" | "sell";
  px: number;
}

/** Minimal injectable Info surface for open orders. */
export interface OpenOrdersInfoLike {
  frontendOpenOrders(args: { user: string }): Promise<unknown>;
}

export interface OpenOrdersReader {
  openCloids(owner: string): Promise<Map<string, OpenOrderInfo>>;
}

interface RawOpenOrder {
  cloid?: string | null;
  oid?: number;
  coin?: string;
  side?: "B" | "A";
  limitPx?: string;
}

/** Poll a user's open orders and index them by client order id (cloid). Null-cloid orders (not ours) are dropped. */
export function makeOpenOrdersReader(info: OpenOrdersInfoLike): OpenOrdersReader {
  return {
    async openCloids(owner: string): Promise<Map<string, OpenOrderInfo>> {
      const raw = await info.frontendOpenOrders({ user: owner });
      const out = new Map<string, OpenOrderInfo>();
      if (!Array.isArray(raw)) return out;
      for (const o of raw as RawOpenOrder[]) {
        if (typeof o?.cloid !== "string") continue;
        out.set(o.cloid, {
          oid: Number(o.oid ?? 0),
          coin: o.coin ?? "",
          side: o.side === "A" ? "sell" : "buy",
          px: Number(o.limitPx ?? 0),
        });
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest openOrdersReader.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/openOrdersReader.ts server/src/agent/openOrdersReader.test.ts
git commit --no-verify -m "feat(gridLimit): OpenOrdersReader (frontendOpenOrders -> cloid map)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Scheduler — gridLimit reconcile (running)

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`

This task handles RUNNING gridLimit strategies (arm buys, detect fills, place the paired order, caps gating, ALO-reject retry). Draining (pause/kill/canceling) is Task 9.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/engine/scheduler.test.ts`:

```ts
import { makeRestingExecutor } from "../agent/restingExecutor";

// A fake resting executor whose placeLimit records calls and returns an incrementing resting oid;
// callers can override the outcome per test.
function fakeExec(outcome?: (req: any) => any) {
  const calls: any[] = [];
  const cancels: any[] = [];
  let oid = 1000;
  return {
    calls, cancels,
    placeLimit: jest.fn(async (req: any) => { calls.push(req); return outcome ? outcome(req) : { ok: true, oid: oid++ }; }),
    cancelCloid: jest.fn(async (req: any) => { cancels.push(req); return true; }),
  };
}
function fakeReader(cloids: string[]) {
  return { openCloids: jest.fn(async () => new Map(cloids.map((c) => [c, { oid: 1, coin: "BTC", side: "buy" as const, px: 100 }]))) };
}

const glParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
// lines 100,120,140,160,180,200; rungs 0..4 (buy@line[i], sell@line[i+1])

describe("gridLimit tick (running)", () => {
  it("arms resting buys on every rung whose buy line is below the mark", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    // buy lines below 150: 100,120,140 -> rungs 0,1,2 armed
    const armed = store.gridLimitRungs(s.id).filter((r) => r.state === "armed").map((r) => r.rung);
    expect(armed).toEqual([0, 1, 2]);
    expect(exec.placeLimit).toHaveBeenCalledTimes(3);
    expect(exec.calls[0]).toMatchObject({ side: "buy", reduceOnly: false, price: 100 });
  });

  it("on a filled buy, places a reduce-only sell one line up and goes holding", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "armed", side: "buy", cloid: "0xBUY", px: 140, seq: 1 });
    const exec = fakeExec();
    const reader = fakeReader([]); // 0xBUY no longer open -> filled
    const marks = { resolveMark: async () => 145, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    const r2 = store.gridLimitRungs(s.id).find((r) => r.rung === 2)!;
    expect(r2).toMatchObject({ state: "holding", side: "sell", px: 160 });
    expect(exec.calls.find((c) => c.side === "sell")).toMatchObject({ side: "sell", reduceOnly: true, price: 160 });
  });

  it("on a filled sell, realizes profit and re-arms the buy", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xSELL", px: 160, seq: 2 });
    const exec = fakeExec();
    const reader = fakeReader([]); // 0xSELL gone -> filled
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    const r2 = store.gridLimitRungs(s.id).find((r) => r.rung === 2)!;
    expect(r2.state).toBe("armed"); // 140 < 150 -> re-armed
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo((160 - 140) * (50 / 140), 6); // profit
  });

  it("does not re-arm a rung whose buy line is at/above mark (stays idle)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 4, state: "holding", side: "sell", cloid: "0xSELL", px: 200, seq: 2 });
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined }; // line[4]=180 >= 150
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(store.gridLimitRungs(s.id).find((r) => r.rung === 4)!.state).toBe("idle");
  });

  it("leaves a rung unchanged when an ALO placement is rejected (retry next tick)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec(() => ({ ok: false, rejected: true }));
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(store.gridLimitRungs(s.id).filter((r) => r.state === "armed")).toEqual([]);
  });

  it("gates buys with the per-order notional cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const reader = fakeReader([]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 10 }, false, 0, undefined, marks, exec as any, reader as any); // perLevelUsdc 50 > 10
    expect(exec.placeLimit).not.toHaveBeenCalled();
  });

  it("keeps an already-resting armed buy without re-placing", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xBUY0", px: 100, seq: 1 });
    const exec = fakeExec();
    const reader = fakeReader(["0xBUY0"]); // still open
    const marks = { resolveMark: async () => 110, resolvePosition: async () => undefined }; // only rung 0 armable (100<110)
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(exec.placeLimit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest scheduler -t "gridLimit tick"`
Expected: FAIL — `tick` does not accept the executor/reader args and has no gridLimit branch.

- [ ] **Step 3: Extend `tick` signature + imports**

In `server/src/engine/scheduler.ts`, add imports:

```ts
import type { GridLimitParams } from "../strategies/types";
import { rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable, type RungState } from "../strategies/gridLimit";
import type { RestingExecutor } from "../agent/restingExecutor";
import type { OpenOrdersReader } from "../agent/openOrdersReader";
```

(The `GridLimitParams` may already be importable from the existing `../strategies/types` import line — merge it in rather than duplicating the import.)

Extend the `tick` signature (add two optional trailing params):

```ts
export async function tick(
  store: StrategyStore,
  placer: OrderPlacer,
  limits: RiskLimits,
  killSwitch: boolean,
  now: number,
  activity?: ActivityRecorder,
  marks?: MarkDeps,
  restingExec?: RestingExecutor,
  ordersReader?: OpenOrdersReader,
): Promise<void> {
```

- [ ] **Step 4: Add the gridLimit reconcile branch**

At the END of the `tick` function body (after the existing grid block, before the function closes), add:

```ts
  // --- gridLimit: resting limit grid reconcile (running strategies) ---
  if (restingExec && ordersReader && marks) {
    const openByOwner = new Map<string, Map<string, { side: "buy" | "sell"; px: number }>>();
    const getOpen = async (owner: string) => {
      let m = openByOwner.get(owner);
      if (!m) { m = await ordersReader.openCloids(owner); openByOwner.set(owner, m); }
      return m;
    };

    for (const s of all) {
      if (s.kind !== "gridLimit") continue;
      if (s.status !== "running" || killSwitch) continue; // draining handled in Task 9
      const p = s.params as GridLimitParams;
      const mark = await marks.resolveMark(p.coin);
      if (!Number.isFinite(mark) || mark <= 0) continue;
      const open = await getOpen(s.owner);

      const stored = new Map(store.gridLimitRungs(s.id).map((r) => [r.rung, r]));
      const rungAt = (i: number): RungState => stored.get(i) ?? { rung: i, state: "idle", side: null, cloid: null, px: null, seq: 0 };

      const placeSell = async (i: number, prev: RungState) => {
        const seq = prev.seq + 1;
        const cloid = cloidForKey(s.id, `gl:${i}:${seq}`);
        const res = await restingExec.placeLimit({ owner: s.owner, coin: p.coin, price: rungSellPrice(p, i), sizeCoin: rungSizeCoin(p, i), side: "sell", reduceOnly: true, cloid });
        if (res.ok && "oid" in res) store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "sell", cloid, px: rungSellPrice(p, i), seq });
        else store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "sell", cloid: null, px: rungSellPrice(p, i), seq: prev.seq });
      };
      const placeBuy = async (i: number, prev: RungState) => {
        if (!withinCaps({ notionalUsdc: p.perLevelUsdc, killSwitch, coin: p.coin }, limits).ok) return;
        if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
          if (activity.notionalSince(s.owner, dayStartUtcMs(now)) + p.perLevelUsdc > limits.dailyMaxNotionalUsdc) return;
        }
        const seq = prev.seq + 1;
        const cloid = cloidForKey(s.id, `gl:${i}:${seq}`);
        const res = await restingExec.placeLimit({ owner: s.owner, coin: p.coin, price: rungBuyPrice(p, i), sizeCoin: rungSizeCoin(p, i), side: "buy", reduceOnly: false, cloid });
        if (res.ok && "oid" in res) store.setGridLimitRung(s.id, { rung: i, state: "armed", side: "buy", cloid, px: rungBuyPrice(p, i), seq });
      };

      for (let i = 0; i < rungCount(p); i++) {
        let r = rungAt(i);

        // fill detection: a tracked resting order that vanished from open orders filled
        if ((r.state === "armed" || r.state === "holding") && r.cloid && !open.has(r.cloid)) {
          if (r.state === "armed") {
            if (activity && r.px) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: "buy", sz: rungSizeCoin(p, i), px: r.px });
            await placeSell(i, r);
            continue;
          }
          // sell filled -> realize profit + re-arm
          if (activity && r.px) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: "sell", sz: rungSizeCoin(p, i), px: r.px });
          store.addFilledUsdc(s.id, Math.max(0, (rungSellPrice(p, i) - rungBuyPrice(p, i)) * rungSizeCoin(p, i)));
          store.setGridLimitRung(s.id, { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq });
          r = { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq };
        }

        // placement: ensure the desired resting order exists
        if (r.state === "holding") {
          if (!r.cloid) await placeSell(i, r); // retry a failed sell placement
          continue;
        }
        if (r.state === "armed" && r.cloid && open.has(r.cloid)) continue; // already resting
        if (armable(p, i, mark)) await placeBuy(i, r);
        // not armable -> stay idle
      }
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx jest scheduler`
Expected: PASS — new gridLimit-tick tests + all existing scheduler tests (the new params are optional, so existing `tick(...)` calls are unaffected).

- [ ] **Step 6: Commit**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(gridLimit): scheduler reconcile — arm/fill/re-arm + caps

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Scheduler — drain on pause / kill / canceling

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the same test file (new describe):

```ts
describe("gridLimit tick (draining)", () => {
  it("cancels all resting orders when paused and leaves the strategy paused", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xB0", px: 100, seq: 1 });
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xS2", px: 160, seq: 2 });
    store.setStatus(s.id, "paused");
    const exec = fakeExec();
    const reader = fakeReader(["0xB0", "0xS2"]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, reader as any);
    expect(exec.cancels.map((c) => c.cloid).sort()).toEqual(["0xB0", "0xS2"]);
    expect(store.gridLimitRungs(s.id).every((r) => r.state === "idle" && r.cloid === null)).toBe(true);
    expect(store.get(s.id)!.status).toBe("paused");
  });

  it("cancels all under the global kill-switch and does not place", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xB0", px: 100, seq: 1 });
    const exec = fakeExec();
    const reader = fakeReader(["0xB0"]);
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, true, 0, undefined, marks, exec as any, reader as any);
    expect(exec.cancels.map((c) => c.cloid)).toEqual(["0xB0"]);
    expect(exec.placeLimit).not.toHaveBeenCalled();
  });

  it("drains a canceling strategy then removes it once nothing is left resting", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 0, state: "armed", side: "buy", cloid: "0xB0", px: 100, seq: 1 });
    store.setStatus(s.id, "canceling");
    const exec = fakeExec();
    // First tick: order still open -> cancel it, not yet removed.
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader(["0xB0"]) as any);
    expect(store.get(s.id)).toBeDefined();
    // Second tick: order gone -> removed.
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    expect(store.get(s.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest scheduler -t "gridLimit tick (draining)"`
Expected: FAIL — draining strategies are currently skipped (`continue`).

- [ ] **Step 3: Replace the running-only guard with a drain branch**

In `server/src/engine/scheduler.ts`, inside the gridLimit loop, replace:

```ts
      if (s.kind !== "gridLimit") continue;
      if (s.status !== "running" || killSwitch) continue; // draining handled in Task 9
      const p = s.params as GridLimitParams;
```

with:

```ts
      if (s.kind !== "gridLimit") continue;
      const p = s.params as GridLimitParams;

      // Drain: paused / canceling / global kill -> cancel every resting order for this strategy.
      if (killSwitch || s.status !== "running") {
        const open = await getOpen(s.owner);
        let anyResting = false;
        for (const r of store.gridLimitRungs(s.id)) {
          if (!r.cloid) continue;
          if (open.has(r.cloid)) anyResting = true;
          await restingExec.cancelCloid({ owner: s.owner, coin: p.coin, cloid: r.cloid });
          store.setGridLimitRung(s.id, { rung: r.rung, state: "idle", side: null, cloid: null, px: null, seq: r.seq });
        }
        if (s.status === "canceling" && !anyResting) store.remove(s.id);
        continue;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest scheduler`
Expected: PASS (draining + running + all prior).

- [ ] **Step 5: Full server gate**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: PASS, ≥ 169 baseline + new tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(gridLimit): drain resting orders on pause/kill/canceling

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 10: HTTP — DELETE→canceling for gridLimit + GET rung summary

**Files:**
- Modify: `server/src/http/app.ts`
- Test: `server/src/http/app.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/http/app.test.ts`. The existing `build()` helper does not expose the store; add a `buildWithStore()` helper next to it that returns both, reusing the same deps:

```ts
function buildWithStore() {
  const auth = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
  const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
  const store = new MemoryStrategyStore(() => 1000);
  const app = buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000 });
  return { app, store };
}

describe("gridLimit HTTP", () => {
  const glParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("creates a gridLimit strategy and lists it with an armed/holding summary", async () => {
    const { app, store } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "gridLimit", params: glParams } });
    expect(created.statusCode).toBe(200); // POST returns the DTO (Fastify default 200)
    const id = created.json().id as string;
    store.setGridLimitRung(id, { rung: 0, state: "armed", side: "buy", cloid: "0xa", px: 100, seq: 1 });
    store.setGridLimitRung(id, { rung: 1, state: "holding", side: "sell", cloid: "0xb", px: 140, seq: 2 });
    const dto = (await app.inject({ method: "GET", url: "/strategies", headers: auth })).json().find((d: any) => d.id === id);
    expect(dto).toMatchObject({ type: "gridLimit", armedCount: 1, holdingCount: 1 });
  });

  it("DELETE of a gridLimit marks it canceling (not immediately removed)", async () => {
    const { app, store } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "gridLimit", params: glParams } });
    const id = created.json().id as string;
    const del = await app.inject({ method: "DELETE", url: `/strategies/${id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(store.get(id)!.status).toBe("canceling");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest app.test`
Expected: FAIL — DELETE removes immediately; DTO has no armed/holding summary.

- [ ] **Step 3: Add the summary to `toDto` + change DELETE for gridLimit**

In `server/src/http/app.ts`, the `toDto` function needs per-rung counts, which require the store. Change `toDto` to accept the store and compute counts for gridLimit. Replace the `toDto` definition:

```ts
function toDto(s: Strategy): StrategyDto {
```

with a store-aware version:

```ts
function toDto(s: Strategy, store: StrategyStore): StrategyDto {
  const summary =
    s.kind === "gridLimit"
      ? (() => {
          const rungs = store.gridLimitRungs(s.id);
          return { armedCount: rungs.filter((r) => r.state === "armed").length, holdingCount: rungs.filter((r) => r.state === "holding").length };
        })()
      : {};
```

and add `...summary,` into the returned object (alongside the existing spread fields), and update the `StrategyDto` type to include the optional counts:

```ts
  armedCount?: number;
  holdingCount?: number;
```

Update **all three** `toDto(...)` call sites to pass `deps.store`:
- `GET /strategies`: `return deps.store.list(owner).map((s) => toDto(s, deps.store));`
- `POST /strategies`: `return toDto(deps.store.create(owner, type, v.params), deps.store);`
- `PATCH /strategies/:id` (returns the updated strategy): `return toDto(deps.store.get(id)!, deps.store);`

In the `DELETE /strategies/:id` handler, replace `deps.store.remove(id);` with a kind-aware branch:

```ts
    const s = deps.store.get(id);
    if (s?.kind === "gridLimit" && s.status !== "canceling") {
      deps.store.setStatus(id, "canceling"); // scheduler drains resting orders, then removes
    } else {
      deps.store.remove(id);
    }
    return reply.code(204).send();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest app.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/app.ts server/src/http/app.test.ts
git commit --no-verify -m "feat(gridLimit): DELETE->canceling + GET armed/holding summary

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Wire the executor + reader into `index.ts`

**Files:**
- Modify: `server/src/agent/hlRuntime.ts`
- Modify: `server/src/index.ts`

Client factories + process wiring have no unit tests (consistent with the codebase); verified by `npx tsc --noEmit`.

- [ ] **Step 1: Widen `makeClientFor` to expose cancelByCloid**

In `server/src/agent/hlRuntime.ts`, add the import:

```ts
import type { RestingClientLike } from "./restingExecutor";
```

Change `makeClientFor`'s return type from `(owner: string) => ExchangeLike | undefined` to `(owner: string) => RestingClientLike | undefined` (the underlying `ExchangeClient` already has both `order` and `cancelByCloid`, and `RestingClientLike` is assignable to the placer's `ExchangeLike`, so the existing placer wiring still type-checks). Update the cast inside from `as unknown as ExchangeLike` to `as unknown as RestingClientLike`.

- [ ] **Step 2: Build + wire the executor and reader in `index.ts`**

In `server/src/index.ts`, add imports:

```ts
import { makeRestingExecutor } from "./agent/restingExecutor";
import { makeOpenOrdersReader } from "./agent/openOrdersReader";
```

After the existing `placer` construction, add:

```ts
  const clientFor = makeClientFor(agents, transport, now);
  const restingExec = makeRestingExecutor({ clientFor, resolveAsset: resolvers.resolveAsset });
  const ordersReader = makeOpenOrdersReader(info as unknown as { frontendOpenOrders(a: { user: string }): Promise<unknown> });
```

(If `makeClientFor(...)` is already invoked inline inside the `placer` construction, hoist it into the `clientFor` const and reuse it for both the placer and the executor.)

Pass the two new args to the `tick(...)` call (append after the `MarkDeps` object):

```ts
      { resolveMark: resolvers.resolvePrice, resolvePosition: resolvers.resolvePosition },
      restingExec,
      ordersReader,
```

- [ ] **Step 3: Verify types compile + full server suite**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: exit 0; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/agent/hlRuntime.ts server/src/index.ts
git commit --no-verify -m "feat(gridLimit): wire RestingExecutor + OpenOrdersReader into the scheduler

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 12: Mobile — type + controller `createGridLimit`

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/hooks/useStrategyController.ts`
- Test: `mobile/src/hooks/useStrategyController.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `mobile/src/hooks/useStrategyController.test.ts`:

```ts
  it("createGridLimit creates a gridLimit then refreshes", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "n"));
    await act(async () => {
      await result.current.createGridLimit({ coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    });
    expect(api.createStrategy).toHaveBeenCalledWith("gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest useStrategyController`
Expected: FAIL — `createGridLimit` does not exist.

- [ ] **Step 3: Add the type + controller method**

In `mobile/src/services/strategyApi.ts`, add a `GridLimitParams` interface (after `GridParams`) and extend the union + `StrategyKind`:

```ts
export interface GridLimitParams {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
}
```

Update `StrategyParams` to include it:

```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams;
```

Find the `StrategyKind`/`type` union used for `createStrategy` (e.g. `"dca" | "twap" | "tpsl" | "grid"`) and add `"gridLimit"`.

In `mobile/src/hooks/useStrategyController.ts`, add the import of `GridLimitParams` (extend the existing import from `../services/strategyApi`) and add a `createGridLimit` callback modeled on `createGrid`:

```ts
  const createGridLimit = useCallback(async (params: GridLimitParams) => {
    await api.createStrategy("gridLimit", params);
    await refresh();
  }, [api, refresh]);
```

Add `createGridLimit` to the returned object (alongside `createGrid`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest useStrategyController`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/strategyApi.ts mobile/src/hooks/useStrategyController.ts mobile/src/hooks/useStrategyController.test.ts
git commit --no-verify -m "feat(gridLimit): mobile GridLimitParams type + createGridLimit controller

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 13: Mobile — AgentScreen gridLimit template + row + i18n

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx`
- Modify: `mobile/src/i18n/messages.ts`
- Test: `mobile/src/screens/AgentScreen.test.tsx`

- [ ] **Step 1: Add i18n keys (en + zh)**

In `mobile/src/i18n/messages.ts`, in the ENGLISH block near the other `agent.grid*` keys, add:

```ts
    "agent.templateGridLimit": "Limit grid",
    "agent.newGridLimit": "New limit grid",
    "agent.createGridLimit": "Create limit grid",
    "agent.strategyGridLimit": "{coin} Limit grid",
    "agent.gridLimitProgress": "{armed} resting · {holding} holding · ${filled} pnl",
```

In the CHINESE block near its `agent.grid*` keys, add:

```ts
    "agent.templateGridLimit": "限价网格",
    "agent.newGridLimit": "新建限价网格",
    "agent.createGridLimit": "创建限价网格",
    "agent.strategyGridLimit": "{coin} 限价网格",
    "agent.gridLimitProgress": "{armed} 挂单 · {holding} 持仓 · ${filled} 盈亏",
```

- [ ] **Step 2: Write the failing tests**

In `mobile/src/screens/AgentScreen.test.tsx`, append (the existing tests show the template-picker + create flow; mirror them):

```ts
  it("switches to the Limit grid template and creates one", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-gridLimit")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-gridLimit"));
    fireEvent.changeText(screen.getByTestId("grid-limit-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("grid-limit-lower"), "100");
    fireEvent.changeText(screen.getByTestId("grid-limit-upper"), "200");
    fireEvent.changeText(screen.getByTestId("grid-limit-levels"), "6");
    fireEvent.changeText(screen.getByTestId("grid-limit-per-level"), "50");
    fireEvent.press(screen.getByTestId("grid-limit-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }),
    );
  });

  it("renders a gridLimit strategy row", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "gl1", type: "gridLimit", status: "running", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }, filledTotalUsdc: 12, armedCount: 3, holdingCount: 1 },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-gl1")).toBeTruthy());
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd mobile && npx jest AgentScreen`
Expected: FAIL — `template-gridLimit` / `grid-limit-*` not found.

- [ ] **Step 4: Implement the template + form + row**

In `mobile/src/screens/AgentScreen.tsx`:

4a. Extend the `Template` type + the template list. Find:

```ts
type Template = "dca" | "twap" | "tpsl" | "grid";
```

Replace with:

```ts
type Template = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";
```

Find the template picker array `(["dca", "twap", "tpsl", "grid"] as Template[])` and add `"gridLimit"`. In the label `t(...)` chain for the picker, add a branch: `k === "gridLimit" ? "agent.templateGridLimit"` before the `"grid"` fallback (or wherever appropriate so gridLimit maps to `agent.templateGridLimit`).

4b. Add form state after the existing grid state (`gridPerLevel`/`gridMode`):

```ts
  const [glLower, setGlLower] = useState("");
  const [glUpper, setGlUpper] = useState("");
  const [glLevels, setGlLevels] = useState("6");
  const [glPerLevel, setGlPerLevel] = useState("");
```

Add the create handler near `onCreateGrid`:

```ts
  async function onCreateGridLimit() {
    const lower = Number(glLower), upper = Number(glUpper), levels = Number(glLevels), perLevel = Number(glPerLevel);
    if (!(lower > 0) || !(upper > lower) || !Number.isInteger(levels) || levels < 2 || !(perLevel > 0)) {
      Alert.alert(t("agent.invalidParams"), t("agent.invalidGrid"));
      return;
    }
    await ctrl.createGridLimit({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel });
    setGlLower(""); setGlUpper(""); setGlPerLevel("");
  }
```

4c. Add the form card after the `template === "grid"` card:

```tsx
      {template === "gridLimit" ? (
        <SurfaceCard theme={theme} rule={false} testID="new-grid-limit" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newGridLimit")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="grid-limit-coin" />
          <Field theme={theme} label={t("agent.gridLower")} value={glLower} onChangeText={setGlLower} keyboard testID="grid-limit-lower" />
          <Field theme={theme} label={t("agent.gridUpper")} value={glUpper} onChangeText={setGlUpper} keyboard testID="grid-limit-upper" />
          <Field theme={theme} label={t("agent.gridLevels")} value={glLevels} onChangeText={setGlLevels} keyboard testID="grid-limit-levels" />
          <Field theme={theme} label={t("agent.gridPerLevel")} value={glPerLevel} onChangeText={setGlPerLevel} keyboard testID="grid-limit-per-level" />
          <Pressable onPress={onCreateGridLimit} accessibilityRole="button" testID="grid-limit-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createGridLimit")}</Text>
          </Pressable>
        </SurfaceCard>
      ) : null}
```

4d. In the `StrategyRow` component's title + progress rendering, add a `gridLimit` branch. Find where it maps `strategy.type === "grid"` to `t("agent.strategyGrid", ...)` and `t("agent.gridProgress", ...)`, and add parallel `gridLimit` branches:

- Title: `strategy.type === "gridLimit" ? t("agent.strategyGridLimit", { coin: (strategy.params as GridLimitParams).coin })`
- Progress: `strategy.type === "gridLimit" ? t("agent.gridLimitProgress", { armed: strategy.armedCount ?? 0, holding: strategy.holdingCount ?? 0, filled: Math.round(strategy.filledTotalUsdc ?? 0) })`

Import `GridLimitParams` from `../services/strategyApi` (extend the existing type import). The Strategy DTO type in `strategyApi.ts` should also carry optional `armedCount?: number; holdingCount?: number;` — add them to the `Strategy` interface there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mobile && npx jest AgentScreen`
Expected: PASS.

- [ ] **Step 6: Guards**

Run: `cd mobile && npx tsc --noEmit && npx jest noHardcodedColors messages`
Expected: PASS — tsc clean; `noHardcodedColors` green; `messages` en/zh parity green.

- [ ] **Step 7: Emoji scan**

Run: `cd mobile && grep -rnP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]" src/screens/AgentScreen.tsx src/i18n/messages.ts || echo "no emoji"`
Expected: `no emoji`.

- [ ] **Step 8: Commit**

```bash
git add mobile/src/screens/AgentScreen.tsx mobile/src/i18n/messages.ts mobile/src/screens/AgentScreen.test.tsx mobile/src/services/strategyApi.ts
git commit --no-verify -m "feat(gridLimit): mobile Limit-grid template + row + i18n

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification

- [ ] Server: `cd server && npx tsc --noEmit && npx jest` — all pass, ≥ 169 + new tests.
- [ ] Mobile: `cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors messages` — all pass, ≥ 785 + new tests.
- [ ] Backend (Go): untouched — no run.
- [ ] Open PR `feat/grid-limit-resting` → `main`; wait for CI green (mobile/server/backend); code-review; merge.

## Notes / Out of Scope

- Long-only only (reduce-only sells, no net short); symmetric resting is a future toggle.
- Fill price is approximated by the rung's limit price (activity + realized pnl); precise `userFills` enrichment is deferred.
- The spec's `desiredRung` pure helper is realized inline in the scheduler reconcile (Task 8) for clarity — the exported pure helpers are the geometry ones (Task 2).
- Partial fills stay resting until fully filled (the diff only fires on a fully-vanished cloid) — safe by construction.
- An exchange-side cancel would be mis-read as a fill, but the resulting reduce-only sell simply can't open a short (HL rejects a reduce-only beyond position), so it's self-limiting.
