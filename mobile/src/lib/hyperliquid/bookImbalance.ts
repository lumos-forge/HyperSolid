import type { Orderbook } from "./types";

/** Bid/ask share of cumulative size across the top `depth` levels (a liquidity skew, not positioning). */
export function bookImbalance(book: Orderbook, depth = 10): { bidPct: number; askPct: number } {
  const sum = (levels: { sz: number }[]) => levels.slice(0, depth).reduce((a, l) => a + l.sz, 0);
  const bid = sum(book.bids);
  const ask = sum(book.asks);
  const total = bid + ask;
  if (total === 0) return { bidPct: 50, askPct: 50 };
  return { bidPct: (bid / total) * 100, askPct: (ask / total) * 100 };
}
