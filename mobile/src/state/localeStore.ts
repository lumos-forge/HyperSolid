import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import type { Locale } from "../i18n/messages";

const KEY = "hypersolid.pref.locale";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const LOCALES: Locale[] = ["en", "zh"];

interface LocaleState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  toggleLocale: () => void;
  hydrate: () => Promise<void>;
}

function persist(locale: Locale) {
  void SecureStore.setItemAsync(KEY, locale, opts).catch(() => {});
}

/**
 * Active UI language. Defaults to `en` (the v8 design copy); the choice is persisted device-bound so
 * it survives restarts, hydrated once at launch (mirrors `themeStore`).
 */
export const useLocaleStore = create<LocaleState>((set) => ({
  locale: "en",
  setLocale: (locale) => {
    set({ locale });
    persist(locale);
  },
  toggleLocale: () =>
    set((s) => {
      const locale: Locale = s.locale === "en" ? "zh" : "en";
      persist(locale);
      return { locale };
    }),
  hydrate: async () => {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      if (v && (LOCALES as string[]).includes(v)) set({ locale: v as Locale });
    } catch {
      /* best-effort: keep the default */
    }
  },
}));
