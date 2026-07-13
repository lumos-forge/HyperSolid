# M4 — Scheduled (Time-Triggered Entry) Strategy (server)

Date: 2026-07-13
Status: Approved

## Context

The agentic engine supports dca/twap/tpsl/grid/gridLimit/trailing/conditional. The M4
spec's "条件/定时单" line is now complete except the **scheduled** (time-triggered)
one-shot order. This unit adds it: at a configured absolute time `runAt`, open a
position at market (not reduce-only), then complete. It is the time-based sibling of
`conditional` (price-based) — both are one-shot opening entries, distinct from `dca`
(recurring). Mobile create UI is a follow-up.

## Goal

Add `kind: "scheduled"` with params `{ coin, side, sizeUsdc, runAt }`. Each scheduler
tick, for a running scheduled strategy whose `runAt` has passed (`now >= runAt`), place
a market opening order (risk-capped like DCA) and, on a successful fill, complete the
strategy. It is time-gated (no mark needed) and one-shot.

## Parameters

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
`runAt` is an absolute epoch-ms timestamp; a past value simply fires on the next tick
("run now"). No persisted state beyond `status`.

## Design

### 1. `server/src/strategies/types.ts`

- `StrategyKind` → add `"scheduled"`.
- Add `ScheduledParams` (above); add to `StrategyParams` union and the `Strategy` union:
  `| (StrategyBase & { kind: "scheduled"; params: ScheduledParams })`.

### 2. `server/src/strategies/scheduled.ts` (new — pure logic)

```ts
import type { ScheduledParams } from "./types";

/** True when the scheduled trigger time has arrived. */
export function scheduledDue(p: ScheduledParams, now: number): boolean {
  return now >= p.runAt;
}
```

### 3. `server/src/strategies/validate.ts`

Add a `scheduled` branch before the final `unknown strategy kind` return:
```ts
if (kind === "scheduled") {
  const c = p as unknown as ScheduledParams;
  if (c.side !== "buy" && c.side !== "sell") return { ok: false, error: "scheduled side must be buy or sell" };
  if (!positiveNumber(c.sizeUsdc)) return { ok: false, error: "sizeUsdc must be > 0" };
  if (!positiveInteger(c.runAt)) return { ok: false, error: "runAt must be a positive epoch-ms timestamp" };
  return { ok: true, params: { coin, side: c.side, sizeUsdc: c.sizeUsdc, runAt: c.runAt, ...(deadMan ? { deadMan: true } : {}) } };
}
```
(`positiveInteger` already exists in `validate.ts`.)

### 4. Stores

- **Memory** (`store.ts`): `build()` adds a `scheduled` case
  (`return { ...base, kind, params: params as ScheduledParams };`) before the final
  fallback.
- **Sqlite** (`sqliteStore.ts`): `toStrategy` adds a `scheduled` branch
  (`return { ...base, kind: "scheduled", params };`); `create`'s `scheduled` list
  includes `"scheduled"` (`next_run_at = 0` — the scheduler gates on `p.runAt`, not
  `next_run_at`). No new column, no new store method.
- No `NotifyingStrategyStore` change (it passes through `recordTrigger`).

### 5. `server/src/engine/scheduler.ts`

Import `scheduledDue` from `../strategies/scheduled` and `ScheduledParams` from the
types import. Add a block **outside** the `if (marks)` region (time-gated, no mark
needed) — right after the TWAP opening block — mirroring the DCA opening/caps path:
```ts
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
The cloid is keyed on a **restart-stable** slot (`cloidForKey(s.id, "scheduled")`), not
`now`, so a crash between placement and `recordTrigger` reuses the same cloid and the HL
kernel dedupes instead of double-opening (the invariant established for `conditional`).
`withinCaps` blocks on `killSwitch` + per-tx/per-coin caps exactly like DCA;
`dayStartUtcMs`/`withinCaps`/`cloidForKey` are already imported/defined.

## Data flow

```
tick → each running "scheduled"
  → scheduledDue(p, now) (now >= runAt)?
    → withinCaps + daily cap ok? → market open (side, sizeUsdc, reduceOnly:false, stable cloid)
      → res.ok → record activity + recordTrigger (completed → lifecycle push)
```

## Error handling / compatibility

- Not yet due (`now < runAt`) → skip that tick.
- `killSwitch` / over per-tx or per-coin cap / over daily notional → no order (via
  `withinCaps` + the daily-cap check, like DCA/TWAP/conditional).
- Restart-stable cloid → a crash-replay dedupes rather than double-opening.
- One-shot: after a covered fill the strategy is `completed`, so it never re-fires.
- Additive `StrategyKind`/params — no change to existing strategies; no schema change.

## Testing

- `scheduled.test.ts` — `scheduledDue`: false when `now < runAt`, true at/after `runAt`.
- `validate.test.ts` — accepts a full scheduled config; rejects a bad side, `sizeUsdc`
  ≤ 0, a non-integer / ≤ 0 `runAt`, and a missing coin; carries `deadMan`.
- `sqliteStore.test.ts` — a `scheduled` strategy round-trips (kind + params + running).
- `scheduler.test.ts` — due (`now >= runAt`) → one market open (reduceOnly false,
  sizeUsdc, correct side) + `completed`; not-yet-due → no order; `killSwitch` → no order;
  over per-coin cap → no order; over daily cap → no order; a restart-stable cloid is
  reused across ticks (place fails → same cloid next tick).
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope / deferred

- Mobile create UI (follow-up: a "run in N hours" delay input → `runAt = now + N*3600000`,
  avoiding a native date picker).
- Recurring schedules / cron (dca covers interval recurrence).
- Limit (resting) scheduled entries.
