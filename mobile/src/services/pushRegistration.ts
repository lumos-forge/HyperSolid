import type { StrategyApi } from "./strategyApi";

export type PermStatus = "granted" | "denied" | "undetermined";

/** Injected seam over device / notification-permission / token acquisition, so the
 *  registration flow is unit-testable and never imports expo-notifications directly
 *  (the real adapter lands in P3b). */
export interface PushEnv {
  isDevice: boolean;
  platform: string;
  /** Active UI locale reported to the server so push is localized for this device. */
  locale: string;
  getPermissionStatus(): Promise<PermStatus>;
  requestPermission(): Promise<PermStatus>;
  getExpoPushToken(): Promise<string>;
}

export type RegisterResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not_device" | "permission_denied" | "error" };

/** Acquire an Expo push token and register it with the server. Fail-safe: never throws. */
export async function registerDeviceForPush(
  api: Pick<StrategyApi, "registerPush">,
  env: PushEnv,
): Promise<RegisterResult> {
  if (!env.isDevice) return { ok: false, reason: "not_device" };
  try {
    let status = await env.getPermissionStatus();
    if (status !== "granted") status = await env.requestPermission();
    if (status !== "granted") return { ok: false, reason: "permission_denied" };
    const token = await env.getExpoPushToken();
    await api.registerPush(token, env.platform, env.locale);
    return { ok: true, token };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Best-effort server unregister; swallows errors. */
export async function unregisterDeviceForPush(
  api: Pick<StrategyApi, "unregisterPush">,
  token: string,
): Promise<void> {
  try {
    await api.unregisterPush(token);
  } catch {
    // best-effort
  }
}
