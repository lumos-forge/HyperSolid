import { roundSize, formatPrice } from "../hl/format";

/** Agent-signed client surface used by the resting executor. */
export interface RestingClientLike {
  order(params: unknown): Promise<unknown>;
  cancelByCloid(params: unknown): Promise<unknown>;
}

export interface RestingExecutorDeps {
  clientFor(owner: string): RestingClientLike | undefined;
  resolveAsset(coin: string): Promise<{ assetIndex: number; szDecimals: number }>;
  /** Optional fire-and-forget shadow verifier (compares Go signer digest); never affects execution. */
  shadowVerify?: (kind: string, params: unknown) => void;
  /** Max cloids per cancelByCloid request; larger sets are chunked. Default 100. */
  maxCancelBatch?: number;
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
  cancelMany(req: { owner: string; cancels: Array<{ coin: string; cloid: string }> }): Promise<boolean>;
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
        try {
          deps.shadowVerify?.("order", {
            asset: assetIndex,
            isBuy: req.side === "buy",
            px: order.p,
            sz: order.s,
            reduceOnly: order.r,
            tif: "Alo",
            grouping: "na",
            cloid: order.c,
          });
        } catch {
          /* shadow must never affect placement */
        }
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

    async cancelMany(req: { owner: string; cancels: Array<{ coin: string; cloid: string }> }): Promise<boolean> {
      if (req.cancels.length === 0) return true;
      const client = deps.clientFor(req.owner);
      if (!client) return false;
      const maxBatch = deps.maxCancelBatch && deps.maxCancelBatch > 0 ? deps.maxCancelBatch : 100;
      // Resolve each distinct coin once; a coin that fails to resolve is skipped (best-effort — its
      // cancels are re-checked next tick), so one bad coin can't strand the others.
      const assetByCoin = new Map<string, number>();
      for (const coin of new Set(req.cancels.map((c) => c.coin))) {
        try {
          const { assetIndex } = await deps.resolveAsset(coin);
          assetByCoin.set(coin, assetIndex);
        } catch {
          /* unknown coin / cold meta: skip this coin's cancels */
        }
      }
      const all = req.cancels
        .filter((c) => assetByCoin.has(c.coin))
        .map((c) => ({ asset: assetByCoin.get(c.coin) as number, cloid: c.cloid }));
      for (let i = 0; i < all.length; i += maxBatch) {
        const cancels = all.slice(i, i + maxBatch);
        try {
          deps.shadowVerify?.("cancelByCloid", { cancels });
        } catch {
          /* shadow must never affect cancellation */
        }
        try {
          await client.cancelByCloid({ cancels });
        } catch {
          /* already gone / filled — treat as cancelled (idempotent) */
        }
      }
      return true;
    },
  };
}
