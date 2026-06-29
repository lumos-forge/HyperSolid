import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const KEY = "hypersolid.lock.biometricEnabled";
const TIMEOUT_KEY = "hypersolid.lock.autoLockMinutes";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

/** Auto-lock timeout options in minutes; 0 = lock immediately when backgrounded. */
export const AUTO_LOCK_OPTIONS = [0, 1, 5, 15] as const;
const DEFAULT_AUTO_LOCK = 5;

interface LockPrefsState {
  /** Whether the user opted into biometric unlock as a convenience over the PIN. */
  biometricEnabled: boolean;
  /** Minutes the app may stay backgrounded before re-locking; 0 = immediate. */
  autoLockMinutes: number;
  /** Whether the persisted preference has been read from the keychain yet. */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setBiometricEnabled: (enabled: boolean) => Promise<void>;
  setAutoLockMinutes: (minutes: number) => Promise<void>;
}

/**
 * Unlock preferences. Biometric is an OPTIONAL convenience layer over the mandatory app PIN — off by
 * default until the user enables it (during PIN setup or in Wallet settings). Auto-lock re-locks the
 * app after this many minutes backgrounded (default 5). Persisted device-bound in the keychain so the
 * choice survives restarts; hydrated once at launch.
 */
export const useLockPrefsStore = create<LockPrefsState>((set) => ({
  biometricEnabled: false,
  autoLockMinutes: DEFAULT_AUTO_LOCK,
  hydrated: false,
  hydrate: async () => {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      const tmo = await SecureStore.getItemAsync(TIMEOUT_KEY);
      const mins = tmo == null ? DEFAULT_AUTO_LOCK : Number(tmo);
      set({
        biometricEnabled: v === "1",
        autoLockMinutes: Number.isFinite(mins) ? mins : DEFAULT_AUTO_LOCK,
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },
  setBiometricEnabled: async (biometricEnabled) => {
    set({ biometricEnabled });
    try {
      await SecureStore.setItemAsync(KEY, biometricEnabled ? "1" : "0", opts);
    } catch {
      /* best-effort: state already updated for this session */
    }
  },
  setAutoLockMinutes: async (autoLockMinutes) => {
    set({ autoLockMinutes });
    try {
      await SecureStore.setItemAsync(TIMEOUT_KEY, String(autoLockMinutes), opts);
    } catch {
      /* best-effort: state already updated for this session */
    }
  },
}));
