import { createHash } from "crypto";
import type { StrategyStore } from "../strategies/store";
import { dueDca, dcaNextRunAt } from "../strategies/dca";
import { dueTwap, twapSliceUsdc, twapIntervalMs } from "../strategies/twap";
import { withinCaps, type RiskLimits } from "../risk/guards";
import { tpslTriggered, closeSide } from "../strategies/tpsl";
import type { DcaParams, TwapParams, TpslParams } from "../strategies/types";

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

/** Optional resolvers enabling the TP/SL trigger path (Phase 2). */
export interface TpslDeps {
  resolveMark(coin: string): Promise<number>;
  /** Signed position size (szi): >0 long, <0 short, undefined/0 = flat. */
  resolvePosition(owner: string, coin: string): Promise<number | undefined>;
}

export async function tick(
  store: StrategyStore,
  placer: OrderPlacer,
  limits: RiskLimits,
  killSwitch: boolean,
  now: number,
  activity?: ActivityRecorder,
  tpsl?: TpslDeps,
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
  if (tpsl) {
    for (const s of all) {
      if (s.kind !== "tpsl" || s.status !== "running") continue;
      if (killSwitch) continue;
      const p = s.params as TpslParams;
      const szi = await tpsl.resolvePosition(s.owner, p.coin);
      if (szi === undefined || szi === 0) continue;
      const mark = await tpsl.resolveMark(p.coin);
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
}
