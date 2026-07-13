# M4 — Conditional (Price-Triggered Entry) Strategy (server)

Date: 2026-07-13
Status: Approved

## Context

The agentic engine supports dca/twap/tpsl/grid/gridLimit/trailing. The M4 spec's
"条件/定时单" line lists conditional (price-triggered) and scheduled (time-based) orders;
only the reduce-only conditional *closes* (tpsl, trailing) and the recurring *scheduled*
buy (dca) exist. This unit adds a **conditional entry**: when the mark crosses a trigger
price, open a position at market (not reduce-only), then complete. Scheduled/timed
one-shot orders are a separate deferred follow-up. Mobile create UI is also a follow-up.

## Goal

Add `kind: "conditional"` with params `{ coin, side, sizeUsdc, triggerPrice, triggerDirection }`.
Each scheduler tick, for a running conditional strategy whose mark has crossed
`triggerPrice` in `triggerDirection`, place a market opening order (risk-capped like
DCA) and, on a successful fill, complete the strategy. It is a one-shot entry, distinct
from tpsl/trailing (which reduce-only close an existing position).

## Parameters

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
`triggerDirection` is independent of `side`, so both breakout entries (e.g. buy above)
and dip entries (e.g. buy below) are expressible.

## Design

### 1. `server/src/strategies/types.ts`

- `StrategyKind` → add `"conditional"`.
- Add `ConditionalParams` (above); add to `StrategyParams` union and the `Strategy`
  union: `| (StrategyBase & { kind: "conditional"; params: ConditionalParams })`.
- No new `StrategyBase` state field (conditional carries no persisted state beyond
  `status`).

### 2. `server/src/strategies/conditional.ts` (new — pure logic)

```ts
import type { ConditionalParams } from "./types";

/** True when the mark has crossed the trigger in the configured direction. */
export function conditionalTriggered(p: ConditionalParams, mark: number): boolean {
  return p.triggerDirection === "above" ? mark >= p.triggerPrice : mark <= p.triggerPrice;
}
```

### 3. `server/src/strategies/validate.ts`

Add a `conditional` branch before the final `unknown strategy kind` return:
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

### 4. Stores

- **Memory** (`store.ts`): `build()` adds a `conditional` case
  (`return { ...base, kind, params: params as ConditionalParams };`) before the final
  fallback (needed for the widened union to typecheck).
- **Sqlite** (`sqliteStore.ts`): `toStrategy` adds a `conditional` branch
  (`return { ...base, kind: "conditional", params };`); `create`'s `scheduled` list
  includes `"conditional"` (mark-driven, `next_run_at = 0`). No new column, no new
  store method (no persisted state).
- No `NotifyingStrategyStore` change (it already passes through `recordTrigger`, which
  fires the lifecycle push on completion).

### 5. `server/src/engine/scheduler.ts`

Import `conditionalTriggered` from `../strategies/conditional` and add `ConditionalParams`
to the types import. Add a block in the `if (marks)` region (e.g. after the trailing
block). It opens a position, so it applies the same caps + daily-cap gating as DCA:
```ts
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
`withinCaps` already blocks on `killSwitch` (matching the DCA opening path), so no
separate kill-switch skip is needed. `dayStartUtcMs`/`withinCaps` are already imported.

## Data flow

```
tick → each running "conditional"
  → resolveMark → conditionalTriggered(p, mark)?
    → withinCaps + daily cap ok? → market open (side, sizeUsdc, reduceOnly:false)
      → res.ok → record activity + recordTrigger (completed → lifecycle push)
```

## Error handling / compatibility

- Invalid mark → skip that tick.
- `killSwitch` / over per-tx or per-coin cap / over daily notional → no order (via
  `withinCaps` + the daily-cap check, exactly like DCA/TWAP).
- One-shot: after a covered fill the strategy is `completed`, so it never re-fires.
- Additive `StrategyKind`/params — no change to existing strategies; no schema change.

## Testing

- `conditional.test.ts` — `conditionalTriggered`: above triggers at/above the price and
  not below; below triggers at/below and not above.
- `validate.test.ts` — accepts a full conditional config (both directions); rejects a
  bad side, `sizeUsdc` ≤ 0, `triggerPrice` ≤ 0, a bad `triggerDirection`, and a missing
  coin; carries `deadMan` through.
- `sqliteStore.test.ts` — a `conditional` strategy round-trips (kind + params + running).
- `scheduler.test.ts` — above: mark ≥ trigger → one market buy (reduceOnly false,
  sizeUsdc) + `completed`; below: mark ≤ trigger → market sell/buy per side; not-yet
  crossed → no order; `killSwitch` → no order; over per-coin cap → no order; over daily
  cap → no order.
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope / deferred

- Scheduled/timed one-shot orders (separate follow-up).
- Mobile create UI for conditional (follow-up unit).
- Limit (resting) conditional entries; multi-leg / bracket orders.
