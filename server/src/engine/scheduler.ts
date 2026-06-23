import { createHash } from "crypto";
import type { StrategyStore } from "../strategies/store";
import { dueStrategies, nextRunAt } from "../strategies/dca";
import { withinCaps, type RiskLimits } from "../risk/guards";

export interface PlaceRequest {
  owner: string;
  coin: string;
  sizeUsdc: number;
  cloid: string;
}

export interface OrderPlacer {
  place(req: PlaceRequest): Promise<{ ok: boolean; filledUsdc?: number }>;
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

/**
 * One scheduler pass: place a DCA child order for each due strategy (slot-deterministic cloid),
 * gated by risk caps + the kill-switch, and advance only on a successful placement. Idempotent: the
 * cloid is keyed by the strategy's *scheduled* nextRunAt, and the strategy is advanced only after a
 * confirmed fill — a re-run before advancement reuses the same cloid.
 */
export async function tick(
  store: StrategyStore,
  placer: OrderPlacer,
  limits: RiskLimits,
  killSwitch: boolean,
  now: number,
): Promise<void> {
  for (const s of dueStrategies(store.listAll(), now)) {
    const notionalUsdc = s.params.quoteAmountUsdc;
    if (!withinCaps({ notionalUsdc, killSwitch }, limits).ok) continue;
    const cloid = cloidFor(s.id, s.nextRunAt);
    const res = await placer.place({ owner: s.owner, coin: s.params.coin, sizeUsdc: notionalUsdc, cloid });
    if (res.ok) {
      store.recordFill(s.id, res.filledUsdc ?? notionalUsdc, nextRunAt(s, now));
    }
  }
}
