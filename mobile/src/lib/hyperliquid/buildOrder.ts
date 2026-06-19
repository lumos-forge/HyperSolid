import type { AssetIndex } from "./assetId";
import { formatPrice, roundSize, validateOrder, type OrderRejection } from "./order";
import { generateCloid } from "./cloid";

export type OrderSide = "buy" | "sell";
export type TimeInForce = "Gtc" | "Ioc" | "Alo";

export interface OrderRequest {
  coin: string;
  side: OrderSide;
  size: number;
  /** Limit price. For market orders pass an aggressive price (slippage-bounded) computed upstream. */
  price: number;
  reduceOnly?: boolean;
  tif?: TimeInForce;
  /** Optional builder code fee attachment. */
  builder?: { address: `0x${string}`; feeTenthBps: number };
}

/** Shape accepted by @nktkas/hyperliquid ExchangeClient.order(). */
export interface HlOrderParams {
  orders: {
    a: number; // asset id
    b: boolean; // isBuy
    p: string; // price
    s: string; // size
    r: boolean; // reduceOnly
    t: { limit: { tif: TimeInForce } };
    c: `0x${string}`; // cloid
  }[];
  grouping: "na";
  builder?: { b: `0x${string}`; f: number };
}

export type BuildResult =
  | { ok: true; params: HlOrderParams; cloid: `0x${string}` }
  | { ok: false; rejection: OrderRejection | "unknownAsset" };

/**
 * Build validated HL order params from a high-level request.
 * Enforces the "三件套": asset-id resolution (never hardcoded), tick/lot precision,
 * and $10 min notional — before anything is signed.
 */
export function buildOrder(req: OrderRequest, index: AssetIndex): BuildResult {
  const asset = index.id(req.coin);
  const szDecimals = index.szDecimals(req.coin);
  if (asset === null || szDecimals === null) return { ok: false, rejection: "unknownAsset" };

  const rejection = validateOrder({ price: req.price, size: req.size, szDecimals });
  if (rejection) return { ok: false, rejection };

  const cloid = generateCloid();
  const params: HlOrderParams = {
    orders: [
      {
        a: asset,
        b: req.side === "buy",
        p: formatPrice(req.price, szDecimals),
        s: String(roundSize(req.size, szDecimals)),
        r: req.reduceOnly ?? false,
        t: { limit: { tif: req.tif ?? "Gtc" } },
        c: cloid,
      },
    ],
    grouping: "na",
  };
  if (req.builder) {
    params.builder = { b: req.builder.address, f: req.builder.feeTenthBps };
  }
  return { ok: true, params, cloid };
}
