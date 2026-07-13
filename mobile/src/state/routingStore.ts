import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

export type RoutingMode = "auto" | "direct" | "proxy";
export const ROUTING_MODES: RoutingMode[] = ["auto", "direct", "proxy"];

const KEY = "hypersolid.pref.routing";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

interface RoutingState {
  mode: RoutingMode;
  setMode: (m: RoutingMode) => void;
  hydrate: () => Promise<void>;
}

function persist(mode: RoutingMode) {
  void SecureStore.setItemAsync(KEY, mode, opts).catch(() => {});
}

/**
 * Network routing preference for M8 (China smart routing). Auto lets the app decide (later
 * units), Direct forces direct-to-HL, Proxy forces the Cloudflare Workers pool. Device-bound
 * persistence, hydrated once at launch (mirrors localeStore).
 */
export const useRoutingStore = create<RoutingState>((set) => ({
  mode: "auto",
  setMode: (mode) => {
    set({ mode });
    persist(mode);
  },
  hydrate: async () => {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      if (v && (ROUTING_MODES as string[]).includes(v)) set({ mode: v as RoutingMode });
    } catch {
      /* best-effort: keep the default */
    }
  },
}));
