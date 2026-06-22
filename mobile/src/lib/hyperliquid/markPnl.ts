import type { PortfolioSnapshot, Position } from "./types";

/**
 * Unrealized PnL from MARK price (spec §4.5 — never last trade):
 * long = (mark - entry) * size; short = (entry - mark) * size. `size` is absolute.
 */
export function unrealizedPnlFromMark(p: Position, markPx: number): number {
  const dir = p.side === "long" ? 1 : -1;
  return dir * (markPx - p.entryPx) * p.size;
}

/** Distance from mark to liquidation price as a % of mark. null if no liq price / non-positive mark. */
export function distanceToLiqPct(markPx: number, liquidationPx: number | null): number | null {
  if (liquidationPx === null || !(markPx > 0)) return null;
  return (Math.abs(markPx - liquidationPx) / markPx) * 100;
}

/** Return on equity = unrealized PnL / margin used (%). 0 when no margin. */
export function roePct(unrealizedPnl: number, marginUsed: number): number {
  if (!(marginUsed > 0)) return 0;
  return (unrealizedPnl / marginUsed) * 100;
}

/** Account margin ratio = total margin used / account value (%). null when no account value. */
export function marginRatioPct(accountValue: number, totalMarginUsed: number): number | null {
  if (!(accountValue > 0)) return null;
  return (totalMarginUsed / accountValue) * 100;
}

function markOf(marks: Record<string, string | number>, coin: string): number | null {
  const raw = marks[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Re-price a portfolio against live MARK prices (allMids/markPx). Recomputes each position's
 * unrealizedPnl + positionValue from mark (never last trade) and the account's totalUnrealizedPnl
 * + totalNtlPos. Positions without a (valid, positive) mark keep their snapshot values.
 */
export function applyMarks(
  snapshot: PortfolioSnapshot,
  marks: Record<string, string | number>,
): PortfolioSnapshot {
  const positions: Position[] = snapshot.positions.map((p) => {
    const mark = markOf(marks, p.coin);
    if (mark === null) return p;
    return {
      ...p,
      unrealizedPnl: unrealizedPnlFromMark(p, mark),
      positionValue: mark * p.size,
    };
  });
  const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalNtlPos = positions.reduce((s, p) => s + p.positionValue, 0);
  return {
    summary: { ...snapshot.summary, totalUnrealizedPnl, totalNtlPos },
    positions,
  };
}
