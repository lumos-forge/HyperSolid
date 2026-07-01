import { create } from "zustand";
import type { MarketTicker, Mids } from "../lib/hyperliquid/types";
import { applyMids } from "../lib/hyperliquid/normalize";
import type { FetchErrorCode } from "../lib/errorMessage";

interface MarketState {
  tickers: MarketTicker[];
  loading: boolean;
  /** Stable, user-safe error code (never a raw SDK string); null when healthy. */
  error: FetchErrorCode | null;
  /** Bumped by {@link retry} so `useLiveMarkets` re-runs its load/subscribe effect. */
  retryNonce: number;
  /** Epoch ms of the last live update (snapshot or mids merge); 0 until first data. */
  lastTickAt: number;
  setMarkets: (tickers: MarketTicker[]) => void;
  mergeMids: (mids: Mids) => void;
  setError: (code: FetchErrorCode) => void;
  retry: () => void;
  reset: () => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  tickers: [],
  loading: true,
  error: null,
  retryNonce: 0,
  lastTickAt: 0,
  setMarkets: (tickers) => set({ tickers, loading: false, error: null, lastTickAt: Date.now() }),
  mergeMids: (mids) => set((s) => ({ tickers: applyMids(s.tickers, mids), lastTickAt: Date.now() })),
  setError: (error) => set({ error, loading: false }),
  retry: () => set((s) => ({ loading: true, error: null, retryNonce: s.retryNonce + 1 })),
  reset: () => set({ tickers: [], loading: true, error: null, lastTickAt: 0 }),
}));

/** Live mids stream is considered stale (likely a dropped socket) if no update arrived recently. */
export const STALE_MARKET_MS = 20_000;
export function isMarketStale(lastTickAt: number, now: number, thresholdMs: number = STALE_MARKET_MS): boolean {
  if (!lastTickAt) return false; // no data yet — that's "loading", not "stale"
  return now - lastTickAt > thresholdMs;
}
