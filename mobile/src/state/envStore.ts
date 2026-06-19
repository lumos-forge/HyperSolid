import { create } from "zustand";

export type Network = "mainnet" | "testnet";

interface EnvState {
  network: Network;
  setNetwork: (n: Network) => void;
  toggleNetwork: () => void;
}

export const useEnvStore = create<EnvState>((set) => ({
  network: "mainnet",
  setNetwork: (network) => set({ network }),
  toggleNetwork: () =>
    set((s) => ({ network: s.network === "mainnet" ? "testnet" : "mainnet" })),
}));
