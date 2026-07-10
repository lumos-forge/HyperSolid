# M7 P3c —— 登出反注册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On sign-out, unregister the device's Expo push token server-side and clear local push prefs — before `signOut()`/`reset()` — all best-effort so sign-out never blocks.

**Architecture:** Add a small fail-safe `unregisterForSignOut(makeAuthedApi, prevToken)` to `pushToggle.ts` (reuses P3a `unregisterDeviceForPush`). Hoist SettingsScreen's `makeAuthedApi` to component scope (shared by the notifications toggle and sign-out), and call the new helper + clear `pushPrefsStore` at the top of the sign-out `onPress`, before `manager.signOut()`.

**Tech Stack:** TypeScript, jest-expo. Reuses P3a `pushRegistration`, P3b `pushPrefsStore` + `makeAuthedApi`, `walletSession.openStrategySession`.

**Reference spec:** `docs/superpowers/specs/2026-07-10-m7-push-signout-unregister-design.md`

**Branch:** `feat/m7-push-signout-unregister` (already created; spec committed).

**Verified facts (do not re-derive):**
- `pushToggle.ts` exports `applyPushPreference`; imports `registerDeviceForPush, unregisterDeviceForPush, type PushEnv` from `./pushRegistration` and `type StrategyApi` from `./strategyApi`. `AuthedApi = Pick<StrategyApi,"registerPush"|"unregisterPush">` is a local type alias already defined there.
- `unregisterDeviceForPush(api: Pick<StrategyApi,"unregisterPush">, token: string): Promise<void>` (P3a) is already best-effort (swallows errors).
- SettingsScreen currently defines `makeAuthedApi` INSIDE `onToggleNotifications` (P3b) as: `const makeAuthedApi = async () => { const local = wallet as Partial<LocalWalletService> | null; if (mode !== "local" || !local || typeof local.getViemAccount !== "function" || !baseUrl || !address) return null; const tok = await openStrategySession(new StrategyApi(baseUrl, null), local.getViemAccount(), address); return new StrategyApi(baseUrl, tok); };`. It reads `wallet`, `mode`, `address`, `baseUrl`, `pushToken`, `setPushEnabled`, `setPushToken` (all already selected in the component from P3b).
- SettingsScreen `onSignOut` onPress (current): `async () => { try { await manager.signOut(); reset(); } catch { reset(); } }`.
- Scripts: `mobile` `npm test` = jest; typecheck `npx tsc --noEmit`.

---

## File Structure

- Modify: `mobile/src/services/pushToggle.ts` — add `unregisterForSignOut`.
- Modify: `mobile/src/services/pushToggle.test.ts` — tests for it.
- Modify: `mobile/src/screens/SettingsScreen.tsx` — hoist `makeAuthedApi`, call unregister + clear prefs in `onSignOut`.

---

## Task 1: `unregisterForSignOut` helper

**Files:**
- Modify: `mobile/src/services/pushToggle.ts`
- Test: `mobile/src/services/pushToggle.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `mobile/src/services/pushToggle.test.ts` (the `apiFake` helper already exists in this file from P3b — reuse it):

```ts
import { applyPushPreference, unregisterForSignOut } from "./pushToggle";
```

(Update the existing top import line to also import `unregisterForSignOut`; the file currently imports only `applyPushPreference` from `./pushToggle`.)

Then add a new describe block:

```ts
describe("unregisterForSignOut", () => {
  it("unregisters the previous token via a minted session", async () => {
    const api = apiFake();
    await unregisterForSignOut(async () => api, "ExponentPushToken[old]");
    expect(api.calls.unregister).toEqual(["ExponentPushToken[old]"]);
  });

  it("does nothing when there is no previous token", async () => {
    const api = apiFake();
    let minted = false;
    await unregisterForSignOut(async () => { minted = true; return api; }, null);
    expect(minted).toBe(false);
    expect(api.calls.unregister).toHaveLength(0);
  });

  it("does not unregister when no session is available", async () => {
    const api = apiFake();
    await unregisterForSignOut(async () => null, "ExponentPushToken[old]");
    expect(api.calls.unregister).toHaveLength(0);
  });

  it("never throws when makeAuthedApi rejects", async () => {
    await expect(
      unregisterForSignOut(async () => { throw new Error("mint"); }, "ExponentPushToken[old]"),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/services/pushToggle.test.ts -t unregisterForSignOut`
Expected: FAIL — `unregisterForSignOut` is not exported (import error / not a function).

- [ ] **Step 3: Write minimal implementation**

In `mobile/src/services/pushToggle.ts`, add (after `applyPushPreference`):

```ts
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

(`unregisterDeviceForPush` and `AuthedApi` are already imported/defined in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/services/pushToggle.test.ts && npx tsc --noEmit`
Expected: PASS (existing `applyPushPreference` tests + 4 new `unregisterForSignOut` tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/pushToggle.ts mobile/src/services/pushToggle.test.ts && \
  git commit -m "feat(mobile): unregisterForSignOut helper (best-effort)"
```

---

## Task 2: wire into SettingsScreen sign-out

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Import the helper**

In `mobile/src/screens/SettingsScreen.tsx`, update the pushToggle import to include the new function:

```ts
import { applyPushPreference, unregisterForSignOut } from "../services/pushToggle";
```

(The current import is `import { applyPushPreference } from "../services/pushToggle";`.)

- [ ] **Step 2: Hoist `makeAuthedApi` to component scope**

Remove the `const makeAuthedApi = async () => {...}` block from inside `onToggleNotifications`, and add it once at component scope (e.g. right before `onToggleNotifications`):

```ts
  const makeAuthedApi = async () => {
    const local = wallet as Partial<LocalWalletService> | null;
    if (mode !== "local" || !local || typeof local.getViemAccount !== "function" || !baseUrl || !address) return null;
    const tok = await openStrategySession(new StrategyApi(baseUrl, null), local.getViemAccount(), address);
    return new StrategyApi(baseUrl, tok);
  };

  async function onToggleNotifications() {
    const { expoPushEnv } = await import("../services/pushEnv");
    const r = await applyPushPreference(!pushEnabled, { env: expoPushEnv(), makeAuthedApi, prevToken: pushToken });
    // ... (rest of onToggleNotifications unchanged: the if(!pushEnabled){...}else{...} block)
  }
```

Concretely: delete the inner `const makeAuthedApi = ...;` lines from `onToggleNotifications` (leaving the rest of its body intact — the `expoPushEnv` import, `applyPushPreference` call, and toast logic), since `makeAuthedApi` is now in scope from the component body.

- [ ] **Step 3: Call unregister + clear prefs in the sign-out handler**

Change the `onSignOut` onPress from:

```ts
        onPress: async () => {
          try {
            await manager.signOut();
            reset();
          } catch {
            reset();
          }
        },
```

to:

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

- [ ] **Step 4: Typecheck + SettingsScreen tests**

Run: `cd mobile && npx tsc --noEmit && npx jest src/screens/SettingsScreen.test.tsx src/services/pushToggle.test.ts`
Expected: `tsc` clean; SettingsScreen existing tests still PASS (sign-out in tests, if exercised, hits `makeAuthedApi` → returns null when no real wallet → `unregisterForSignOut` no-ops; `setPushEnabled`/`setPushToken` are safe store calls). Push tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/screens/SettingsScreen.tsx && \
  git commit -m "feat(mobile): unregister push + clear prefs on sign-out (M7 P3c)"
```

---

## Task 3: roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the roadmap M7 status**

In `docs/BACKEND-ARCHITECTURE.md`, the M7 row currently mentions `P3c 自动再注册/登出反注册` in the pending list. Replace `P3c 自动再注册/登出反注册` with `P3c 登出反注册（`unregisterForSignOut`）落地` and leave the other pending items (`P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类`). Concretely, find:

```
；P3c 自动再注册/登出反注册、P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类 待做】**
```

and replace with:

```
；P3c 登出反注册（`unregisterForSignOut`，登出时反注册设备 token + 清 pushPrefs，best-effort）落地；P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类、P3c 启动再注册（YAGNI 暂缓）待做】**
```

- [ ] **Step 2: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: mark M7 P3c 登出反注册 landed"
```

- [ ] **Step 3: Full mobile validation (no regressions)**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: typecheck clean; the whole jest suite passes.

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-signout-unregister && \
  gh pr create --title "feat(mobile): M7 P3c 登出反注册" \
    --body "M7 推送子项目 P3c。登出/删钱包时在 signOut/reset 之前反注册该设备 Expo push token（\`unregisterForSignOut\`，建会话调 /push/unregister）并清空 pushPrefs，全 best-effort、绝不阻断登出。复用 P3a unregisterDeviceForPush + P3b makeAuthedApi/pushPrefsStore。砍掉启动再注册（Expo token 稳定，YAGNI）。Spec: docs/superpowers/specs/2026-07-10-m7-push-signout-unregister-design.md"
```
Expected: PR created.

- [ ] **Step 5: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §3 helper → Task 1; §4 SettingsScreen wiring (hoist makeAuthedApi + sign-out changes) → Task 2; §5 tests (1–4) → Task 1; §6 validation → Task 3. Doc → Task 3. All covered.
- **Placeholder scan:** all code complete; the "rest unchanged" note in Task 2 Step 2 references the exact existing block and instructs a precise deletion, not a placeholder.
- **Type consistency:** `unregisterForSignOut(makeAuthedApi: () => Promise<AuthedApi|null>, prevToken: string|null): Promise<void>` matches the spec and reuses the file's existing `AuthedApi` alias + `unregisterDeviceForPush`. SettingsScreen reuses the exact `makeAuthedApi` from P3b (same guards) and existing `pushToken`/`setPushEnabled`/`setPushToken` selectors.
- **Fail-safe:** `unregisterForSignOut` wraps everything in try/catch; the sign-out handler awaits only fail-safe calls before `manager.signOut()`, and the existing `try/catch` around signOut/reset is preserved — sign-out always completes.
- **No-regression:** hoisting `makeAuthedApi` is behavior-preserving for `onToggleNotifications` (same closure over the same component vars). SettingsScreen.test does not mint a real session, so the sign-out additions no-op there.
