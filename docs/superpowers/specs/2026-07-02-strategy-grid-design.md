# Grid Strategy Template (mark-crossing, inventory-bounded long grid)

Date: 2026-07-02
Status: Approved (brainstorming)
Depends on: `2026-06-23-strategy-automation-design.md`, `2026-06-23-strategy-backend-design.md`, `2026-07-01-strategy-templates-twap-tpsl-design.md`

## 1. Goal

Add **Grid** as the 4th strategy `kind` (after `dca`, `twap`, `tpsl`) to the
existing agent-automation engine (`server/`) and expose it as an Agent-tab
template in the mobile app. A grid repeatedly buys as price falls through
configured levels and takes profit (reduce-only sells) as price rises back
through them — capturing profit from a ranging market.

The grid reuses the **existing tick-driven, IoC-order engine**: on each tick it
resolves the mark price and, if the mark has crossed one or more grid lines since
the last tick, places a single aggressive IoC (market-like) order for the crossed
distance. It introduces **no new order-lifecycle / fill-polling infrastructure**.

### Non-goals (YAGNI)
- Resting (GTC) limit orders and fill polling — see Rejected alternative B.
- Net-short / symmetric grids — this grid is **inventory-bounded long-only**
  (buys add to a long; sells are reduce-only; net position is always ≥ 0).
- Geometric / non-uniform spacing — levels are evenly spaced.
- Trailing / auto-recentering range, grid PnL analytics, per-level drill-down.
- Push notifications (the existing activity feed already records each fill).

## 2. Execution model (decided)

**Mark-crossing market grid** (chosen over a true resting-limit grid). The current
engine (`server/src/engine/scheduler.ts`) only places aggressive IoC orders on a
tick; it does **not** track resting orders or poll their fills. A true resting
grid would require a new order-lifecycle subsystem; that is explicitly out of
scope. The mark-crossing model fits the engine exactly, mirroring how TP/SL
already uses `resolveMark(coin)` + a reduce-only close.

**Inventory-bounded long semantics** (chosen over symmetric long/short):
- Mark **crosses down** through `k` grid lines → **buy** `k × perLevelUsdc`
  (`reduceOnly = false`) — adds to the long.
- Mark **crosses up** through `k` grid lines → **sell** `k × perLevelUsdc`
  (`reduceOnly = true`) — reduces the long; HL caps a reduce-only order at the
  current position, so the grid can **never flip net short**.
- No crossing → no action.

The reduce-only flag is the safety net that enforces the net-long invariant, the
same mechanism TP/SL relies on.

## 3. Parameters (`GridParams`)

Denominated in USDC notional, consistent with `DcaParams`/`TwapParams`.

| Field          | Type    | Constraint                                  |
|----------------|---------|---------------------------------------------|
| `coin`         | string  | non-empty                                   |
| `lowerPrice`   | number  | `> 0`                                        |
| `upperPrice`   | number  | `> lowerPrice`                               |
| `levels`       | integer | `>= 2` (number of grid lines; steps = levels − 1) |
| `perLevelUsdc` | number  | `> 0` (notional bought/sold per crossed line) |

Derived (not stored): `step = (upperPrice − lowerPrice) / (levels − 1)`, and grid
lines `L_i = lowerPrice + i·step` for `i ∈ [0, levels − 1]`. Maximum long
inventory is naturally bounded by `perLevelUsdc × (levels − 1)`, so **no separate
`maxTotalUsdc` cap is needed**.

## 4. State

New fields on the grid strategy (persisted). Reuse `filledTotalUsdc` for cumulative
bought notional.

| Field         | Meaning                                                        |
|---------------|----------------------------------------------------------------|
| `lastLevel`   | Grid-line index the mark last occupied (`0..levels−1`). Set at creation from the initial mark; drives crossing detection. |
| `actionsDone` | Monotonic counter of executed grid actions. Drives the cloid so revisiting a level still produces a fresh order while a crashed/re-run tick reuses the same cloid. |

At creation the store cannot know the mark, so `lastLevel` starts **undefined**;
`actionsDone = 0`, `filledTotalUsdc = 0`, `status = "running"`. The **first tick
seeds** `lastLevel` from the current mark via `seedGridLevel` and places **no
order** that tick (see §5.3/§5.4).

## 5. Backend design (`server/`)

### 5.1 `strategies/types.ts`
- `StrategyKind = "dca" | "twap" | "tpsl" | "grid"`.
- `GridParams` interface (§3).
- Add to the `StrategyParams` union and the `Strategy` discriminated union:
  `(StrategyBase & { kind: "grid"; params: GridParams })`.
- Extend `StrategyBase` with optional `lastLevel?: number` and
  `actionsDone?: number` (optional keeps existing fixtures valid, like
  `slicesDone`).

### 5.2 `strategies/grid.ts` (new, pure)
- `bandIndex(mark, lowerPrice, step, levels): number` — nearest grid-line index,
  clamped to `[0, levels − 1]`. Out-of-range marks clamp to the ends (price ≥
  upper → `levels−1`; price ≤ lower → `0`).
- `gridStep(p: GridParams): number` — `(upper − lower)/(levels − 1)`.
- `gridAction(lastLevel, curBand, perLevelUsdc): { side: "buy" | "sell"; usdc: number; targetLevel: number } | null`
  - `curBand < lastLevel` → `{ side: "buy",  usdc: (lastLevel − curBand)·perLevelUsdc, targetLevel: curBand }`
  - `curBand > lastLevel` → `{ side: "sell", usdc: (curBand − lastLevel)·perLevelUsdc, targetLevel: curBand }`
  - equal → `null`.
- `runningGrids(list, now)` helper (running + kind === "grid").

### 5.3 `engine/scheduler.ts`
- Generalize the mark resolver: extract `resolveMark(coin)` into a shared
  dependency used by **both** the TP/SL path and the new grid path (rename
  `TpslDeps` usage or add a shared `MarkDeps { resolveMark }`; keep TP/SL's
  `resolvePosition` where it lives). The grid needs only `resolveMark`.
- Add a grid loop (runs when the shared mark dep is present):
  1. Skip if `killSwitch` (halts the whole grid, consistent with TP/SL).
  2. `mark = await resolveMark(coin)`; skip if not finite / ≤ 0.
  3. **Seed on first tick:** if `s.lastLevel === undefined`, call
     `store.seedGridLevel(s.id, bandIndex(mark, …))` and continue to the next
     strategy — no order this tick.
  4. `curBand = bandIndex(mark, …)`; `act = gridAction(lastLevel, curBand, perLevelUsdc)`; skip if `null`.
  5. **Buy** (`reduceOnly=false`): enforce `withinCaps({ notionalUsdc: act.usdc, killSwitch, coin }, limits)` **and** the daily spend cap (`activity.notionalSince`), exactly like DCA/TWAP; skip the action if either blocks (do not advance `lastLevel`, so it retries next tick).
  6. **Sell** (`reduceOnly=true`): risk-reducing → skip the daily spend cap (like the TP/SL close), but still respect `killSwitch` (already handled in 1).
  7. `cloid = cloidFor(s.id, s.actionsDone ?? 0)`.
  8. `res = await placer.place({ owner, coin, sizeUsdc: act.usdc, cloid, side: act.side, reduceOnly: act.side === "sell" })`.
  9. On `res.ok`: `store.recordGridAction(s.id, act.targetLevel, res.filledUsdc ?? act.usdc)` (updates `lastLevel = targetLevel`, `actionsDone += 1`, adds buys to `filledTotalUsdc`); record an activity row when `filledSz`/`avgPx` are present (same as DCA/TWAP/TPSL).
  10. On failure: leave state unchanged so the same crossing retries next tick with the **same** cloid (HL kernel dedupes if it actually landed).

**cloid rationale:** keying on the monotonic `actionsDone` (not the level index)
means price oscillating back and forth across the same line still yields a new
cloid per action, while a crashed/re-run tick — which has not yet persisted
`actionsDone` — recomputes the identical cloid and dedupes. This preserves the
crash-safety property DCA/TWAP get from a monotonically increasing `nextRunAt`.

### 5.4 `strategies/store.ts` + `strategies/sqliteStore.ts`
- `build(...)` for `kind === "grid"`: `lastLevel` undefined (the initial band needs
  the mark, which the store does not have), `actionsDone = 0`,
  `filledTotalUsdc = 0`, `status = "running"`. The scheduler seeds `lastLevel` on
  the first tick (§5.3 step: when `lastLevel === undefined`, call
  `seedGridLevel(id, bandIndex(mark))` and place no order this tick).
- New store method `recordGridAction(id, newLevel, boughtUsdc)`:
  `lastLevel = newLevel`; `actionsDone += 1`; `filledTotalUsdc += boughtUsdc`
  (pass `0` for sells so the counter tracks bought-only notional).
- New store method `seedGridLevel(id, level)`: set `lastLevel = level` only (no
  counter bump, no order).
- Add both methods to the `StrategyStore` interface; implement in
  `MemoryStrategyStore` and the sqlite store; persist `lastLevel` + `actionsDone`
  columns/serialization.

### 5.5 `strategies/validate.ts`
Add a `kind === "grid"` branch:
- `coin` non-empty (shared guard already runs first).
- `lowerPrice > 0`, `upperPrice > lowerPrice`.
- `levels` a positive integer `>= 2`.
- `perLevelUsdc > 0`.
- Return the normalized `GridParams`.

### 5.6 `http/app.ts`
No contract change — `POST /strategies` already dispatches on `kind` via
`validateParams`; `PATCH`/`DELETE`/`GET` are kind-agnostic. Grid strategies flow
through the same endpoints.

## 6. Frontend design (`mobile/`)

### 6.1 `services/strategyApi.ts`
- `StrategyType = "dca" | "twap" | "tpsl" | "grid"`.
- `GridParams { coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number }`.
- Add to the `StrategyParams` union. `createStrategy` is already generic.

### 6.2 `hooks/useStrategyController.ts`
- `createGrid(params: GridParams)` mirroring `createTwap`/`createTpsl` (calls
  `api.createStrategy("grid", params)` then refreshes).

### 6.3 `screens/AgentScreen.tsx`
- `Template` type gains `"grid"`; template picker renders a 4th segment
  (`agent.templateGrid`).
- A `new-grid` `SurfaceCard` form: fields `grid-coin`, `grid-lower`,
  `grid-upper`, `grid-levels`, `grid-per-level` + a `strategy-preview-grid`
  block (e.g. "N levels, step ≈ X, max long ≈ Y USDC") + a `grid-create` CTA.
  Client-side validation mirrors the server (`lower>0`, `upper>lower`,
  `levels>=2` integer, `perLevelUsdc>0`) with `agent.invalidParams`.
- Strategy-row rendering: label `agent.strategyGrid` (with coin); progress line
  `agent.gridProgress` (e.g. bought USDC + current level / levels).
- Colors from theme tokens only; no hardcoded hex; no emoji; all strings via
  `useT()`.

### 6.4 `i18n/messages.ts` (en + zh, parity enforced)
New keys (illustrative): `agent.templateGrid`, `agent.gridLower`,
`agent.gridUpper`, `agent.gridLevels`, `agent.gridPerLevel`, `agent.strategyGrid`,
`agent.gridProgress`, plus any preview/validation strings. Reuse existing
`agent.coin`, `agent.buy`, `agent.sell`, `agent.invalidParams`.

## 7. Edge cases

- **Creation mark inside/outside range:** initial `lastLevel` is the clamped band;
  outside-range creation clamps to an end and simply waits for a crossing.
- **Gap across many levels in one tick:** aggregated into a single IoC order sized
  to the full crossed distance; `targetLevel` jumps directly to `curBand`.
- **Oscillation across one line:** each crossing is a distinct action (fresh cloid
  via `actionsDone`), so repeated buy-low/sell-high both execute.
- **Reduce-only sell larger than position:** HL caps it at the position size; the
  grid never flips short. `res.filledUsdc` reflects the actual reduced amount.
- **Out of range:** at/above upper the grid holds no new buys and has sold down;
  at/below lower it stops buying (max inventory). It resumes on re-entry.
- **Kill switch:** halts the entire grid loop (no buys or sells) like TP/SL.
- **Crash between place and persist:** re-run recomputes the same cloid
  (`actionsDone` unchanged) → HL dedupes.

## 8. Testing (TDD)

**Server**
- `grid.ts` pure: `bandIndex` interior/edge/clamp; `gridStep`; `gridAction`
  down→buy, up→sell, multi-line aggregation, equal→null.
- `scheduler` grid path: seeds `lastLevel` on first tick without ordering;
  down-cross places a non-reduce buy sized to crossed distance; up-cross places a
  reduce-only sell; `killSwitch` halts; `withinCaps`/daily-cap blocks a buy but
  not a reduce sell; cloid uses `actionsDone` and dedupes on re-run; records an
  activity row on fill.
- `store` / `sqliteStore`: grid `build` defaults; `seedGridLevel`;
  `recordGridAction` updates `lastLevel`/`actionsDone`/`filledTotalUsdc`;
  round-trips the new fields.
- `validate`: accepts a valid grid; rejects `upper<=lower`, `levels<2`,
  non-integer `levels`, `perLevelUsdc<=0`, empty `coin`.
- `http/app`: `POST /strategies` with `kind:"grid"` creates and returns it;
  invalid params → 400.

**Mobile**
- `strategyApi`: `createStrategy("grid", …)` POSTs `{type:"grid",params}`.
- `useStrategyController`: `createGrid` calls the api and refreshes.
- `AgentScreen`: renders the grid template form (asserts field testIDs), creates
  on valid input, blocks on invalid; renders a grid strategy row.

**Gates (must stay green):**
- Server: `cd server && npx tsc --noEmit && npx jest` (≥ current baseline).
- Mobile: `cd mobile && npx tsc --noEmit && npx jest` (≥ current baseline)
  `&& npx jest noHardcodedColors && npx jest messages`; emoji scan → none.

## 9. Rejected alternatives

- **A · True resting-limit grid (GTC + fill polling):** best fills (maker, captures
  spread) but requires a new order-lifecycle/fill-detection subsystem the engine
  lacks. Deferred as a separate, larger project.
- **B · Symmetric long/short grid:** closer to a classic grid bot but introduces
  net-short exposure + funding risk and higher complexity. Rejected for a
  production-safe first version; the reduce-only long grid is the safe baseline.
- **C · Center ± percent range input:** absolute `lowerPrice`/`upperPrice` is the
  standard, clearer grid-bot input; kept.
