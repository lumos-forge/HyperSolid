import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const KEY = "hypersolid.push.enabled";
const TOKEN_KEY = "hypersolid.push.token";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

interface PushPrefsState {
  /** Whether the user opted into push notifications. */
  enabled: boolean;
  /** Most recently registered Expo push token (used to unregister on disable). */
  token: string | null;
  /** Whether the persisted preference has been read yet. */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setToken: (token: string | null) => Promise<void>;
}

/**
 * Push-notification preference, persisted device-bound in the keychain. Off by default; hydrated
 * once at launch. `token` remembers the last registered Expo push token so a later disable can
 * unregister it server-side.
 */
export const usePushPrefsStore = create<PushPrefsState>((set) => ({
  enabled: false,
  token: null,
  hydrated: false,
  hydrate: async () => {
    try {
      const e = await SecureStore.getItemAsync(KEY);
      const t = await SecureStore.getItemAsync(TOKEN_KEY);
      set({ enabled: e === "1", token: t ?? null, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
  setEnabled: async (enabled) => {
    set({ enabled });
    try {
      await SecureStore.setItemAsync(KEY, enabled ? "1" : "0", opts);
    } catch {
      /* best-effort: state already updated for this session */
    }
  },
  setToken: async (token) => {
    set({ token });
    try {
      if (token == null) await SecureStore.deleteItemAsync(TOKEN_KEY);
      else await SecureStore.setItemAsync(TOKEN_KEY, token, opts);
    } catch {
      /* best-effort */
    }
  },
}));
