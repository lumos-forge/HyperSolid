import { create } from "zustand";

interface RoutingEnvState {
  proxyRecommended: boolean;
  detected: boolean;
  setProxyRecommended: (v: boolean) => void;
}

/** Result of startup network-environment detection (M8 unit C); consumed by selectRoute's `auto` mode. */
export const useRoutingEnvStore = create<RoutingEnvState>((set) => ({
  proxyRecommended: false,
  detected: false,
  setProxyRecommended: (proxyRecommended) => set({ proxyRecommended, detected: true }),
}));
