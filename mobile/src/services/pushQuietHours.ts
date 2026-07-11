import type { StrategyApi } from "./strategyApi";

export interface QuietHours {
  enabled: boolean;
  start: number; // minute-of-day 0..1439
  end: number;   // minute-of-day 0..1439
  tz: string;    // IANA timezone
}

type AuthedApi = Pick<StrategyApi, "getQuietHours" | "setQuietHours">;

/** Device IANA timezone, or "UTC" when unavailable. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Fetch quiet hours; null when there is no session or on any error. */
export async function fetchQuietHours(
  makeAuthedApi: () => Promise<AuthedApi | null>,
): Promise<QuietHours | null> {
  try {
    const api = await makeAuthedApi();
    if (!api) return null;
    return await api.getQuietHours();
  } catch {
    return null;
  }
}

/** Write quiet hours; false when there is no session or on any error. */
export async function saveQuietHours(
  makeAuthedApi: () => Promise<AuthedApi | null>,
  qh: QuietHours,
): Promise<boolean> {
  try {
    const api = await makeAuthedApi();
    if (!api) return false;
    await api.setQuietHours(qh);
    return true;
  } catch {
    return false;
  }
}
