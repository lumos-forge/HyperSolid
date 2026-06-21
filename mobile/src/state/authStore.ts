import { create } from "zustand";

export type AuthStatus = "unknown" | "noWallet" | "locked" | "unlocked";

interface AuthState {
  status: AuthStatus;
  lastActiveAt: number;
  evaluate: (hasWallet: () => Promise<boolean>) => Promise<void>;
  unlock: () => void;
  lock: () => void;
  touch: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "unknown",
  lastActiveAt: 0,
  evaluate: async (hasWallet) => {
    try {
      set({ status: (await hasWallet()) ? "locked" : "noWallet" });
    } catch {
      set({ status: "locked" });
    }
  },
  unlock: () => set({ status: "unlocked", lastActiveAt: Date.now() }),
  lock: () => set({ status: "locked" }),
  touch: () => set({ lastActiveAt: Date.now() }),
}));
