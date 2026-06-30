import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

export type Network = "mainnet" | "testnet";

const KEY = "hypersolid.pref.network";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const NETWORKS: Network[] = ["mainnet", "testnet"];

interface EnvState {
  network: Network;
  setNetwork: (n: Network) => void;
  toggleNetwork: () => void;
  hydrate: () => Promise<void>;
}

function persist(network: Network) {
  void SecureStore.setItemAsync(KEY, network, opts).catch(() => {});
}

/**
 * Active venue network. Persisted device-bound and hydrated once at launch so a user who switches to
 * testnet to practice is NOT silently returned to mainnet after a restart (mainnet trades are real
 * money and place on a single tap). Defaults to mainnet only on a truly fresh install.
 */
export const useEnvStore = create<EnvState>((set) => ({
  network: "mainnet",
  setNetwork: (network) => {
    set({ network });
    persist(network);
  },
  toggleNetwork: () =>
    set((s) => {
      const network: Network = s.network === "mainnet" ? "testnet" : "mainnet";
      persist(network);
      return { network };
    }),
  hydrate: async () => {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      if (v && (NETWORKS as string[]).includes(v)) set({ network: v as Network });
    } catch {
      /* best-effort: keep the default */
    }
  },
}));
