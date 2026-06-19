import { create } from "zustand";
import type { MarketTicker, Mids } from "../lib/hyperliquid/types";
import { applyMids } from "../lib/hyperliquid/normalize";

interface MarketState {
  tickers: MarketTicker[];
  loading: boolean;
  error: string | null;
  setMarkets: (tickers: MarketTicker[]) => void;
  mergeMids: (mids: Mids) => void;
  setError: (message: string) => void;
  reset: () => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  tickers: [],
  loading: true,
  error: null,
  setMarkets: (tickers) => set({ tickers, loading: false, error: null }),
  mergeMids: (mids) => set((s) => ({ tickers: applyMids(s.tickers, mids) })),
  setError: (message) => set({ error: message, loading: false }),
  reset: () => set({ tickers: [], loading: true, error: null }),
}));
