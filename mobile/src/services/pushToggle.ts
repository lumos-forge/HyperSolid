import { registerDeviceForPush, unregisterDeviceForPush, type PushEnv } from "./pushRegistration";
import type { StrategyApi } from "./strategyApi";

type AuthedApi = Pick<StrategyApi, "registerPush" | "unregisterPush">;

export type PushToggleResult =
  | { ok: true; token?: string }
  | { ok: false; reason: "no_session" | "not_device" | "permission_denied" | "error" };

export interface PushToggleDeps {
  env: PushEnv;
  makeAuthedApi: () => Promise<AuthedApi | null>;
  prevToken: string | null;
}

/** Apply a notifications on/off preference: on enable mint a session + register; on disable
 *  best-effort unregister the previous token. Fail-safe: never throws. */
export async function applyPushPreference(enable: boolean, deps: PushToggleDeps): Promise<PushToggleResult> {
  try {
    if (enable) {
      const api = await deps.makeAuthedApi();
      if (!api) return { ok: false, reason: "no_session" };
      const r = await registerDeviceForPush(api, deps.env);
      return r.ok ? { ok: true, token: r.token } : { ok: false, reason: r.reason };
    }
    if (deps.prevToken) {
      const api = await deps.makeAuthedApi();
      if (api) await unregisterDeviceForPush(api, deps.prevToken);
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}
