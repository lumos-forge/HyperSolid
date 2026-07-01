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
  setMarkets: (tickers) => set({ tickers, loading: false, error: null }),
  mergeMids: (mids) => set((s) => ({ tickers: applyMids(s.tickers, mids) })),
  setError: (error) => set({ error, loading: false }),
  retry: () => set((s) => ({ loading: true, error: null, retryNonce: s.retryNonce + 1 })),
  reset: () => set({ tickers: [], loading: true, error: null }),
}));
