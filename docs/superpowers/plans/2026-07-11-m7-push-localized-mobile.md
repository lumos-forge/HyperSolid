# M7 P5a-mobile — Report Device Locale at Push Registration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report the user's active UI locale (`en`/`zh`) when the mobile app registers a device push token, so the P5a-server backend localizes subsequent push notifications for that device.

**Architecture:** Add a `locale` parameter to `StrategyApi.registerPush`, a required `locale` field to the injectable `PushEnv` seam, thread it through `registerDeviceForPush`, and populate it in the real `expoPushEnv()` adapter from `useLocaleStore`. Because `PushEnv` gains a required field and `registerPush` gains a parameter, the production change plus all `PushEnv`-constructing tests must change together to compile — so it lands as one atomic commit.

**Tech Stack:** Expo RN + TypeScript, Zustand (`useLocaleStore`), jest-expo.

Spec: `docs/superpowers/specs/2026-07-11-m7-push-localized-mobile-design.md`

---

## Task 1: Thread device locale into push registration (atomic)

One coordinated commit: the `registerPush` signature, the `PushEnv` interface, the two call sites, the real adapter, and every test that constructs a `PushEnv` or asserts a `registerPush` call must change together to typecheck.

**Files:**
- Modify: `mobile/src/services/strategyApi.ts` (registerPush signature + body)
- Modify: `mobile/src/services/strategyApi.test.ts` (registerPush body assertion)
- Modify: `mobile/src/services/pushRegistration.ts` (`PushEnv.locale` + `registerDeviceForPush` call)
- Modify: `mobile/src/services/pushRegistration.test.ts` (envFake + apiFake + assertions)
- Modify: `mobile/src/services/pushToggle.test.ts` (envFake + apiFake + assertions)
- Modify: `mobile/src/services/pushEnv.ts` (real adapter reads `useLocaleStore`)

- [ ] **Step 1: Update the tests to the new shape (they must fail to compile first)**

(a) `mobile/src/services/strategyApi.test.ts` — in the test titled `"registers a push token with platform in the body"`, change the call and the body assertion to include `locale`:

Replace:
```ts
    await api.registerPush("ExponentPushToken[x]", "ios");
```
with:
```ts
    await api.registerPush("ExponentPushToken[x]", "ios", "zh");
```

Replace:
```ts
    expect(JSON.parse(init.body as string)).toEqual({ token: "ExponentPushToken[x]", platform: "ios" });
```
with:
```ts
    expect(JSON.parse(init.body as string)).toEqual({ token: "ExponentPushToken[x]", platform: "ios", locale: "zh" });
```

(b) `mobile/src/services/pushRegistration.test.ts` — add `locale` to `envFake` and make `apiFake` capture a 3-tuple; then assert the locale is forwarded.

Replace the `envFake` return object:
```ts
  return {
    isDevice: over.isDevice ?? true,
    platform: over.platform ?? "ios",
    getPermissionStatus: over.getPermissionStatus ?? (async () => permSeq[Math.min(i, permSeq.length - 1)]),
    requestPermission: over.requestPermission ?? (async () => { i = 1; return permSeq[Math.min(i, permSeq.length - 1)]; }),
    getExpoPushToken: over.getExpoPushToken ?? (async () => "ExponentPushToken[tok]"),
  };
```
with (adds `locale`):
```ts
  return {
    isDevice: over.isDevice ?? true,
    platform: over.platform ?? "ios",
    locale: over.locale ?? "en",
    getPermissionStatus: over.getPermissionStatus ?? (async () => permSeq[Math.min(i, permSeq.length - 1)]),
    requestPermission: over.requestPermission ?? (async () => { i = 1; return permSeq[Math.min(i, permSeq.length - 1)]; }),
    getExpoPushToken: over.getExpoPushToken ?? (async () => "ExponentPushToken[tok]"),
  };
```

Replace the `apiFake` `register` tuple type and `registerPush` to capture locale:
```ts
  const calls: { register: [string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string) {
      calls.register.push([token, platform]);
      if (opts.registerThrows) throw new Error("net");
    },
```
with:
```ts
  const calls: { register: [string, string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string, locale: string) {
      calls.register.push([token, platform, locale]);
      if (opts.registerThrows) throw new Error("net");
    },
```

Update the two existing register-tuple assertions (they currently expect 2-tuples):

Replace:
```ts
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["granted"], platform: "ios" }));
    expect(r).toEqual({ ok: true, token: "ExponentPushToken[tok]" });
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios"]]);
```
with (also passes an explicit `zh` locale to prove it is forwarded):
```ts
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["granted"], platform: "ios", locale: "zh" }));
    expect(r).toEqual({ ok: true, token: "ExponentPushToken[tok]" });
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios", "zh"]]);
```

(c) `mobile/src/services/pushToggle.test.ts` — add `locale` to its `envFake` and make its `apiFake` register capture the 3rd arg; update the enable assertion.

Replace the `envFake` return object:
```ts
  return {
    isDevice: over.isDevice ?? true,
    platform: over.platform ?? "ios",
    getPermissionStatus: over.getPermissionStatus ?? (async () => permSeq[Math.min(i, permSeq.length - 1)]),
    requestPermission: over.requestPermission ?? (async () => { i = 1; return permSeq[Math.min(i, permSeq.length - 1)]; }),
    getExpoPushToken: over.getExpoPushToken ?? (async () => "ExponentPushToken[tok]"),
  };
```
with:
```ts
  return {
    isDevice: over.isDevice ?? true,
    platform: over.platform ?? "ios",
    locale: over.locale ?? "en",
    getPermissionStatus: over.getPermissionStatus ?? (async () => permSeq[Math.min(i, permSeq.length - 1)]),
    requestPermission: over.requestPermission ?? (async () => { i = 1; return permSeq[Math.min(i, permSeq.length - 1)]; }),
    getExpoPushToken: over.getExpoPushToken ?? (async () => "ExponentPushToken[tok]"),
  };
```

Replace the `apiFake`:
```ts
function apiFake() {
  const calls: { register: [string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string) { calls.register.push([token, platform]); },
    async unregisterPush(token: string) { calls.unregister.push(token); },
  };
}
```
with:
```ts
function apiFake() {
  const calls: { register: [string, string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string, locale: string) { calls.register.push([token, platform, locale]); },
    async unregisterPush(token: string) { calls.unregister.push(token); },
  };
}
```

Update the enable-path assertion:

Replace:
```ts
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios"]]);
```
with:
```ts
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios", "en"]]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts src/services/pushRegistration.test.ts src/services/pushToggle.test.ts`
Expected: FAIL — `registerPush` still takes 2 args and `PushEnv` has no `locale`, so assertions/compile fail.

- [ ] **Step 3: Add the `locale` parameter to `StrategyApi.registerPush`**

In `mobile/src/services/strategyApi.ts`, replace:
```ts
  registerPush(token: string, platform: string) {
    return this.request<void>("/push/register", "POST", { token, platform });
  }
```
with:
```ts
  registerPush(token: string, platform: string, locale: string) {
    return this.request<void>("/push/register", "POST", { token, platform, locale });
  }
```

- [ ] **Step 4: Add `locale` to the `PushEnv` seam and forward it**

In `mobile/src/services/pushRegistration.ts`, add `locale` to the interface. Replace:
```ts
export interface PushEnv {
  isDevice: boolean;
  platform: string;
  getPermissionStatus(): Promise<PermStatus>;
  requestPermission(): Promise<PermStatus>;
  getExpoPushToken(): Promise<string>;
}
```
with:
```ts
export interface PushEnv {
  isDevice: boolean;
  platform: string;
  /** Active UI locale reported to the server so push is localized for this device. */
  locale: string;
  getPermissionStatus(): Promise<PermStatus>;
  requestPermission(): Promise<PermStatus>;
  getExpoPushToken(): Promise<string>;
}
```

In the same file, forward the locale in `registerDeviceForPush`. Replace:
```ts
    await api.registerPush(token, env.platform);
```
with:
```ts
    await api.registerPush(token, env.platform, env.locale);
```

- [ ] **Step 5: Populate `locale` in the real adapter**

In `mobile/src/services/pushEnv.ts`, import the locale store and set the field. Replace the import block:
```ts
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { PushEnv, PermStatus } from "./pushRegistration";
```
with:
```ts
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { PushEnv, PermStatus } from "./pushRegistration";
import { useLocaleStore } from "../state/localeStore";
```

Replace the returned object's leading fields:
```ts
  return {
    isDevice: Device.isDevice,
    platform: Platform.OS,
    getPermissionStatus: async () => toStatus((await Notifications.getPermissionsAsync()).status),
```
with (adds `locale`, read once at construction):
```ts
  return {
    isDevice: Device.isDevice,
    platform: Platform.OS,
    locale: useLocaleStore.getState().locale,
    getPermissionStatus: async () => toStatus((await Notifications.getPermissionsAsync()).status),
```

- [ ] **Step 6: Run the tests + typecheck to verify they pass**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts src/services/pushRegistration.test.ts src/services/pushToggle.test.ts && npx tsc --noEmit`
Expected: PASS (all three suites) and `tsc` clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts mobile/src/services/pushRegistration.ts mobile/src/services/pushRegistration.test.ts mobile/src/services/pushToggle.test.ts mobile/src/services/pushEnv.ts && git commit -m "feat(push): report device locale at push registration (P5a-mobile)"
```

---

## Task 2: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md` (M7 row: note P5a-mobile landed)

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, find the M7 row text that ends the P5a-server note with `P5a-mobile 注册上报 locale、` in the deferred list and move it to the landed list. Replace:
```
（同 locale 缓存、缺失→en 零回归，`server/src/push/notifier.ts`）；P5a-mobile 注册上报 locale、P5b 分类开关
```
with:
```
（同 locale 缓存、缺失→en 零回归，`server/src/push/notifier.ts`）；P5a-mobile 注册上报 locale 落地：`StrategyApi.registerPush(token, platform, locale)` + `PushEnv.locale` 快照 + `registerDeviceForPush` 透传 + `expoPushEnv()` 读 `useLocaleStore`（切语言后需重开推送才更新，YAGNI）；P5b 分类开关
```

- [ ] **Step 2: Full mobile validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full jest-expo suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P5a-mobile locale reporting landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-localized-mobile
gh pr create --title "feat(push): M7 P5a-mobile — report device locale at push registration" --body "<summary of the change, fail-safe notes, tests>"
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** All four spec touch points are covered by Task 1 (registerPush param → Step 3; PushEnv.locale → Step 4; registerDeviceForPush forward → Step 4; expoPushEnv locale → Step 5). Testing requirements → Steps 1–2, 6. Roadmap/out-of-scope → Task 2. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after. (Task 2 Step 4 PR body is intentionally a template — content composed at execution time.)

**Type consistency:** `registerPush(token, platform, locale)` and `PushEnv.locale: string` are used consistently across strategyApi.ts, pushRegistration.ts, pushEnv.ts, and all three test files. `apiFake.calls.register` is a `[string, string, string][]` everywhere it is redefined.
