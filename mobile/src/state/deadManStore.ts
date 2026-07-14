import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

export const DEADMAN_TTL_OPTIONS = [1, 2, 5] as const;
export type DeadManTtl = (typeof DEADMAN_TTL_OPTIONS)[number];
const DEFAULT_TTL: DeadManTtl = 2;
const ENABLED_KEY = "hypersolid.pref.deadman.enabled";
const TTL_KEY = "hypersolid.pref.deadman.ttlMinutes";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

interface DeadManState {
  enabled: boolean;
  ttlMinutes: DeadManTtl;
  setEnabled: (v: boolean) => void;
  setTtlMinutes: (m: DeadManTtl) => void;
  hydrate: () => Promise<void>;
}

/**
 * Manual-trader dead-man preference (opt-in, default OFF). When enabled, the app keeps an HL
 * scheduleCancel armed while foregrounded so all resting orders auto-cancel `ttlMinutes` after the app
 * closes. Device-bound persistence, hydrated once at launch (mirrors routingStore).
 */
export const useDeadManStore = create<DeadManState>((set) => ({
  enabled: false,
  ttlMinutes: DEFAULT_TTL,
  setEnabled: (enabled) => {
    set({ enabled });
    void SecureStore.setItemAsync(ENABLED_KEY, enabled ? "1" : "0", opts).catch(() => {});
  },
  setTtlMinutes: (ttlMinutes) => {
    set({ ttlMinutes });
    void SecureStore.setItemAsync(TTL_KEY, String(ttlMinutes), opts).catch(() => {});
  },
  hydrate: async () => {
    try {
      const e = await SecureStore.getItemAsync(ENABLED_KEY);
      const t = await SecureStore.getItemAsync(TTL_KEY);
      const ttl = t ? Number(t) : DEFAULT_TTL;
      set({
        enabled: e === "1",
        ttlMinutes: (DEADMAN_TTL_OPTIONS as readonly number[]).includes(ttl) ? (ttl as DeadManTtl) : DEFAULT_TTL,
      });
    } catch {
      /* best-effort: keep defaults */
    }
  },
}));
