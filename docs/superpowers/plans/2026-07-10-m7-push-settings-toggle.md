# M7 P3b —— 通知设置 toggle + 启动接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish M7 end-to-end: a persisted `pushPrefsStore`, a testable fail-safe `applyPushPreference` orchestrator (mints a session + registers/unregisters), a real `expoPushEnv()` adapter, a SettingsScreen notifications toggle (lazy-loading the native adapter), i18n, and launch hydrate — so enabling notifications registers the device and P4's fill/alert notifications reach the phone.

**Architecture:** Testable core + thin wiring. `pushPrefsStore` (zustand + expo-secure-store, mirrors `lockPrefsStore`) persists `enabled` + `token`. `pushToggle.applyPushPreference(enable, {env, makeAuthedApi, prevToken})` reuses P3a's `registerDeviceForPush`/`unregisterDeviceForPush`; never throws. `pushEnv.expoPushEnv()` is the real `PushEnv` over `expo-device`/`expo-notifications`/`expo-constants`/`Platform` (verified against SDK56 docs). SettingsScreen adds a `SettingRow` whose handler builds `makeAuthedApi` (session via `openStrategySession`) and **lazy-imports** `pushEnv` so tests/render never load native modules. i18n keys added to en+zh (parity-enforced). App.tsx hydrates the store at launch.

**Tech Stack:** TypeScript, Expo SDK56, zustand, expo-secure-store, expo-notifications ~56.0.20, expo-device ~56.0.4 (both already `expo install`ed on this branch, uncommitted), jest-expo. Reuses P3a `pushRegistration` + `walletSession.openStrategySession`.

**Reference spec:** `docs/superpowers/specs/2026-07-10-m7-push-settings-toggle-design.md`

**Branch:** `feat/m7-push-settings-toggle` (already created; spec committed; `package.json`/`package-lock.json` carry expo-notifications/expo-device, uncommitted — committed in Task 3).

**Verified facts (do not re-derive):**
- `lockPrefsStore.ts` pattern: `import * as SecureStore from "expo-secure-store"`; `const KEY=...`; `const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;`; store has `hydrated`, `hydrate()` (reads via `SecureStore.getItemAsync`), `setX()` (set state then `SecureStore.setItemAsync(KEY, v, opts)` in try/catch).
- `lockPrefsStore.test.ts`: `jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: "...", getItemAsync: jest.fn(), setItemAsync: jest.fn() }))`; `beforeEach` clears mocks + `useLockPrefsStore.setState({...})`. Uses `getItem.mockResolvedValue(...)`.
- P3a `pushRegistration.ts` exports `registerDeviceForPush(api, env)`, `unregisterDeviceForPush(api, token)`, `type PushEnv`, `type PermStatus`, `type RegisterResult`.
- `walletSession.ts` exports `openStrategySession(api: StrategyApi, account: {signMessage(a:{message:string}):Promise<string>}, owner: string): Promise<string>`.
- SettingsScreen: `SettingRow` is `function SettingRow({ theme, icon, name, value, onPress, danger }: { theme: ThemeTokens; icon: IconName; name: string; value: string; onPress: () => void; danger?: boolean })`. Preferences rows rendered ~line 198–207 (network/theme/language/security/autolock). Screen uses `useWalletStore` (`mode`, `wallet`, `address`), `useT`, `useToastStore`, `useTheme`; `LocalWalletService` type import present; `openStrategySession` NOT yet imported. `IconName` includes `"alert"`.
- `useRuntimeConfigStore` exposes `strategyApiBaseUrl` (`mobile/src/state/runtimeConfigStore.ts`).
- `App.tsx` hydrate block (~line 92–96): `void useLockPrefsStore.getState().hydrate(); void useThemeStore...; void useLocaleStore...; void useEnvStore...`.
- `messages.ts` has `en` + `zh` blocks + `TranslationKey`; `messages.test.ts` enforces identical key sets + non-empty values across locales.
- expo-notifications SDK56 API (verified at https://docs.expo.dev/versions/v56.0.0/sdk/notifications/): `Notifications.getPermissionsAsync()` → `{status: 'granted'|'denied'|'undetermined'}`; `Notifications.requestPermissionsAsync()` → `{status}`; `Notifications.getExpoPushTokenAsync({projectId}).data`; projectId = `Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId`. `expo-device` exports `Device.isDevice: boolean`.
- Scripts: `mobile` `npm test` = jest; typecheck `npx tsc --noEmit`.

---

## File Structure

- Create: `mobile/src/state/pushPrefsStore.ts` — persisted `{enabled, token}` store.
- Create: `mobile/src/state/pushPrefsStore.test.ts` — store tests.
- Create: `mobile/src/services/pushToggle.ts` — `applyPushPreference` orchestrator.
- Create: `mobile/src/services/pushToggle.test.ts` — orchestrator tests.
- Create: `mobile/src/services/pushEnv.ts` — real `expoPushEnv()` adapter (native; not unit-tested).
- Modify: `mobile/src/i18n/messages.ts` — new keys (en + zh).
- Modify: `mobile/src/screens/SettingsScreen.tsx` — notifications row + handler.
- Modify: `mobile/App.tsx` — launch hydrate.
- Modify: `mobile/package.json`, `mobile/package-lock.json`, `mobile/app.json` — deps + plugin (deps already installed).

---

## Task 1: `pushPrefsStore`

**Files:**
- Create: `mobile/src/state/pushPrefsStore.ts`
- Test: `mobile/src/state/pushPrefsStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mobile/src/state/pushPrefsStore.test.ts`:

```ts
import * as SecureStore from "expo-secure-store";
import { usePushPrefsStore } from "./pushPrefsStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;
const delItem = SecureStore.deleteItemAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  usePushPrefsStore.setState({ enabled: false, token: null, hydrated: false });
});

describe("pushPrefsStore", () => {
  it("hydrates enabled + token from storage", async () => {
    getItem.mockImplementation(async (k: string) =>
      k === "hypersolid.push.enabled" ? "1" : "ExponentPushToken[t]");
    await usePushPrefsStore.getState().hydrate();
    const s = usePushPrefsStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.token).toBe("ExponentPushToken[t]");
    expect(s.hydrated).toBe(true);
  });

  it("hydrates disabled/null when nothing persisted", async () => {
    getItem.mockResolvedValue(null);
    await usePushPrefsStore.getState().hydrate();
    const s = usePushPrefsStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.token).toBeNull();
    expect(s.hydrated).toBe(true);
  });

  it("setEnabled updates state and persists", async () => {
    await usePushPrefsStore.getState().setEnabled(true);
    expect(usePushPrefsStore.getState().enabled).toBe(true);
    expect(setItem).toHaveBeenCalledWith("hypersolid.push.enabled", "1", expect.anything());
  });

  it("setToken persists a value and deletes on null", async () => {
    await usePushPrefsStore.getState().setToken("ExponentPushToken[t]");
    expect(usePushPrefsStore.getState().token).toBe("ExponentPushToken[t]");
    expect(setItem).toHaveBeenCalledWith("hypersolid.push.token", "ExponentPushToken[t]", expect.anything());
    await usePushPrefsStore.getState().setToken(null);
    expect(usePushPrefsStore.getState().token).toBeNull();
    expect(delItem).toHaveBeenCalledWith("hypersolid.push.token");
  });

  it("does not throw when SecureStore rejects (best-effort)", async () => {
    setItem.mockRejectedValue(new Error("keychain"));
    await expect(usePushPrefsStore.getState().setEnabled(true)).resolves.toBeUndefined();
    expect(usePushPrefsStore.getState().enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/state/pushPrefsStore.test.ts`
Expected: FAIL — cannot find module `./pushPrefsStore`.

- [ ] **Step 3: Write minimal implementation**

Create `mobile/src/state/pushPrefsStore.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/state/pushPrefsStore.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/state/pushPrefsStore.ts mobile/src/state/pushPrefsStore.test.ts && \
  git commit -m "feat(mobile): pushPrefsStore (persisted enabled + token)"
```

---

## Task 2: `applyPushPreference` orchestrator

**Files:**
- Create: `mobile/src/services/pushToggle.ts`
- Test: `mobile/src/services/pushToggle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mobile/src/services/pushToggle.test.ts`:

```ts
import { applyPushPreference } from "./pushToggle";
import type { PushEnv, PermStatus } from "./pushRegistration";

function envFake(over: Partial<PushEnv> & { permSeq?: PermStatus[] } = {}): PushEnv {
  const permSeq = over.permSeq ?? ["granted"];
  let i = 0;
  return {
    isDevice: over.isDevice ?? true,
    platform: over.platform ?? "ios",
    getPermissionStatus: over.getPermissionStatus ?? (async () => permSeq[Math.min(i, permSeq.length - 1)]),
    requestPermission: over.requestPermission ?? (async () => { i = 1; return permSeq[Math.min(i, permSeq.length - 1)]; }),
    getExpoPushToken: over.getExpoPushToken ?? (async () => "ExponentPushToken[tok]"),
  };
}

function apiFake() {
  const calls: { register: [string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string) { calls.register.push([token, platform]); },
    async unregisterPush(token: string) { calls.unregister.push(token); },
  };
}

describe("applyPushPreference", () => {
  it("enables: mints session, registers, returns token", async () => {
    const api = apiFake();
    const r = await applyPushPreference(true, { env: envFake(), makeAuthedApi: async () => api, prevToken: null });
    expect(r).toEqual({ ok: true, token: "ExponentPushToken[tok]" });
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios"]]);
  });

  it("enables without a session → no_session, no registration", async () => {
    const r = await applyPushPreference(true, { env: envFake(), makeAuthedApi: async () => null, prevToken: null });
    expect(r).toEqual({ ok: false, reason: "no_session" });
  });

  it("enables but permission denied → permission_denied", async () => {
    const api = apiFake();
    const r = await applyPushPreference(true, { env: envFake({ permSeq: ["undetermined", "denied"] }), makeAuthedApi: async () => api, prevToken: null });
    expect(r).toEqual({ ok: false, reason: "permission_denied" });
    expect(api.calls.register).toHaveLength(0);
  });

  it("disables: unregisters the previous token", async () => {
    const api = apiFake();
    const r = await applyPushPreference(false, { env: envFake(), makeAuthedApi: async () => api, prevToken: "ExponentPushToken[old]" });
    expect(r).toEqual({ ok: true });
    expect(api.calls.unregister).toEqual(["ExponentPushToken[old]"]);
  });

  it("disables with no session still returns ok (local off)", async () => {
    const r = await applyPushPreference(false, { env: envFake(), makeAuthedApi: async () => null, prevToken: "ExponentPushToken[old]" });
    expect(r).toEqual({ ok: true });
  });

  it("never throws when makeAuthedApi rejects", async () => {
    const r = await applyPushPreference(true, { env: envFake(), makeAuthedApi: async () => { throw new Error("mint"); }, prevToken: null });
    expect(r).toEqual({ ok: false, reason: "error" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/services/pushToggle.test.ts`
Expected: FAIL — cannot find module `./pushToggle`.

- [ ] **Step 3: Write minimal implementation**

Create `mobile/src/services/pushToggle.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/services/pushToggle.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/pushToggle.ts mobile/src/services/pushToggle.test.ts && \
  git commit -m "feat(mobile): applyPushPreference orchestrator (session + register/unregister)"
```

---

## Task 3: `expoPushEnv` adapter + deps + app.json

**Files:**
- Create: `mobile/src/services/pushEnv.ts`
- Modify: `mobile/package.json`, `mobile/package-lock.json` (deps already installed), `mobile/app.json`

- [ ] **Step 1: Create the adapter**

Create `mobile/src/services/pushEnv.ts` (API verified against SDK56 docs):

```ts
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { PushEnv, PermStatus } from "./pushRegistration";

function toStatus(s: string): PermStatus {
  return s === "granted" ? "granted" : s === "denied" ? "denied" : "undetermined";
}

/** Real PushEnv over expo-device / expo-notifications / expo-constants. Native — not unit-tested;
 *  lazy-imported by SettingsScreen so tests never load these modules. */
export function expoPushEnv(): PushEnv {
  return {
    isDevice: Device.isDevice,
    platform: Platform.OS,
    getPermissionStatus: async () => toStatus((await Notifications.getPermissionsAsync()).status),
    requestPermission: async () => toStatus((await Notifications.requestPermissionsAsync()).status),
    getExpoPushToken: async () => {
      const c = Constants as unknown as {
        expoConfig?: { extra?: { eas?: { projectId?: string } } };
        easConfig?: { projectId?: string };
      };
      const projectId = c.expoConfig?.extra?.eas?.projectId ?? c.easConfig?.projectId;
      const res = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      return res.data;
    },
  };
}
```

- [ ] **Step 2: Add the app.json plugin**

In `mobile/app.json`, add `"expo-notifications"` to the `expo.plugins` array (append after `"@sentry/react-native"`):

```json
      "expo-sqlite",
      "expo-font",
      "@sentry/react-native",
      "expo-notifications"
```

- [ ] **Step 3: Typecheck**

Run: `cd mobile && npx tsc --noEmit`
Expected: clean (deps `expo-notifications`/`expo-device` already installed on this branch; `pushEnv.ts` type-checks against them).

- [ ] **Step 4: Confirm no test loads the adapter**

Run: `cd mobile && npx jest src/services/pushToggle.test.ts src/services/pushRegistration.test.ts`
Expected: PASS — these tests do not import `pushEnv.ts`, so no native module loads.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/pushEnv.ts mobile/package.json mobile/package-lock.json mobile/app.json && \
  git commit -m "feat(mobile): expoPushEnv adapter + expo-notifications/expo-device deps + plugin"
```

---

## Task 4: i18n keys (en + zh)

**Files:**
- Modify: `mobile/src/i18n/messages.ts`
- Test: `mobile/src/i18n/messages.test.ts` (existing parity test covers new keys)

- [ ] **Step 1: Add keys to the `en` block**

In `mobile/src/i18n/messages.ts`, inside the `en` object (near the other `settings.*` keys), add:

```ts
    "settings.notifications": "Notifications",
    "settings.notificationsOn": "On",
    "settings.notificationsOff": "Off",
    "settings.pushEnabled": "Notifications enabled",
    "settings.pushDisabled": "Notifications disabled",
    "settings.pushNoSession": "Unlock your wallet and set a strategy server first",
    "settings.pushPermission": "Notification permission denied",
    "settings.pushFailed": "Couldn't enable notifications",
```

- [ ] **Step 2: Add the same keys to the `zh` block**

In the `zh` object (near the other `settings.*` keys), add:

```ts
    "settings.notifications": "通知",
    "settings.notificationsOn": "开",
    "settings.notificationsOff": "关",
    "settings.pushEnabled": "已开启通知",
    "settings.pushDisabled": "已关闭通知",
    "settings.pushNoSession": "请先解锁钱包并配置策略服务器",
    "settings.pushPermission": "通知权限被拒绝",
    "settings.pushFailed": "开启通知失败",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts && npx tsc --noEmit`
Expected: PASS — identical key sets across en/zh, all non-empty; `TranslationKey` now includes the new keys so `tsc` stays clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/i18n/messages.ts && \
  git commit -m "feat(mobile): i18n keys for notifications settings (en+zh)"
```

---

## Task 5: SettingsScreen toggle + App.tsx launch hydrate

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`
- Modify: `mobile/App.tsx`

- [ ] **Step 1: Add imports + store hooks in SettingsScreen**

In `mobile/src/screens/SettingsScreen.tsx`, add imports (with the other imports):

```ts
import type { LocalWalletService } from "../wallet/localWallet";
import { usePushPrefsStore } from "../state/pushPrefsStore";
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";
import { StrategyApi } from "../services/strategyApi";
import { openStrategySession } from "../wallet/walletSession";
import { applyPushPreference } from "../services/pushToggle";
```

Inside the component body (near the other store selectors like `mode`), add. The screen already reads `mode` from `useWalletStore` but NOT `wallet`/`address`, and toasts via `useToastStore.getState().show(...)` (no hook selector), so add:

```ts
  const wallet = useWalletStore((s) => s.wallet);
  const address = useWalletStore((s) => s.address);
  const pushEnabled = usePushPrefsStore((s) => s.enabled);
  const pushToken = usePushPrefsStore((s) => s.token);
  const setPushEnabled = usePushPrefsStore((s) => s.setEnabled);
  const setPushToken = usePushPrefsStore((s) => s.setToken);
  const baseUrl = useRuntimeConfigStore((s) => s.strategyApiBaseUrl);
```

- [ ] **Step 2: Add the toggle handler**

Add inside the component (near `onToggleBiometric`):

```ts
  async function onToggleNotifications() {
    const makeAuthedApi = async () => {
      const local = wallet as Partial<LocalWalletService> | null;
      if (mode !== "local" || !local || typeof local.getViemAccount !== "function" || !baseUrl || !address) return null;
      const tok = await openStrategySession(new StrategyApi(baseUrl, null), local.getViemAccount(), address);
      return new StrategyApi(baseUrl, tok);
    };
    const { expoPushEnv } = await import("../services/pushEnv");
    const r = await applyPushPreference(!pushEnabled, { env: expoPushEnv(), makeAuthedApi, prevToken: pushToken });
    if (!pushEnabled) {
      if (r.ok) {
        await setPushEnabled(true);
        if (r.token) await setPushToken(r.token);
        useToastStore.getState().show(t("settings.pushEnabled"), "success");
      } else {
        const key =
          r.reason === "no_session" ? "settings.pushNoSession" :
          r.reason === "permission_denied" ? "settings.pushPermission" :
          "settings.pushFailed";
        useToastStore.getState().show(t(key), "error");
      }
    } else {
      await setPushEnabled(false);
      await setPushToken(null);
      useToastStore.getState().show(t("settings.pushDisabled"), "success");
    }
  }
```

- [ ] **Step 3: Render the notifications row**

In the Preferences section (next to the biometric/auto-lock rows, ~line 205), add:

```tsx
          <SettingRow theme={theme} icon="alert" name={t("settings.notifications")} value={pushEnabled ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={onToggleNotifications} />
```

- [ ] **Step 4: Add launch hydrate in App.tsx**

In `mobile/App.tsx`, add the import (with the other store imports) and the hydrate call:

Import:
```ts
import { usePushPrefsStore } from "./src/state/pushPrefsStore";
```

In the hydrate `useEffect` block (after `void useEnvStore.getState().hydrate();`):
```ts
    void usePushPrefsStore.getState().hydrate();
```

(Adjust the import path prefix to match the existing store imports in `App.tsx` — they use `./src/state/...`.)

- [ ] **Step 5: Typecheck + run SettingsScreen + full push tests**

Run:
```bash
cd mobile && npx tsc --noEmit && npx jest src/screens/SettingsScreen.test.tsx src/state/pushPrefsStore.test.ts src/services/pushToggle.test.ts src/i18n/messages.test.ts
```
Expected: `tsc` clean; SettingsScreen existing tests still PASS (the lazy `import("../services/pushEnv")` means rendering never loads expo-notifications); push/i18n tests PASS. If SettingsScreen.test fails because a store selector returns undefined under its mocks, ensure the test's zustand stores are not broken — `usePushPrefsStore` has safe defaults (`enabled:false, token:null`) so selectors resolve without extra mocking.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/screens/SettingsScreen.tsx mobile/App.tsx && \
  git commit -m "feat(mobile): notifications toggle in Settings + launch hydrate (M7 P3b)"
```

---

## Task 6: roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the roadmap M7 status**

In `docs/BACKEND-ARCHITECTURE.md`, the M7 row currently ends (from P3a):

```
；P3b 设置 toggle+启动接线+expo-notifications 依赖、P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类 待做】**
```

Replace that tail with:

```
；P3b 落地：通知设置 toggle（SettingsScreen）+ `pushPrefsStore`（持久化开关+token）+ `applyPushPreference`（建会话+注册/反注册，fail-safe）+ `expoPushEnv` 适配器 + 启动 hydrate + i18n —— **M7 端到端跑通**；P3c 自动再注册/登出反注册、P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类 待做】**
```

- [ ] **Step 2: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: mark M7 P3b landed — 端到端跑通"
```

- [ ] **Step 3: Full mobile validation (no regressions)**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: typecheck clean; the whole jest suite passes (new store/orchestrator/i18n tests + all existing, incl. SettingsScreen).

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-settings-toggle && \
  gh pr create --title "feat(mobile): M7 P3b 通知设置 toggle + 启动接线（收尾 M7 E2E）" \
    --body "M7 推送子项目 P3b —— 端到端收尾。\`pushPrefsStore\`（持久化 enabled+token）+ fail-safe \`applyPushPreference\`（建会话 openStrategySession + 复用 P3a register/unregister）+ 真实 \`expoPushEnv\` 适配器（SDK56 验证，SettingsScreen 惰性 import）+ SettingsScreen 通知行 + i18n(en+zh) + App 启动 hydrate。开启通知→取 Expo token→注册到 /push/register，之后 P4 的成交/告警推达设备。自动再注册/登出反注册→P3c。新增 expo-notifications/expo-device 依赖 + app.json plugin。Spec: docs/superpowers/specs/2026-07-10-m7-push-settings-toggle-design.md"
```
Expected: PR created.

- [ ] **Step 5: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §3 store → Task 1; §4 orchestrator → Task 2; §5 adapter → Task 3; §7 i18n → Task 4; §6 SettingsScreen + §8 App hydrate → Task 5; §9 deps/plugin → Task 3; §10 tests (store 1–5, toggle 6–11, messages parity) → Tasks 1/2/4; §11 validation → Task 6. Doc → Task 6. All covered.
- **Placeholder scan:** all code complete. The SettingsScreen store-selector note (Step 1) is a defensive check, not a placeholder — exact selectors are given.
- **Type consistency:** `usePushPrefsStore` state (`enabled/token/hydrated/hydrate/setEnabled/setToken`), `applyPushPreference(enable, {env, makeAuthedApi, prevToken})`, `PushToggleResult` reasons (`no_session/not_device/permission_denied/error`), `expoPushEnv(): PushEnv`, i18n keys (`settings.notifications*`, `settings.push*`) — identical across store/orchestrator/adapter/screen/i18n and match the spec + P3a `PushEnv`/`registerDeviceForPush`.
- **Native isolation:** `pushEnv.ts` (the only expo-notifications importer) is lazy-imported in SettingsScreen's handler and imported by no test → jest never loads native modules; SettingsScreen renders without it. Deps already installed so `tsc` resolves types.
- **Fail-safe:** `applyPushPreference` wraps everything in try/catch (→ `error`), disable returns ok even without a session, and reuses P3a's never-throwing register/unregister. Store set* are best-effort. Tests assert never-throws.
