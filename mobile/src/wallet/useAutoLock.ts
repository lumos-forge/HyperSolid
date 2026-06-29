import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useAuthStore } from "../state/authStore";
import { useLockPrefsStore } from "../state/lockPrefsStore";
import { lockSession } from "./sessionController";

export const IDLE_TIMEOUT_MS = 5 * 60_000;

export function shouldLock(p: { lastActiveAt: number; now: number; timeoutMs: number }): boolean {
  return p.now - p.lastActiveAt > p.timeoutMs;
}

/**
 * Locks the session when the app returns to foreground after exceeding the user's auto-lock timeout
 * (Wallet › Auto-lock; default 5 min, 0 = immediate). Reads the live preference so a change applies
 * to the next background→foreground cycle without remounting.
 */
export function useAutoLock(): void {
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      const { status, lastActiveAt, touch } = useAuthStore.getState();
      if (status !== "unlocked") return;
      const timeoutMs = useLockPrefsStore.getState().autoLockMinutes * 60_000;
      if (next === "active") {
        if (shouldLock({ lastActiveAt, now: Date.now(), timeoutMs })) lockSession();
        else touch();
      } else {
        touch();
      }
    });
    return () => sub.remove();
  }, []);
}
