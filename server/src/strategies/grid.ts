import type { GridParams } from "./types";

/** Grid-line spacing = (upper - lower) / (levels - 1); 0 for a degenerate single-level grid. */
export function gridStep(p: GridParams): number {
  return p.levels > 1 ? (p.upperPrice - p.lowerPrice) / (p.levels - 1) : 0;
}

/** Nearest grid-line index for `mark`, clamped to [0, levels-1]. Out-of-range marks clamp to an end. */
export function bandIndex(mark: number, lowerPrice: number, step: number, levels: number): number {
  if (!(step > 0)) return 0;
  const raw = Math.round((mark - lowerPrice) / step);
  return Math.max(0, Math.min(levels - 1, raw));
}

export interface GridAction {
  side: "buy" | "sell";
  usdc: number;
  targetLevel: number;
}

/**
 * The action implied by the mark moving from `lastLevel` to `curBand`:
 * down-cross -> buy the crossed distance; up-cross -> sell it (reduce-only at the call site);
 * unchanged -> null.
 */
export function gridAction(lastLevel: number, curBand: number, perLevelUsdc: number): GridAction | null {
  if (curBand < lastLevel) return { side: "buy", usdc: (lastLevel - curBand) * perLevelUsdc, targetLevel: curBand };
  if (curBand > lastLevel) return { side: "sell", usdc: (curBand - lastLevel) * perLevelUsdc, targetLevel: curBand };
  return null;
}

/**
 * Symmetric-grid target net position (USDC notional) at a given band:
 * centerBand = (levels-1)/2; target = (centerBand - band) * perLevelUsdc.
 * Positive = net long (max at the bottom band), negative = net short (max at the top band).
 */
export function targetNetUsdc(band: number, levels: number, perLevelUsdc: number): number {
  const centerBand = (levels - 1) / 2;
  return (centerBand - band) * perLevelUsdc;
}
