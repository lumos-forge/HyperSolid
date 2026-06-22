import type { FundingEvent } from "./types";

/** Per-coin funding aggregate. `usdc` is signed (negative = paid), settled at oracle price (§4.5). */
export interface FundingSummary {
  coin: string;
  net: number; // signed sum; negative = net paid
  paid: number; // sum of |usdc| where usdc < 0 (positive)
  received: number; // sum of usdc where usdc > 0
  count: number;
}

/** Aggregate funding events by coin (net / paid / received / count), sorted by |net| desc. */
export function aggregateFundingByCoin(events: FundingEvent[]): FundingSummary[] {
  const byCoin = new Map<string, FundingSummary>();
  for (const e of events) {
    const s =
      byCoin.get(e.coin) ?? { coin: e.coin, net: 0, paid: 0, received: 0, count: 0 };
    s.net += e.usdc;
    if (e.usdc < 0) s.paid += -e.usdc;
    else s.received += e.usdc;
    s.count += 1;
    byCoin.set(e.coin, s);
  }
  return [...byCoin.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

/** Net funding across all events (signed; negative = net paid). */
export function totalFunding(events: FundingEvent[]): number {
  return events.reduce((sum, e) => sum + e.usdc, 0);
}

/** Net funding for events at/after `sinceMs` (e.g. last 24h window). */
export function fundingSince(events: FundingEvent[], sinceMs: number): number {
  return events.reduce((sum, e) => (e.time >= sinceMs ? sum + e.usdc : sum), 0);
}
