import type { GridLimitParams } from "./types";

/** Per-rung persisted state. A rung holds at most one resting order at a time. */
export interface RungState {
  rung: number;
  state: "idle" | "armed" | "holding";
  side: "buy" | "sell" | null;
  cloid: string | null;
  px: number | null;
  seq: number;
}

/** Grid-line spacing = (upper - lower) / (levels - 1); 0 for a degenerate single-level grid. */
export function gridLimitStep(p: GridLimitParams): number {
  return p.levels > 1 ? (p.upperPrice - p.lowerPrice) / (p.levels - 1) : 0;
}

/** Absolute price of grid line `i` (0-based). */
export function gridLimitLine(p: GridLimitParams, i: number): number {
  return p.lowerPrice + i * gridLimitStep(p);
}

/** Number of rungs = grid lines - 1 (each rung is buy@i / sell@i+1). */
export function rungCount(p: GridLimitParams): number {
  return Math.max(0, p.levels - 1);
}

/** The resting-buy price of rung `i` = line[i]. */
export function rungBuyPrice(p: GridLimitParams, i: number): number {
  return gridLimitLine(p, i);
}

/** The reduce-only take-profit sell price of rung `i` = line[i+1]. */
export function rungSellPrice(p: GridLimitParams, i: number): number {
  return gridLimitLine(p, i + 1);
}

/** Coin size for rung `i` = perLevelUsdc valued at the buy line. */
export function rungSizeCoin(p: GridLimitParams, i: number): number {
  const px = rungBuyPrice(p, i);
  return px > 0 ? p.perLevelUsdc / px : 0;
}

/** A rung can rest a maker BUY only when its buy line is strictly below the mark. */
export function armable(p: GridLimitParams, i: number, mark: number): boolean {
  return rungBuyPrice(p, i) < mark;
}
