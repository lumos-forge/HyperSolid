# M4 — Trailing-Stop Strategy (server)

Date: 2026-07-13
Status: Approved

## Context

The agentic engine (`server/`, TS) supports strategy kinds `dca`, `twap`, `tpsl`,
`grid`, `gridLimit`. The M4 spec lists **移动止损 (trailing stop)** as a core L1 rule,
but it is not implemented. This unit adds a `trailing` strategy: it tracks the
favorable extreme of the mark price for an existing position and closes the position
(reduce-only) once the mark retraces from that extreme by a configured percentage
callback rate. It mirrors the existing `tpsl` pattern (monitor mark → reduce-only
close) plus one persisted state field (the water-mark), like `grid`'s `lastLevel`.

This is server-only; the mobile create UI is a separate follow-up.

## Goal

Add `kind: "trailing"` with params `{ coin, trailPct }`. Each scheduler tick, for a
running trailing strategy with an open position: advance the water-mark toward the
favorable side, and when the mark retraces by `trailPct`% from it, place a reduce-only
market close; on a covered close, complete the strategy. Direction is derived from the
position sign (long tracks the peak, short tracks the trough), exactly like `tpsl`.

## Parameters

```ts
export interface TrailingParams extends StrategyParamsCommon {
  coin: string;
  /** Callback rate: retrace percent from the favorable extreme that triggers the close. 0 < trailPct < 100. */
  trailPct: number;
}
```
`activationPrice` and absolute offsets are intentionally out of scope (YAGNI); a hard
stop is still available via a separate `tpsl` strategy.

## Design

### 1. `server/src/strategies/types.ts`

- `StrategyKind` → add `"trailing"`.
- Add `TrailingParams` (above); add to `StrategyParams` union and the `Strategy`
  union: `| (StrategyBase & { kind: "trailing"; params: TrailingParams })`.
- `StrategyBase` gains `trailPeak?: number;` — the persisted favorable extreme
  (highest mark for a long, lowest for a short).

### 2. `server/src/strategies/trailing.ts` (new — pure logic)

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
The reduce-only close side reuses `closeSide(szi)` from `./tpsl`.

### 3. Stores (`store.ts` Memory + `sqliteStore.ts`)

- `StrategyStore` interface gains `setTrailPeak(id: string, peak: number): void;`.
- **Memory** (`store.ts`): `build()` adds a `trailing` case
  (`return { ...base, kind, params: params as TrailingParams };`);
  `setTrailPeak(id, peak)` sets `s.trailPeak = peak`.
- **Sqlite** (`sqliteStore.ts`):
  - `Row` gains `trail_peak: number | null;`.
  - `toStrategy` adds
    `if (row.kind === "trailing") return { ...base, kind: "trailing", params, trailPeak: row.trail_peak ?? undefined };`.
  - `migrate` adds an idempotent
    `if (!cols.has("trail_peak")) db.exec("ALTER TABLE strategies ADD COLUMN trail_peak REAL");`.
  - `create`'s `scheduled` list includes `"trailing"` (mark-driven, `next_run_at = 0`,
    like `tpsl`). `trail_peak` is left NULL at insert (the existing INSERT omits it, so
    it defaults to NULL) and set later by the scheduler.
  - `setTrailPeak(id, peak)` runs `UPDATE strategies SET trail_peak = ? WHERE id = ?`.
- **Decorator** (`notifyingStrategyStore.ts`): add a pass-through
  `setTrailPeak(id, peak) { this.inner.setTrailPeak(id, peak); }` (it implements the
  full `StrategyStore`). `setTrailPeak` never completes a strategy, so no notify hook.

### 4. `server/src/strategies/validate.ts`

Add a `trailing` branch:
```ts
if (kind === "trailing") {
  const x = p as unknown as TrailingParams;
  if (!positiveNumber(x.trailPct) || x.trailPct >= 100) return { ok: false, error: "trailPct must be between 0 and 100" };
  return { ok: true, params: { coin, trailPct: x.trailPct, ...(deadMan ? { deadMan: true } : {}) } };
}
```

### 5. `server/src/engine/scheduler.ts`

Import `updateTrailPeak, trailingTriggered` from `../strategies/trailing` and
`TrailingParams` from the types import. Add a block after the `tpsl` block, guarded by
`if (marks)`:
```ts
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
```
(`closeSide` and `cloidFor` are already imported/defined in the scheduler.)

## Data flow

```
tick → each running "trailing" with open position
  → resolvePosition/resolveMark
  → peak = updateTrailPeak(szi, mark, prevPeak);  peak changed → store.setTrailPeak
  → trailingTriggered(p, szi, mark, peak)?  → reduce-only close → covered → recordTrigger (completed)
```

Completion via `recordTrigger` also fires the P4.5 `lifecycle` push through the
`NotifyingStrategyStore` decorator — no extra wiring.

## Error handling / compatibility

- No position (`szi` 0/undefined) or an invalid mark → skip that tick (mirrors `tpsl`).
- `killSwitch` on → skip (no new orders).
- The water-mark only moves in the favorable direction; `setTrailPeak` is written only
  when it advances (not every tick).
- Reduce-only closes prevent the position from flipping sign, so the peak/trough
  semantics stay consistent for the position's lifetime.
- Additive `StrategyKind`/params/column — no change to existing strategies; the
  `trail_peak` migration is idempotent.

## Testing

- `trailing.test.ts` — `updateTrailPeak`: long seeds then rises (max), ignores dips;
  short seeds then falls (min), ignores rises. `trailingTriggered`: long triggers at
  `peak*(1-trailPct/100)` boundary and not above; short triggers at
  `peak*(1+trailPct/100)` and not below; flat (`szi===0`) never triggers.
- `validate.test.ts` (or the create route test) — `trailing` accepts
  `{ coin, trailPct: 5 }`; rejects `trailPct` ≤ 0, ≥ 100, non-number, or missing coin.
- `sqliteStore.test.ts` — a `trailing` strategy round-trips; `setTrailPeak` persists and
  is read back via `get`; case-insensitive owner unaffected.
- `store.test.ts` (memory) — `setTrailPeak` updates `trailPeak`.
- `scheduler.test.ts` — long: mark rises (peak advances, no close), then retraces past
  `trailPct` → one reduce-only close + strategy `completed`; short symmetric; a rising
  mark never triggers; no position → no order; `killSwitch` → no order.
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope / deferred

- Mobile create UI for trailing (follow-up unit).
- `activationPrice` and absolute-offset trailing.
- Trailing that (re)opens or flips positions.
