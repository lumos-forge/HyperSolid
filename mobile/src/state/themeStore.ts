import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import { defaultTheme, type ThemeName } from "../theme/tokens";

const KEY = "hypersolid.pref.theme";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const THEMES: ThemeName[] = ["electrum", "daylight", "oscilloscope"];

interface ThemeState {
  name: ThemeName;
  setTheme: (n: ThemeName) => void;
  hydrate: () => Promise<void>;
}

/** Active UI theme, persisted device-bound so the choice survives restarts; hydrated once at launch. */
export const useThemeStore = create<ThemeState>((set) => ({
  name: defaultTheme,
  setTheme: (name) => {
    set({ name });
    void SecureStore.setItemAsync(KEY, name, opts).catch(() => {});
  },
  hydrate: async () => {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      if (v && (THEMES as string[]).includes(v)) set({ name: v as ThemeName });
    } catch {
      /* best-effort: keep the default */
    }
  },
}));
