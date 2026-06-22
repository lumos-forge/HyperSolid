/**
 * Hyperliquid order correctness "三件套" — pure, signing-independent rules.
 * Refs: gap analysis B1 (tick/lot), B2 (asset-id), B3 ($10 min), B4 (status codes).
 */

const PERP_MAX_DECIMALS = 6;
const SPOT_MAX_DECIMALS = 8;
const MAX_SIG_FIGS = 5;
const MIN_NOTIONAL_USD = 10;

/** Hyperliquid market kind — perp prices allow ≤6 decimals, spot ≤8 (before szDecimals). */
export type MarketKind = "perp" | "spot";

/** Round a size to the asset's szDecimals (lot size). */
export function roundSize(size: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.round(size * f) / f;
}

/** Strip trailing zeros from a fixed-decimal string (HL requires this before signing). */
export function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Max price decimals allowed: (perp 6 / spot 8) − szDecimals, clamped at 0. */
function maxPriceDecimals(szDecimals: number, kind: MarketKind): number {
  const base = kind === "spot" ? SPOT_MAX_DECIMALS : PERP_MAX_DECIMALS;
  return Math.max(0, base - szDecimals);
}

/**
 * Format a price per HL rules (§4.2):
 * - integer prices are always allowed (e.g. 123456),
 * - otherwise ≤ MAX_SIG_FIGS significant figures AND ≤ (perp 6 / spot 8 − szDecimals) decimals.
 * Returns a trailing-zero-stripped string.
 */
export function formatPrice(price: number, szDecimals: number, kind: MarketKind = "perp"): string {
  if (Number.isInteger(price)) return String(price);
  const maxDecimals = maxPriceDecimals(szDecimals, kind);
  // significant-figure rounding
  const sig = Number(price.toPrecision(MAX_SIG_FIGS));
  const fixed = sig.toFixed(maxDecimals);
  return stripTrailingZeros(fixed);
}

export type OrderRejection =
  | "tickRejected"
  | "minTradeNtlRejected"
  | "sizeRejected"
  | "priceRejected";

export interface OrderInput {
  price: number;
  size: number;
  szDecimals: number;
}

/** Validate an order against tick/lot/min-notional. Returns null if valid, else a rejection code. */
export function validateOrder(o: OrderInput): OrderRejection | null {
  if (!(o.price > 0) || !Number.isFinite(o.price)) return "priceRejected";
  if (!(o.size > 0) || !Number.isFinite(o.size)) return "sizeRejected";
  const rounded = roundSize(o.size, o.szDecimals);
  if (rounded <= 0) return "sizeRejected";
  if (rounded * o.price < MIN_NOTIONAL_USD) return "minTradeNtlRejected";
  return null;
}

/** Human-readable Chinese messages for HL rejection codes (gap analysis B4). */
export const REJECTION_MESSAGES: Record<string, string> = {
  tickRejected: "价格不符合最小变动单位（tick）规则",
  minTradeNtlRejected: "订单名义价值低于最小 $10",
  sizeRejected: "数量无效或低于最小下单量",
  priceRejected: "价格无效",
  perpMarginRejected: "保证金不足",
  reduceOnlyRejected: "仅减仓订单不能增加仓位",
  badAloPxRejected: "ALO（只挂单）价格会立即成交",
  badTriggerPxRejected: "触发价位于错误一侧",
  iocCancelRejected: "IOC 订单未成交被取消",
  oracleRejected: "价格偏离预言机过大",
};

export function rejectionMessage(code: string): string {
  return REJECTION_MESSAGES[code] ?? `订单被拒绝（${code}）`;
}
