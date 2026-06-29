/**
 * Pure helpers for the order-ticket form (signing-independent). Maps the Hyperliquid order-type
 * menu (Market / Limit / Stop Limit / Stop Market / Take-Profit Limit / Take-Profit Market) to the
 * encoder's trigger/limit shape, plus quote↔base sizing, required margin and venue fee rates.
 */

export type TicketOrderType =
  | "market"
  | "limit"
  | "stopLimit"
  | "stopMarket"
  | "tpLimit"
  | "tpMarket"
  | "twap"
  | "scale";

export interface OrderTypeShape {
  /** A trigger (stop / take-profit) order rather than a plain market or limit order. */
  isTrigger: boolean;
  /** When triggered, fills at market (true) or rests as a limit at the order price (false). */
  triggerIsMarket: boolean;
  /** Whether the user supplies a limit price (market & *-Market types don't). */
  usesLimitPrice: boolean;
  /** Trigger direction (ignored for market/limit). */
  tpsl: "tp" | "sl";
}

export function orderTypeShape(type: TicketOrderType): OrderTypeShape {
  switch (type) {
    case "market":
      return { isTrigger: false, triggerIsMarket: false, usesLimitPrice: false, tpsl: "sl" };
    case "limit":
      return { isTrigger: false, triggerIsMarket: false, usesLimitPrice: true, tpsl: "sl" };
    case "stopLimit":
      return { isTrigger: true, triggerIsMarket: false, usesLimitPrice: true, tpsl: "sl" };
    case "stopMarket":
      return { isTrigger: true, triggerIsMarket: true, usesLimitPrice: false, tpsl: "sl" };
    case "tpLimit":
      return { isTrigger: true, triggerIsMarket: false, usesLimitPrice: true, tpsl: "tp" };
    case "tpMarket":
      return { isTrigger: true, triggerIsMarket: true, usesLimitPrice: false, tpsl: "tp" };
    case "twap":
    case "scale":
      // Advanced execution types — handled by their own UI + submit paths, not the limit/trigger flow.
      return { isTrigger: false, triggerIsMarket: false, usesLimitPrice: false, tpsl: "sl" };
  }
}

/**
 * Evenly-spaced limit prices for a Scale (laddered) order, from startPx to endPx inclusive.
 * `count` ≥ 2; a single price returns just that price.
 */
export function buildScaleLevels(startPx: number, endPx: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [startPx];
  const step = (endPx - startPx) / (n - 1);
  return Array.from({ length: n }, (_, i) => startPx + step * i);
}

/** TWAP duration bounds (minutes) enforced by Hyperliquid. */
export const TWAP_MIN_MINUTES = 5;
export const TWAP_MAX_MINUTES = 1440;

/** HL base-tier perp fees (taker / maker) as fractions of notional. */
export const TAKER_FEE_RATE = 0.00045;
export const MAKER_FEE_RATE = 0.00015;

/** Default slippage cap for a market order's IOC limit price (5%). */
export const MARKET_SLIPPAGE_PCT = 0.05;

/**
 * Worst-case bound for a "market" order: it is sent as an IOC limit at mid ± pct, so it fills at the
 * best available price while capping slippage. Buy bounds above mid, sell below — no typed price.
 */
export function marketSlippagePrice(mid: number, side: "buy" | "sell", pct = MARKET_SLIPPAGE_PCT): number {
  return side === "buy" ? mid * (1 + pct) : mid * (1 - pct);
}

export type SizeUnit = "base" | "quote";

/**
 * Sanitize a typed size string: keep digits + a single dot and cap fractional digits to `maxDecimals`
 * (base = the coin's szDecimals, quote/USDC = 2). Empty/partial input ("", ".") passes through so the
 * user can keep typing; never produces NaN. Does not strip a trailing dot.
 */
export function clampSizeInput(text: string, maxDecimals: number): string {
  let cleaned = text.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  }
  if (maxDecimals <= 0) return cleaned.split(".")[0];
  const dot = cleaned.indexOf(".");
  if (dot === -1) return cleaned;
  return cleaned.slice(0, dot + 1 + maxDecimals);
}

/** Convert a size typed in base (coin) or quote (USDC) units to a base-coin size. */
export function toBaseSize(unit: SizeUnit, value: number, price: number): number {
  if (!(value > 0)) return 0;
  if (unit === "quote") return price > 0 ? value / price : 0;
  return value;
}

/** Initial margin required to open a position: notional / leverage. */
export function requiredMargin(notional: number, leverage: number): number {
  return leverage > 0 ? notional / leverage : 0;
}
