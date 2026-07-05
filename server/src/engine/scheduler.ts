import { createHash } from "crypto";
import type { StrategyStore } from "../strategies/store";
import { dueDca, dcaNextRunAt } from "../strategies/dca";
import { dueTwap, twapSliceUsdc, twapIntervalMs } from "../strategies/twap";
import { withinCaps, type RiskLimits } from "../risk/guards";
import { tpslTriggered, closeSide } from "../strategies/tpsl";
import type { DcaParams, TwapParams, TpslParams, GridParams } from "../strategies/types";
import { gridStep, bandIndex, gridAction, targetNetUsdc } from "../strategies/grid";

export interface PlaceRequest {
  owner: string;
  coin: string;
  cloid: string;
  side: "buy" | "sell";
  reduceOnly: boolean;
  sizeUsdc?: number;
  sizeCoin?: number;
}

export interface PlaceResult {
  ok: boolean;
  filledUsdc?: number;
  filledSz?: number;
  avgPx?: number;
}

export interface OrderPlacer {
  place(req: PlaceRequest): Promise<PlaceResult>;
}

/** Sink for recorded fills (activity log). Optional so the core tick stays usable without one. */
export interface ActivityRecorder {
  record(a: { strategyId: string; owner: string; time: number; coin: string; side: string; sz: number; px: number }): unknown;
  /** Owner's total notional spent since a time — used to enforce the daily spend cap. */
  notionalSince?(owner: string, sinceMs: number): number;
}

const DAY_MS = 86_400_000;

/** UTC midnight (ms) for the day containing `now` — the window for the daily spend cap. */
export function dayStartUtcMs(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/**
 * Deterministic cloid for a strategy's scheduled slot: same (strategyId, scheduledNextRunAt) →
 * same cloid, so a re-run of the same tick (crash/restart) reuses it and the HL kernel dedupes
 * instead of double-placing. 16-byte hex (HL cloid width).
 */
export function cloidFor(strategyId: string, scheduledNextRunAt: number): string {
  const h = createHash("sha256").update(`${strategyId}:${scheduledNextRunAt}`).digest("hex");
  return `0x${h.slice(0, 32)}`;
}

/** Like {@link cloidFor} but keyed by an arbitrary string slot (e.g. gridLimit `gl:${rung}:${seq}`). */
export function cloidForKey(strategyId: string, key: string): string {
  const h = createHash("sha256").update(`${strategyId}:${key}`).digest("hex");
  return `0x${h.slice(0, 32)}`;
}

/** Mark/position resolvers shared by the TP/SL trigger path and the Grid path. */
export interface MarkDeps {
  resolveMark(coin: string): Promise<number>;
  /** Signed position size (szi): >0 long, <0 short, undefined/0 = flat. */
  resolvePosition(owner: string, coin: string): Promise<number | undefined>;
}

/** HL perp min order notional; symmetric seed deltas below this are treated as already on-target. */
const MIN_GRID_NOTIONAL = 10;

export async function tick(
  store: StrategyStore,
  placer: OrderPlacer,
  limits: RiskLimits,
  killSwitch: boolean,
  now: number,
  activity?: ActivityRecorder,
  marks?: MarkDeps,
): Promise<void> {
  const all = store.listAll();

  // --- DCA: scheduled buys (unchanged behavior) ---
  for (const s of dueDca(all, now)) {
    const p = s.params as DcaParams;
    const notionalUsdc = p.quoteAmountUsdc;
    if (!withinCaps({ notionalUsdc, killSwitch, coin: p.coin }, limits).ok) continue;
    if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
      const spentToday = activity.notionalSince(s.owner, dayStartUtcMs(now));
      if (spentToday + notionalUsdc > limits.dailyMaxNotionalUsdc) continue;
    }
    const cloid = cloidFor(s.id, s.nextRunAt ?? now);
    const res = await placer.place({ owner: s.owner, coin: p.coin, sizeUsdc: notionalUsdc, cloid, side: "buy", reduceOnly: false });
    if (res.ok) {
      store.recordFill(s.id, res.filledUsdc ?? notionalUsdc, dcaNextRunAt(p, now));
      if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
        activity.record({
          strategyId: s.id,
          owner: s.owner,
          time: now,
          coin: p.coin,
          side: p.side,
          sz: res.filledSz,
          px: res.avgPx,
        });
      }
    }
  }

  for (const s of dueTwap(all, now)) {
    const p = s.params as TwapParams;
    const sliceUsdc = twapSliceUsdc(p);
    if (sliceUsdc <= 0) continue;
    if (!withinCaps({ notionalUsdc: sliceUsdc, killSwitch, coin: p.coin }, limits).ok) continue;
    if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
      const spentToday = activity.notionalSince(s.owner, dayStartUtcMs(now));
      if (spentToday + sliceUsdc > limits.dailyMaxNotionalUsdc) continue;
    }
    const cloid = cloidFor(s.id, s.nextRunAt ?? now);
    const res = await placer.place({ owner: s.owner, coin: p.coin, sizeUsdc: sliceUsdc, cloid, side: p.side, reduceOnly: false });
    if (res.ok) {
      store.recordFill(s.id, res.filledUsdc ?? sliceUsdc, now + twapIntervalMs(p));
      if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
        activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: p.side, sz: res.filledSz, px: res.avgPx });
      }
    }
  }

  // --- TP/SL: reduce-only close on mark crossing configured price ---
  if (marks) {
    for (const s of all) {
      if (s.kind !== "tpsl" || s.status !== "running") continue;
      if (killSwitch) continue;
      const p = s.params as TpslParams;
      const szi = await marks.resolvePosition(s.owner, p.coin);
      if (szi === undefined || szi === 0) continue;
      const mark = await marks.resolveMark(p.coin);
      if (!Number.isFinite(mark) || mark <= 0) continue;
      if (!tpslTriggered(p, szi, mark)) continue;
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
      if (!Number.isFinite(mark) || mark <= 0) continue;
      const step = gridStep(p);
      const curBand = bandIndex(mark, p.lowerPrice, step, p.levels);

      // Symmetric: reconcile the net position to the geometric-center target for the current
      // band. Seed and every crossing size their order from the ACTUAL position, so partial or
      // rounded fills self-correct instead of drifting the net off-center or past the bounds.
      // Net is targeted in USDC notional (szi * mark), so exposure stays bounded as price moves.
      if (mode === "symmetric") {
        if (s.lastLevel === curBand) continue; // already tracking this band
        const target = targetNetUsdc(curBand, p.levels, p.perLevelUsdc);
        const szi = (await marks.resolvePosition(s.owner, p.coin)) ?? 0;
        const deltaUsdc = target - szi * mark;
        const sizeUsdc = Math.abs(deltaUsdc);
        if (sizeUsdc < MIN_GRID_NOTIONAL) {
          store.seedGridLevel(s.id, curBand); // close enough to target; just track the band
          continue;
        }
        const side: "buy" | "sell" = deltaUsdc >= 0 ? "buy" : "sell";
        if (!gridCapsOk(sizeUsdc, s.owner, p.coin)) continue; // retry next tick, do not advance
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

      // longOnly: inventory-bounded long grid.
      if (s.lastLevel === undefined) {
        store.seedGridLevel(s.id, curBand);
        continue;
      }

      const act = gridAction(s.lastLevel, curBand, p.perLevelUsdc);
      if (!act || act.usdc <= 0) continue;

      if (act.side === "buy") {
        if (!gridCapsOk(act.usdc, s.owner, p.coin)) continue;
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
      if (res.ok) {
        const bought = act.side === "buy" ? res.filledUsdc ?? act.usdc : 0;
        store.recordGridAction(s.id, act.targetLevel, bought);
        if (activity && res.filledSz !== undefined && res.avgPx !== undefined) {
          activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: act.side, sz: res.filledSz, px: res.avgPx });
        }
      }
    }
  }
}
