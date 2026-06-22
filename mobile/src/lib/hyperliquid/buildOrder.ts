import type { AssetIndex } from "./assetId";
import { marketKindForAssetId } from "./assetId";
import { formatPrice, roundSize, validateOrder, type OrderRejection } from "./order";
import { isBuilderFeeWithinCap } from "./builderFee";
import { generateCloid } from "./cloid";

export type OrderSide = "buy" | "sell";
export type TimeInForce = "Gtc" | "Ioc" | "Alo";
export type Grouping = "na" | "normalTpsl" | "positionTpsl";
export type Tpsl = "tp" | "sl";

/** Trigger (stop-loss / take-profit) parameters (spec §4.3). */
export interface TriggerSpec {
  triggerPx: number;
  isMarket: boolean;
  tpsl: Tpsl;
}

export interface OrderRequest {
  coin: string;
  side: OrderSide;
  size: number;
  /** Limit price. For market orders pass an aggressive price (slippage-bounded) computed upstream. */
  price: number;
  reduceOnly?: boolean;
  tif?: TimeInForce;
  /** Market order -> IOC (overrides tif). Ignored when `trigger` is set. */
  market?: boolean;
  /** When set, this is a trigger (stop/TP) order: `t` becomes `{ trigger }` instead of `{ limit }`. */
  trigger?: TriggerSpec;
  /** Reuse an existing cloid (retry idempotency). Generated if absent. */
  cloid?: `0x${string}`;
  /** Optional builder code fee attachment. */
  builder?: { address: `0x${string}`; feeTenthBps: number };
}

/** Order `t` field — limit or trigger (HL union, §4.3). */
export type OrderType =
  | { limit: { tif: TimeInForce } }
  | { trigger: { isMarket: boolean; triggerPx: string; tpsl: Tpsl } };

/** Single order tuple `{a,b,p,s,r,t,c}` accepted by ExchangeClient.order(). */
export interface HlOrderTuple {
  a: number; // asset id
  b: boolean; // isBuy
  p: string; // price
  s: string; // size
  r: boolean; // reduceOnly (required by schema — always present, NOT omitted)
  t: OrderType;
  c: `0x${string}`; // cloid
}

/** Shape accepted by @nktkas/hyperliquid ExchangeClient.order(). */
export interface HlOrderParams {
  orders: HlOrderTuple[];
  grouping: Grouping;
  builder?: { b: `0x${string}`; f: number };
}

export type BuildResult =
  | { ok: true; params: HlOrderParams; cloid: `0x${string}` }
  | { ok: false; rejection: OrderRejection | "unknownAsset" | "builderFeeRejected" };

/** Bracket = entry order + optional TP/SL siblings submitted together with grouping. */
export interface BracketRequest {
  entry: OrderRequest;
  takeProfit?: { triggerPx: number; isMarket?: boolean };
  stopLoss?: { triggerPx: number; isMarket?: boolean };
  /** Defaults to normalTpsl (fixed-size siblings). positionTpsl tracks the position size. */
  grouping?: "normalTpsl" | "positionTpsl";
}

/** Encode a single order tuple. Precedence: trigger > market(Ioc) > tif. */
function orderTuple(
  req: OrderRequest,
  asset: number,
  szDecimals: number,
  cloid: `0x${string}`,
): HlOrderTuple {
  const kind = marketKindForAssetId(asset);
  const t: OrderType = req.trigger
    ? {
        trigger: {
          isMarket: req.trigger.isMarket,
          triggerPx: formatPrice(req.trigger.triggerPx, szDecimals, kind),
          tpsl: req.trigger.tpsl,
        },
      }
    : { limit: { tif: req.market ? "Ioc" : req.tif ?? "Gtc" } };
  return {
    a: asset,
    b: req.side === "buy",
    p: formatPrice(req.price, szDecimals, kind),
    s: String(roundSize(req.size, szDecimals)),
    r: req.reduceOnly ?? false,
    t,
    c: cloid,
  };
}

/** Validate + encode the optional builder fee field (cap by perp/spot, spec §7). */
function builderField(
  builder: OrderRequest["builder"],
  asset: number,
): { b: `0x${string}`; f: number } | { rejection: "builderFeeRejected" } | null {
  if (!builder) return null;
  const kind = marketKindForAssetId(asset);
  if (!isBuilderFeeWithinCap(builder.feeTenthBps, kind)) return { rejection: "builderFeeRejected" };
  return { b: builder.address, f: builder.feeTenthBps };
}

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

  const bf = builderField(req.builder, asset);
  if (bf && "rejection" in bf) return { ok: false, rejection: bf.rejection };

  const cloid = req.cloid ?? generateCloid();
  const params: HlOrderParams = {
    orders: [orderTuple(req, asset, szDecimals, cloid)],
    grouping: "na",
  };
  if (bf) params.builder = bf;
  return { ok: true, params, cloid };
}

/**
 * Build an entry order plus optional take-profit / stop-loss siblings as one grouped action.
 * TP/SL legs are reduce-only triggers on the closing side, same size, paired via grouping
 * (normalTpsl by default). Returns the entry's cloid as the primary id.
 */
export function buildBracketOrder(req: BracketRequest, index: AssetIndex): BuildResult {
  const { entry } = req;
  const asset = index.id(entry.coin);
  const szDecimals = index.szDecimals(entry.coin);
  if (asset === null || szDecimals === null) return { ok: false, rejection: "unknownAsset" };

  const entryRejection = validateOrder({ price: entry.price, size: entry.size, szDecimals });
  if (entryRejection) return { ok: false, rejection: entryRejection };

  const entryCloid = entry.cloid ?? generateCloid();
  const orders: HlOrderTuple[] = [orderTuple(entry, asset, szDecimals, entryCloid)];

  const closeSide: OrderSide = entry.side === "buy" ? "sell" : "buy";
  const size = entry.size;

  const legs: { triggerPx: number; isMarket?: boolean; tpsl: Tpsl }[] = [];
  if (req.takeProfit) legs.push({ ...req.takeProfit, tpsl: "tp" });
  if (req.stopLoss) legs.push({ ...req.stopLoss, tpsl: "sl" });

  for (const leg of legs) {
    const legRejection = validateOrder({ price: leg.triggerPx, size, szDecimals });
    if (legRejection) return { ok: false, rejection: legRejection };
    orders.push(
      orderTuple(
        {
          coin: entry.coin,
          side: closeSide,
          size,
          price: leg.triggerPx,
          reduceOnly: true,
          trigger: { triggerPx: leg.triggerPx, isMarket: leg.isMarket ?? true, tpsl: leg.tpsl },
        },
        asset,
        szDecimals,
        generateCloid(),
      ),
    );
  }

  const params: HlOrderParams = { orders, grouping: req.grouping ?? "normalTpsl" };
  const bf = builderField(entry.builder, asset);
  if (bf && "rejection" in bf) return { ok: false, rejection: bf.rejection };
  if (bf) params.builder = bf;
  return { ok: true, params, cloid: entryCloid };
}
