/** A currently-running TWAP, normalized from HL `twapHistory` for display + cancel. */
export interface ActiveTwap {
  twapId: number;
  coin: string;
  side: "buy" | "sell";
  sz: number;          // total base size
  executedSz: number;  // base size filled so far
  executedNtl: number; // USDC notional filled so far
  minutes: number;     // configured duration
  reduceOnly: boolean;
  startedAt: number;   // ms epoch (state.timestamp)
}

/** Minimal injectable Info surface for TWAP history (address-scoped). */
export interface TwapInfoLike {
  twapHistory(address: string): Promise<unknown>;
}

interface RawTwap {
  status?: { status?: string };
  twapId?: unknown;
  state?: {
    coin?: string; side?: string; sz?: string; executedSz?: string;
    executedNtl?: string; minutes?: number; reduceOnly?: boolean; timestamp?: number;
  };
}

/** Keep only `activated` entries with a numeric `twapId` (others can't be cancelled), normalized. */
export function normalizeActiveTwaps(history: unknown): ActiveTwap[] {
  if (!Array.isArray(history)) return [];
  const out: ActiveTwap[] = [];
  for (const raw of history as RawTwap[]) {
    if (raw?.status?.status !== "activated") continue;
    if (typeof raw.twapId !== "number") continue;
    const s = raw.state ?? {};
    out.push({
      twapId: raw.twapId,
      coin: s.coin ?? "",
      side: s.side === "A" ? "sell" : "buy",
      sz: Number(s.sz ?? 0),
      executedSz: Number(s.executedSz ?? 0),
      executedNtl: Number(s.executedNtl ?? 0),
      minutes: Number(s.minutes ?? 0),
      reduceOnly: Boolean(s.reduceOnly),
      startedAt: Number(s.timestamp ?? 0),
    });
  }
  return out;
}

/** Fill progress as a percent in [0,100]. */
export function twapProgressPct(t: ActiveTwap): number {
  if (!(t.sz > 0)) return 0;
  return Math.max(0, Math.min(100, (t.executedSz / t.sz) * 100));
}
