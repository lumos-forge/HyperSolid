import type { OrderPlacer, PlaceRequest, PlaceResult } from "../engine/scheduler";
import { roundSize, formatPrice } from "../hl/format";

/** Narrow injectable surface of the HL ExchangeClient — lets us place orders without the network. */
export interface ExchangeLike {
  order(params: unknown): Promise<unknown>;
}

export interface PlacerDeps {
  /** The agent-signed HL client for an owner, or undefined if no usable agent. */
  clientFor(owner: string): ExchangeLike | undefined;
  /** Asset index + size decimals for a coin (from HL meta). */
  resolveAsset(coin: string): Promise<{ assetIndex: number; szDecimals: number }>;
  /** A reference price (mid/mark) used to size the buy and bound the aggressive limit. */
  resolvePrice(coin: string): Promise<number>;
  /** Aggressive-limit slippage in basis points (e.g. 50 = 0.5%). */
  slippageBps: number;
}

interface OrderStatus {
  filled?: { totalSz: string; avgPx: string };
  resting?: unknown;
  error?: string;
}

/** Extract filled notional + size/price from an HL order response, or undefined if not (yet) filled. */
function fillOf(res: unknown): { filledUsdc: number; filledSz: number; avgPx: number } | undefined {
  const statuses = (res as { response?: { data?: { statuses?: OrderStatus[] } } })?.response?.data?.statuses;
  const f = statuses?.[0]?.filled;
  if (!f) return undefined;
  const sz = Number(f.totalSz);
  const px = Number(f.avgPx);
  if (!Number.isFinite(sz) || !Number.isFinite(px)) return undefined;
  return { filledUsdc: sz * px, filledSz: sz, avgPx: px };
}

/**
 * Build the scheduler's OrderPlacer on top of an agent-signed HL client. Each placement is an
 * aggressive IoC buy (slippage-bounded) of `sizeUsdc` notional, carrying the scheduler's deterministic
 * cloid so a re-run dedupes at the HL kernel. Fails closed: no client, no price, an error status, or a
 * thrown error all return `{ ok:false }` so the scheduler does NOT advance and retries next tick.
 */
export function makeHlPlacer(deps: PlacerDeps): OrderPlacer {
  return {
    async place(req: PlaceRequest): Promise<PlaceResult> {
      const client = deps.clientFor(req.owner);
      if (!client) return { ok: false };
      try {
        const price = await deps.resolvePrice(req.coin);
        if (!Number.isFinite(price) || price <= 0) return { ok: false };
        const { assetIndex, szDecimals } = await deps.resolveAsset(req.coin);
        const size = roundSize(req.sizeUsdc / price, szDecimals);
        if (size <= 0) return { ok: false };
        const limitPx = price * (1 + deps.slippageBps / 10_000);
        const order = {
          a: assetIndex,
          b: true,
          p: formatPrice(limitPx, szDecimals),
          s: roundSize(size, szDecimals).toString(),
          r: false,
          t: { limit: { tif: "Ioc" as const } },
          c: req.cloid,
        };
        const res = await client.order({ orders: [order], grouping: "na" });
        const fill = fillOf(res);
        if (fill === undefined) return { ok: false };
        return { ok: true, ...fill };
      } catch {
        return { ok: false };
      }
    },
  };
}
