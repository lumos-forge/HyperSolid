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
