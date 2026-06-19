import { create } from "zustand";

interface WatchlistState {
  coins: string[];
  toggle: (coin: string) => void;
  isFavorite: (coin: string) => boolean;
  clear: () => void;
}

export const useWatchlistStore = create<WatchlistState>((set, get) => ({
  coins: [],
  toggle: (coin) =>
    set((s) => ({
      coins: s.coins.includes(coin) ? s.coins.filter((c) => c !== coin) : [...s.coins, coin],
    })),
  isFavorite: (coin) => get().coins.includes(coin),
  clear: () => set({ coins: [] }),
}));
