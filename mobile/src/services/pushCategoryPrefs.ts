import type { StrategyApi } from "./strategyApi";

export interface PushCategoryPrefs {
  fills: boolean;
  alerts: boolean;
}

type AuthedApi = Pick<StrategyApi, "getPushPrefs" | "setPushPrefs">;

/** Fetch the owner's category prefs; null when there is no session or on any error. */
export async function fetchPushCategoryPrefs(
  makeAuthedApi: () => Promise<AuthedApi | null>,
): Promise<PushCategoryPrefs | null> {
  try {
    const api = await makeAuthedApi();
    if (!api) return null;
    return await api.getPushPrefs();
  } catch {
    return null;
  }
}

/** Write a partial category pref; false when there is no session or on any error. */
export async function setPushCategoryPrefs(
  makeAuthedApi: () => Promise<AuthedApi | null>,
  prefs: Partial<PushCategoryPrefs>,
): Promise<boolean> {
  try {
    const api = await makeAuthedApi();
    if (!api) return false;
    await api.setPushPrefs(prefs);
    return true;
  } catch {
    return false;
  }
}
