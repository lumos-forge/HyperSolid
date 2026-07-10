# M7 推送 · P3b —— 通知设置 toggle + 启动接线（收尾 M7 E2E）

- 日期：2026-07-10
- 里程碑：M7 推送服务（子项目 P3b）
- 语言：TypeScript（`mobile/`，Expo RN）
- 状态：设计已批准，待实现

## 1. 背景

M7 已落地：server P1/P2/P4（注册表/发送/事件接线）、mobile P3a（注册管道：`StrategyApi.registerPush/unregisterPush` + fail-safe `registerDeviceForPush`）。P3b 补上**用户可开关的设置项 + 真实原生适配器 + 持久化偏好**，让用户开启通知后设备真正注册 —— **M7 端到端跑通**。

## 2. 范围与非目标

**在范围内**
- `pushPrefsStore`（持久化 `enabled` + `token`，仿 `lockPrefsStore`）。
- `applyPushPreference` 编排器（可测、fail-safe）：开→建会话+注册；关→反注册。
- `expoPushEnv()` 真实 `PushEnv` 适配器（原生）。
- SettingsScreen 通知 `SettingRow` + 开关处理（**惰性 import `pushEnv`**）。
- i18n（en+zh 对齐）；`App.tsx` 启动 hydrate。
- 依赖 `expo-notifications` + `expo-device`；`app.json` plugins。

**非目标（明确排除）**
- **自动启动再注册、登出反注册** → P3c（Expo token 每安装稳定 + 服务端 upsert 幂等，MVP 由用户开关触发即可）。
- 通知分类/免打扰/推送文案 locale → P5。
- 延迟回执轮询 → P2.5；更细分类 → P4.5。

## 3. `state/pushPrefsStore.ts`（仿 `lockPrefsStore`）

zustand + `expo-secure-store`，best-effort 持久化，`hydrated` 标志，启动 hydrate 一次。

```ts
interface PushPrefsState {
  enabled: boolean;             // 用户是否开启通知
  token: string | null;         // 最近注册的 Expo push token（关闭时用于反注册）
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setToken: (token: string | null) => Promise<void>;
}
```

- keys：`hypersolid.push.enabled`（"1"/"0"）、`hypersolid.push.token`。
- `hydrate`：读两 key → `enabled = v==="1"`、`token = 原值||null`、`hydrated=true`；异常 → `set({hydrated:true})`。
- `setEnabled(b)`：`set({enabled:b})` 后 `SecureStore.setItemAsync(KEY, b?"1":"0")`（try/catch best-effort，同 lockPrefsStore）。
- `setToken(t)`：`set({token:t})` 后 `t==null ? deleteItemAsync(TOKEN_KEY) : setItemAsync(TOKEN_KEY, t)`（best-effort）。

## 4. `services/pushToggle.ts` —— 编排器（纯、注入、fail-safe、可测）

复用 P3a 的 `registerDeviceForPush`/`unregisterDeviceForPush`/`PushEnv`。

```ts
import { registerDeviceForPush, unregisterDeviceForPush, type PushEnv } from "./pushRegistration";
import type { StrategyApi } from "./strategyApi";

type AuthedApi = Pick<StrategyApi, "registerPush" | "unregisterPush">;

export type PushToggleResult =
  | { ok: true; token?: string }
  | { ok: false; reason: "no_session" | "not_device" | "permission_denied" | "error" };

export interface PushToggleDeps {
  env: PushEnv;
  makeAuthedApi: () => Promise<AuthedApi | null>; // mints a session; null when unavailable (locked / no baseUrl)
  prevToken: string | null;                       // last registered token (for unregister on disable)
}

export async function applyPushPreference(enable: boolean, deps: PushToggleDeps): Promise<PushToggleResult>;
```

行为：
- **开启**：`api = await makeAuthedApi(); if (!api) return { ok:false, reason:"no_session" };` → `const r = await registerDeviceForPush(api, deps.env);` → 若 `r.ok` 返回 `{ ok:true, token:r.token }`，否则 `{ ok:false, reason:r.reason }`（透传 not_device/permission_denied/error）。
- **关闭**：`if (deps.prevToken) { const api = await makeAuthedApi(); if (api) await unregisterDeviceForPush(api, deps.prevToken); }` → 返回 `{ ok:true }`（best-effort：无会话也算关成功，本地状态照关）。
- 整体 `try/catch` 兜底 → `{ ok:false, reason:"error" }`；**绝不抛**（`makeAuthedApi` 抛错也被吞）。

## 5. `services/pushEnv.ts` —— 真实适配器（原生，薄，不单测）

```ts
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { PushEnv, PermStatus } from "./pushRegistration";

function toStatus(s: string): PermStatus {
  return s === "granted" ? "granted" : s === "denied" ? "denied" : "undetermined";
}

export function expoPushEnv(): PushEnv {
  return {
    isDevice: Device.isDevice,
    platform: Platform.OS,
    getPermissionStatus: async () => toStatus((await Notifications.getPermissionsAsync()).status),
    requestPermission: async () => toStatus((await Notifications.requestPermissionsAsync()).status),
    getExpoPushToken: async () => {
      const c = Constants as unknown as { expoConfig?: { extra?: { eas?: { projectId?: string } } }; easConfig?: { projectId?: string } };
      const projectId = c.expoConfig?.extra?.eas?.projectId ?? c.easConfig?.projectId;
      const res = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      return res.data;
    },
  };
}
```

> 只由 SettingsScreen 的开关处理**惰性 import**（`await import("../services/pushEnv")`），确保该文件（及其 expo-notifications 原生导入）不在 render/测试时加载。

## 6. SettingsScreen 接线

在 Preferences 段加一行（复用现有 `SettingRow`；icon 用现有 `IconName` 中的 `"alert"`）：

```tsx
<SettingRow theme={theme} icon="alert" name={t("settings.notifications")}
  value={pushEnabled ? t("settings.notificationsOn") : t("settings.notificationsOff")}
  onPress={onToggleNotifications} />
```

store/依赖：`usePushPrefsStore`（enabled/token/setEnabled/setToken）、已有 `useWalletStore`（mode/wallet/address）、新增 `useRuntimeConfigStore`（strategyApiBaseUrl）、`useToastStore`。

`onToggleNotifications`（async，绝不抛）：
1. 构造 `makeAuthedApi`：
   ```ts
   const makeAuthedApi = async () => {
     const local = wallet as Partial<LocalWalletService> | null;
     if (mode !== "local" || !local || typeof local.getViemAccount !== "function" || !baseUrl || !address) return null;
     const token = await openStrategySession(new StrategyApi(baseUrl, null), local.getViemAccount(), address);
     return new StrategyApi(baseUrl, token);
   };
   ```
2. `const { expoPushEnv } = await import("../services/pushEnv");`（惰性）。
3. `const r = await applyPushPreference(!pushEnabled, { env: expoPushEnv(), makeAuthedApi, prevToken: token });`
4. 更新 store + toast：
   - 开且 `r.ok` → `setEnabled(true); if (r.token) setToken(r.token);` toast `settings.pushEnabled`。
   - 开但失败 → 不改 enabled；按 `r.reason` toast（`no_session`→`pushNoSession`；`permission_denied`→`pushPermission`；`not_device`/`error`→`pushFailed`）。
   - 关 → `setEnabled(false); setToken(null);` toast `settings.pushDisabled`（关按 §4 恒 ok）。

## 7. i18n（`i18n/messages.ts`，en + zh 均加，parity 由 `messages.test.ts` 强制）

新增 key（两 locale 均非空）：
- `settings.notifications`（"Notifications" / "通知"）
- `settings.notificationsOn`（"On" / "开"）、`settings.notificationsOff`（"Off" / "关"）
- `settings.pushEnabled`（"Notifications enabled" / "已开启通知"）
- `settings.pushDisabled`（"Notifications disabled" / "已关闭通知"）
- `settings.pushNoSession`（"Unlock your wallet and set a strategy server first" / "请先解锁钱包并配置策略服务器"）
- `settings.pushPermission`（"Notification permission denied" / "通知权限被拒绝"）
- `settings.pushFailed`（"Couldn't enable notifications" / "开启通知失败"）

## 8. `App.tsx` 启动 hydrate

在现有 hydrate 块（lock/theme/locale/env）追加：
```ts
void usePushPrefsStore.getState().hydrate();
```

## 9. 依赖与配置

- `npx expo install expo-notifications expo-device`（选 SDK56 兼容版本；写入 `mobile/package.json`）。
- `mobile/app.json` `expo.plugins` 追加 `"expo-notifications"`。

## 10. 测试计划

**`pushPrefsStore.test.ts`**（仿 `lockPrefsStore.test.ts`，mock expo-secure-store）
1. hydrate：persisted "1" + token → `enabled:true, token, hydrated:true`。
2. hydrate：无持久化 → `enabled:false, token:null, hydrated:true`。
3. `setEnabled(true)` → state 变且 `setItemAsync(KEY,"1")` 调用。
4. `setToken("t")` → state 变且 `setItemAsync(TOKEN_KEY,"t")`；`setToken(null)` → `deleteItemAsync(TOKEN_KEY)`。
5. SecureStore 抛错时 set* 不抛（best-effort）。

**`pushToggle.test.ts`**（fake env + fake makeAuthedApi + fake api）
6. 开、makeAuthedApi 返回 api、权限 granted → 调 registerPush → `{ok:true, token}`。
7. 开、makeAuthedApi 返回 null → `{ok:false,"no_session"}`，未注册。
8. 开、注册返回 permission_denied → `{ok:false,"permission_denied"}`。
9. 关、有 prevToken、makeAuthedApi 返回 api → 调 unregisterPush(prevToken) → `{ok:true}`。
10. 关、makeAuthedApi 返回 null → `{ok:true}`（本地照关，不抛）。
11. makeAuthedApi 抛错 → `{ok:false,"error"}`（不抛）。

**`messages.test.ts`**：既有 parity 测试自动覆盖新增 key（两 locale 齐、非空）。

`expoPushEnv`、SettingsScreen 的原生/会话链路不单测（原生接线，如 index.ts / pushEnv）；SettingsScreen 既有测试须仍绿（惰性 import 保证不加载原生）。

## 11. 验证命令

```bash
cd mobile && npx tsc --noEmit && npx jest src/state/pushPrefsStore.test.ts src/services/pushToggle.test.ts src/i18n/messages.test.ts
```
（`npm test` 跑全量确认无回归 + jest 基线不降；`npx expo-doctor` 可选核对原生配置。）

## 12. 与现有代码的关系

- 持久化 store 对齐 `lockPrefsStore`（zustand + SecureStore + hydrate + best-effort）。
- 编排器复用 P3a `registerDeviceForPush`/`unregisterDeviceForPush`，会话复用 `walletSession.openStrategySession`（AgentScreen 同款）。
- UI 复用 `SettingRow` + `useT` + `useToastStore` + `useTheme`（无硬编码色，过 `noHardcodedColors` 守卫）。
- 惰性 import 原生适配器，延续 P2/P3a「被测路径不加载原生」策略。

## 13. 后续

- **P3c**：自动启动再注册（enabled 时刷新 token）、登出/删钱包反注册。
- **P5**：通知偏好分类/免打扰/推送文案 locale。
- **P2.5**：延迟回执轮询。
