import { create } from "zustand";

/** A reduce-only size to pre-fill the Trade ticket with, set when closing/reducing from Positions. */
export interface TradePrefill {
  size: string;
  reduceOnly: boolean;
}

interface TradeState {
  /** Coin the Trade tab should open, set when navigating from market detail; null = keep current. */
  selectedCoin: string | null;
  /** Order ticket prefill (size + reduce-only), set when closing/reducing a position; null = none. */
  prefill: TradePrefill | null;
  setSelectedCoin: (coin: string) => void;
  clearSelectedCoin: () => void;
  openTrade: (coin: string, prefill?: TradePrefill) => void;
  clearPrefill: () => void;
}

export const useTradeStore = create<TradeState>((set) => ({
  selectedCoin: null,
  prefill: null,
  setSelectedCoin: (coin) => set({ selectedCoin: coin.toUpperCase() }),
  clearSelectedCoin: () => set({ selectedCoin: null }),
  openTrade: (coin, prefill) => set({ selectedCoin: coin.toUpperCase(), prefill: prefill ?? null }),
  clearPrefill: () => set({ prefill: null }),
}));
