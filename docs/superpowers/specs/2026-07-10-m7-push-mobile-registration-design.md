# M7 推送 · P3a —— mobile 推送注册管道（无 UI）

- 日期：2026-07-10
- 里程碑：M7 推送服务（子项目 P3a；P3 拆为 P3a 管道 + P3b UX）
- 语言：TypeScript（`mobile/`，Expo RN）
- 状态：设计已批准，待实现

## 1. 背景

M7 server 侧已完整：P1 令牌注册表（`/push/register`·`/push/unregister`）、P2 发送核心、P4 事件接线。缺 mobile 端把设备 Expo push token 注册上去 —— 补齐后自动成交/告警才真正推达手机。

P3 拆分（各自 spec→plan→PR）：
- **P3a（本文）注册管道**：`expo-notifications`/`expo-device` 依赖 + Expo 配置 + 可注入的注册服务（权限 + 取 Expo token → `StrategyApi.registerPush`）+ StrategyApi 两方法。**可单测核心，无 UI**。
- **P3b UX + 启动接线**：`pushPrefsStore`（持久化开关）+ 设置界面 toggle + 启用/启动时注册、禁用/登出时反注册 + i18n。

## 2. 范围与非目标

**在范围内**
- `StrategyApi.registerPush(token, platform)` / `unregisterPush(token)`。
- `pushRegistration.ts`：纯、可注入、fail-safe 的 `registerDeviceForPush` / `unregisterDeviceForPush` + 类型。

**非目标（→ P3b）**
- 无 UI/toggle、无 `pushPrefsStore`、无启动/登出触发、无 i18n（P3a 无用户可见文案）。
- **不加 `expo-notifications`/`expo-device` 依赖，不改 `app.json`**——这些只在真实 `expoPushEnv()` 适配器（导入原生模块）时才需要，随 P3b 一起加。P3a 的被测服务只用注入 env，故无需原生依赖，保持纯 TS、免安装、CI 安全。
- 无真实 `expoPushEnv` 适配器。
- 不做延迟回执（P2.5）、更细分类（P4.5）。

## 3. 设计动机：注入 env

被测服务 `registerDeviceForPush` **不直接 import** `expo-notifications`/`expo-device`，而接收一个注入的 `PushEnv`（权限/取 token/平台/是否真机）。理由：① jest 下无需依赖 jest-expo 对原生模块的 mock，测试确定；② 与 server P2「依赖入 package.json、被测模块只用类型/注入」同构；③ 真实 env 适配器（`expoPushEnv()`）在 P3b 装配处提供。

## 4. 依赖与 Expo 配置（→ P3b）

P3a **不改依赖/配置**。真实取 token 需 `expo-notifications`/`expo-device` 依赖 + `app.json` plugins 加 `expo-notifications` + `getExpoPushTokenAsync({ projectId })` 从 `expo-constants` 读 EAS projectId——这些随 P3b 的 `expoPushEnv()` 适配器一起加。P3a 的被测服务只用注入 `PushEnv`，无需任何原生依赖。

## 5. StrategyApi 方法（`mobile/src/services/strategyApi.ts`）

```ts
// push registration (M7 P3)
registerPush(token: string, platform: string) {
  return this.request<void>("/push/register", "POST", { token, platform });
}
unregisterPush(token: string) {
  return this.request<void>("/push/unregister", "POST", { token });
}
```

沿用现有 `request<void>(path, "POST", body)`（自带 `Authorization: Bearer` 与 base url；authed 调用需用带 session token 的 `StrategyApi` 实例——由 P3b 提供）。

## 6. 注册服务（`mobile/src/services/pushRegistration.ts`）

```ts
import type { StrategyApi } from "./strategyApi";

export type PermStatus = "granted" | "denied" | "undetermined";

export interface PushEnv {
  isDevice: boolean;                          // physical device? (Expo push needs a real device)
  platform: string;                           // "ios" | "android"
  getPermissionStatus(): Promise<PermStatus>;
  requestPermission(): Promise<PermStatus>;
  getExpoPushToken(): Promise<string>;
}

export type RegisterResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not_device" | "permission_denied" | "error" };

export async function registerDeviceForPush(
  api: Pick<StrategyApi, "registerPush">,
  env: PushEnv,
): Promise<RegisterResult>;

export async function unregisterDeviceForPush(
  api: Pick<StrategyApi, "unregisterPush">,
  token: string,
): Promise<void>; // best-effort; swallows errors
```

### 6.1 `registerDeviceForPush` 流程（fail-safe，绝不抛）

1. `if (!env.isDevice) return { ok: false, reason: "not_device" }`（模拟器/web 无 Expo push token；不调 api）。
2. `let status = await env.getPermissionStatus(); if (status !== "granted") status = await env.requestPermission();`
3. `if (status !== "granted") return { ok: false, reason: "permission_denied" }`（不调 api）。
4. `const token = await env.getExpoPushToken();`
5. `await api.registerPush(token, env.platform); return { ok: true, token };`
6. 整个 2–5 包在 `try/catch`，任何异常（取 token 失败 / 注册请求失败）→ `return { ok: false, reason: "error" }`。

### 6.2 `unregisterDeviceForPush`

`try { await api.unregisterPush(token); } catch { /* best-effort */ }`。

## 7. 测试计划（`pushRegistration.test.ts` + `strategyApi.test.ts` 追加）

fake `PushEnv`（可配 isDevice/权限序列/token/抛错）、fake `api`（记录 `registerPush`/`unregisterPush` 调用或抛错）。

**pushRegistration.test.ts**
1. 非真机 → `{ok:false,"not_device"}`，`registerPush` 未调用。
2. 已 granted → `getExpoPushToken` → `registerPush(token, "ios")` 恰一次 → `{ok:true, token}`。
3. undetermined → `requestPermission` 返回 granted → 注册成功。
4. 请求后 denied → `{ok:false,"permission_denied"}`，`registerPush` 未调用。
5. `getExpoPushToken` 抛错 → `{ok:false,"error"}`（不抛）。
6. `api.registerPush` 抛错 → `{ok:false,"error"}`（不抛）。
7. `unregisterDeviceForPush`：正常调用 `api.unregisterPush(token)`；`api.unregisterPush` 抛错时**不抛**。

**strategyApi.test.ts（追加，注入 fetchImpl，仿现有用例）**
8. `registerPush("ExponentPushToken[x]","ios")` → `POST {baseUrl}/push/register`，body `{token,platform}`，带 `Authorization: Bearer`。
9. `unregisterPush("ExponentPushToken[x]")` → `POST {baseUrl}/push/unregister`，body `{token}`。

## 8. 验证命令

```bash
cd mobile && npx tsc --noEmit && npx jest src/services/pushRegistration.test.ts src/services/strategyApi.test.ts
```
（`npm test` 跑全量确认无回归；jest 基线不降。）

## 9. 与现有代码的关系

- 注入 env 缝对齐 server P2 `ExpoLike` / `StrategyApi.fetchImpl`；纯服务 + 全单测、暂不接 UI，对齐 wsshard/notifier「先建可测核心」。
- StrategyApi 方法沿用现有 `request<void>` + bearer 约定（`mobile/src/services/strategyApi.ts`）。
- 依赖入 package.json 但被测模块不运行时导入（真实适配器在 P3b），对齐 P2 的 ESM/原生规避策略。

## 10. 后续（本次不做）

- **P3b**：`expoPushEnv()` 真实适配器（expo-notifications/expo-device/expo-constants/Platform）；`pushPrefsStore`（持久化开关，仿 `lockPrefsStore`）；设置界面 toggle；启用/启动时 `registerDeviceForPush`、禁用/登出时 `unregisterDeviceForPush`；i18n（en+zh 对齐）。
- **P5** 通知偏好分类/免打扰/locale；**P2.5** 延迟回执轮询。
