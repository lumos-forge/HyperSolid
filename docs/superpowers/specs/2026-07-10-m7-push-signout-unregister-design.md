# M7 推送 · P3c —— 登出反注册

- 日期：2026-07-10
- 里程碑：M7 推送服务（子项目 P3c，可选增强）
- 语言：TypeScript（`mobile/`）
- 状态：设计已批准，待实现

## 1. 背景

M7 端到端已通（P1/P2/P3a/P3b/P4）。P3c 补生命周期收尾：用户**登出/删钱包**时，反注册该设备的 Expo push token 并清空本地推送偏好——避免登出后旧 owner 仍向这台设备推送（隐私/正确性）。

登出流程（`SettingsScreen.onSignOut` 的 onPress）当前为 `await manager.signOut(); reset();`（`reset()` 清空钱包 `mode/wallet/address`）。反注册须在 `signOut()`/`reset()` **之前**做——那时钱包账户仍在，可建会话调 `/push/unregister`。

## 2. 范围与非目标

**在范围内**
- `unregisterForSignOut(makeAuthedApi, prevToken)`：fail-safe、best-effort 反注册。
- SettingsScreen `onSignOut`：反注册 + 清 pushPrefs（enabled=false、token=null），再照常 signOut/reset。
- 复用 `makeAuthedApi`（从 `onToggleNotifications` 提到组件作用域，DRY）。

**非目标（明确排除）**
- **启动/解锁再注册** —— 砍掉（Expo push token 每安装稳定，P3b 开关时已 server 端 upsert；价值低 = YAGNI）。留作未来。
- 不改 server（P1 `/push/unregister` 已具备）。
- 通知偏好/locale → P5；延迟回执 → P2.5。

## 3. `services/pushToggle.ts` 新增

复用 P3a `unregisterDeviceForPush`（已 best-effort 吞错）。

```ts
type AuthedApi = Pick<StrategyApi, "registerPush" | "unregisterPush">;

/** Best-effort unregister for sign-out: mint a session and unregister the token if present.
 *  Never throws — sign-out must proceed regardless of push cleanup. */
export async function unregisterForSignOut(
  makeAuthedApi: () => Promise<AuthedApi | null>,
  prevToken: string | null,
): Promise<void> {
  try {
    if (!prevToken) return;
    const api = await makeAuthedApi();
    if (api) await unregisterDeviceForPush(api, prevToken);
  } catch {
    // best-effort
  }
}
```

## 4. SettingsScreen 接线

- 把 `makeAuthedApi`（P3b 里定义在 `onToggleNotifications` 内）提到组件作用域，供 `onToggleNotifications` 与 `onSignOut` 共用：
  ```ts
  const makeAuthedApi = async () => {
    const local = wallet as Partial<LocalWalletService> | null;
    if (mode !== "local" || !local || typeof local.getViemAccount !== "function" || !baseUrl || !address) return null;
    const tok = await openStrategySession(new StrategyApi(baseUrl, null), local.getViemAccount(), address);
    return new StrategyApi(baseUrl, tok);
  };
  ```
- `onSignOut` 的 onPress 改为（反注册 + 清 prefs 在 signOut 之前）：
  ```ts
  onPress: async () => {
    await unregisterForSignOut(makeAuthedApi, pushToken);
    await setPushEnabled(false);
    await setPushToken(null);
    try {
      await manager.signOut();
      reset();
    } catch {
      reset();
    }
  },
  ```
- `unregisterForSignOut`/`setPushEnabled`/`setPushToken` 均 fail-safe，登出主流程不受影响。

## 5. 测试计划

**`pushToggle.test.ts`（追加）**
1. 有 prevToken + `makeAuthedApi` 返回 api → 调 `unregisterPush(prevToken)` 恰一次。
2. `prevToken` 为 null → 不调 `makeAuthedApi`、不调 unregister。
3. `makeAuthedApi` 返回 null → 不调 unregister、不抛。
4. `makeAuthedApi` 抛错 → `unregisterForSignOut` 不抛（resolves）。

**SettingsScreen 既有测试**：仍绿（测试无真实钱包 → makeAuthedApi 返 null → 反注册 no-op；store setter 安全）。

## 6. 验证命令

```bash
cd mobile && npx tsc --noEmit && npx jest src/services/pushToggle.test.ts src/screens/SettingsScreen.test.tsx
```
（`npm test` 跑全量确认无回归。）

## 7. 与现有代码的关系

- 复用 P3a `unregisterDeviceForPush`、P3b `makeAuthedApi`/`pushPrefsStore`、`walletSession.openStrategySession`。
- fail-safe/best-effort 对齐 P2/P3a/P3b（推送是旁路，绝不打断主流程——此处即登出）。

## 8. 后续

- 启动/解锁再注册（若接入 P2.5 回执剪枝后需要恢复投递）。
- P5 通知偏好 + locale。
