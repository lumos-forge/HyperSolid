# M7 P3a —— mobile 推送注册管道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the mobile push-registration core: `StrategyApi.registerPush`/`unregisterPush` methods and a pure, injectable, fail-safe `pushRegistration` service that acquires an Expo push token (via an injected `PushEnv`) and registers it with the server — no UI, no native imports.

**Architecture:** Two small additions to `mobile/`. `StrategyApi` gains `registerPush(token, platform)` / `unregisterPush(token)` reusing the existing `request<void>` (bearer auth + base URL). A new `pushRegistration.ts` exposes `registerDeviceForPush(api, env)` / `unregisterDeviceForPush(api, token)` where `env: PushEnv` is an injected seam over device/permission/token acquisition — so the service is unit-tested with fakes and never imports `expo-notifications` (the real adapter lands in P3b). Both functions are fail-safe (never throw; return a result / swallow).

**Tech Stack:** TypeScript, jest-expo. No new dependencies (expo-notifications/expo-device + app.json config land in P3b with the real adapter).

**Reference spec:** `docs/superpowers/specs/2026-07-10-m7-push-mobile-registration-design.md`

**Branch:** `feat/m7-push-mobile-registration` (already created; spec committed).

**Verified facts (do not re-derive):**
- `StrategyApi` (`mobile/src/services/strategyApi.ts`): `constructor(baseUrl, token, fetchImpl?)`; private `request<T>(path, method, body?)` sets `Authorization: Bearer <token>` when token present, sends `Content-Type: application/json`, JSON-stringifies body when defined, throws on non-ok. Existing void POST example: `confirmAgent(agentAddress) { return this.request<void>("/agent/confirm", "POST", { agentAddress }); }`.
- Test pattern (`mobile/src/services/strategyApi.test.ts`): `res(body, ok?, status?)` helper returns a fake `Response`; `new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch)`; assert via `fetchMock.mock.calls[0]` (url + init). Bearer asserted as `(init.headers as Record<string,string>).Authorization === "Bearer tok"`.
- Server routes (P1): `POST /push/register` body `{ token, platform }`; `POST /push/unregister` body `{ token }`; both authed, 204 on success.
- Scripts: `mobile` has `npm test` = `jest`; typecheck via `npx tsc --noEmit`.

---

## File Structure

- Modify: `mobile/src/services/strategyApi.ts` — add `registerPush` / `unregisterPush`.
- Modify: `mobile/src/services/strategyApi.test.ts` — tests for the two methods.
- Create: `mobile/src/services/pushRegistration.ts` — `PushEnv`, `PermStatus`, `RegisterResult`, `registerDeviceForPush`, `unregisterDeviceForPush`.
- Create: `mobile/src/services/pushRegistration.test.ts` — service tests with fakes.

---

## Task 1: StrategyApi push methods

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Test: `mobile/src/services/strategyApi.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `mobile/src/services/strategyApi.test.ts` (inside the `describe("StrategyApi", ...)` block):

```ts
  it("registers a push token with platform in the body", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({}));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.registerPush("ExponentPushToken[x]", "ios");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api/push/register",
      expect.objectContaining({ method: "POST" }),
    );
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ token: "ExponentPushToken[x]", platform: "ios" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("unregisters a push token", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({}));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.unregisterPush("ExponentPushToken[x]");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api/push/unregister",
      expect.objectContaining({ method: "POST" }),
    );
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ token: "ExponentPushToken[x]" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts -t push`
Expected: FAIL — `api.registerPush`/`api.unregisterPush` are not functions (methods don't exist).

- [ ] **Step 3: Write minimal implementation**

In `mobile/src/services/strategyApi.ts`, add the two methods (e.g. right after `revokeAgent()`):

```ts
  // push registration (M7 P3)
  registerPush(token: string, platform: string) {
    return this.request<void>("/push/register", "POST", { token, platform });
  }
  unregisterPush(token: string) {
    return this.request<void>("/push/unregister", "POST", { token });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts && npx tsc --noEmit`
Expected: PASS (new push tests + existing StrategyApi tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts && \
  git commit -m "feat(mobile): StrategyApi registerPush/unregisterPush (M7 P3a)"
```

---

## Task 2: `pushRegistration` service

**Files:**
- Create: `mobile/src/services/pushRegistration.ts`
- Test: `mobile/src/services/pushRegistration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mobile/src/services/pushRegistration.test.ts`:

```ts
import { registerDeviceForPush, unregisterDeviceForPush, type PushEnv, type PermStatus } from "./pushRegistration";

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

function apiFake(opts: { registerThrows?: boolean; unregisterThrows?: boolean } = {}) {
  const calls: { register: [string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string) {
      calls.register.push([token, platform]);
      if (opts.registerThrows) throw new Error("net");
    },
    async unregisterPush(token: string) {
      calls.unregister.push(token);
      if (opts.unregisterThrows) throw new Error("net");
    },
  };
}

describe("registerDeviceForPush", () => {
  it("skips non-devices without calling the api", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ isDevice: false }));
    expect(r).toEqual({ ok: false, reason: "not_device" });
    expect(api.calls.register).toHaveLength(0);
  });

  it("registers when permission is already granted", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["granted"], platform: "ios" }));
    expect(r).toEqual({ ok: true, token: "ExponentPushToken[tok]" });
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios"]]);
  });

  it("requests permission when undetermined then registers", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["undetermined", "granted"] }));
    expect(r.ok).toBe(true);
    expect(api.calls.register).toHaveLength(1);
  });

  it("returns permission_denied and does not call the api", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["undetermined", "denied"] }));
    expect(r).toEqual({ ok: false, reason: "permission_denied" });
    expect(api.calls.register).toHaveLength(0);
  });

  it("returns error when getExpoPushToken throws (never throws)", async () => {
    const api = apiFake();
    const env = envFake({ getExpoPushToken: async () => { throw new Error("no token"); } });
    const r = await registerDeviceForPush(api, env);
    expect(r).toEqual({ ok: false, reason: "error" });
  });

  it("returns error when registerPush throws (never throws)", async () => {
    const api = apiFake({ registerThrows: true });
    const r = await registerDeviceForPush(api, envFake());
    expect(r).toEqual({ ok: false, reason: "error" });
  });
});

describe("unregisterDeviceForPush", () => {
  it("calls the api unregister", async () => {
    const api = apiFake();
    await unregisterDeviceForPush(api, "ExponentPushToken[tok]");
    expect(api.calls.unregister).toEqual(["ExponentPushToken[tok]"]);
  });

  it("swallows errors from the api", async () => {
    const api = apiFake({ unregisterThrows: true });
    await expect(unregisterDeviceForPush(api, "ExponentPushToken[tok]")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/services/pushRegistration.test.ts`
Expected: FAIL — cannot find module `./pushRegistration`.

- [ ] **Step 3: Write minimal implementation**

Create `mobile/src/services/pushRegistration.ts`:

```ts
import type { StrategyApi } from "./strategyApi";

export type PermStatus = "granted" | "denied" | "undetermined";

/** Injected seam over device / notification-permission / token acquisition, so the
 *  registration flow is unit-testable and never imports expo-notifications directly
 *  (the real adapter lands in P3b). */
export interface PushEnv {
  isDevice: boolean;
  platform: string;
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
    await api.registerPush(token, env.platform);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/services/pushRegistration.test.ts && npx tsc --noEmit`
Expected: PASS (8 tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/pushRegistration.ts mobile/src/services/pushRegistration.test.ts && \
  git commit -m "feat(mobile): fail-safe pushRegistration service (injected PushEnv)"
```

---

## Task 3: roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the roadmap M7 status**

In `docs/BACKEND-ARCHITECTURE.md`, the M7 row currently ends (from P4):

```
；P3 mobile 注册、P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类 待做】**
```

Replace that tail with:

```
；P3a mobile 注册管道落地：`StrategyApi.registerPush`/`unregisterPush` + fail-safe `registerDeviceForPush`（注入 PushEnv，`mobile/src/services/pushRegistration.ts`）；P3b 设置 toggle+启动接线+expo-notifications 依赖、P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类 待做】**
```

- [ ] **Step 2: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: mark M7 P3a mobile 注册管道 landed"
```

- [ ] **Step 3: Full mobile validation (no regressions)**

Run:
```bash
cd mobile && npx tsc --noEmit && npx jest src/services/pushRegistration.test.ts src/services/strategyApi.test.ts
```
Expected: typecheck clean; new push tests + strategyApi tests pass.

- [ ] **Step 4: Full mobile jest suite (baseline not lowered)**

Run: `cd mobile && npm test`
Expected: the whole jest suite passes (push additions did not break existing tests).

- [ ] **Step 5: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-mobile-registration && \
  gh pr create --title "feat(mobile): M7 P3a 推送注册管道（无 UI）" \
    --body "M7 推送子项目 P3a。mobile 端注册核心：\`StrategyApi.registerPush\`/\`unregisterPush\`（POST /push/register·/push/unregister，带 bearer）+ 纯可注入 fail-safe \`registerDeviceForPush(api, env)\`（非真机跳过 / 权限请求 / 取 Expo token → registerPush；任何异常返回 {ok:false,reason} 绝不抛）+ best-effort \`unregisterDeviceForPush\`。被测服务用注入 \`PushEnv\`，不直接 import expo-notifications——依赖/app.json/真实适配器/UI/偏好归 P3b。Spec: docs/superpowers/specs/2026-07-10-m7-push-mobile-registration-design.md"
```
Expected: PR created.

- [ ] **Step 6: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §5 StrategyApi methods → Task 1; §6 service (`PushEnv`/`RegisterResult`/`registerDeviceForPush`/`unregisterDeviceForPush`, fail-safe flow §6.1–6.2) → Task 2; §7 tests (service 1–7, api 8–9) → Tasks 1–2 (api tests in Task 1, service tests in Task 2); §8 validation → Task 3. §2/§4 non-goals respected (no deps/app.json/UI/adapter). Doc note → Task 3. All covered.
- **Placeholder scan:** all code complete; fakes fully written.
- **Type consistency:** `PermStatus`, `PushEnv` (isDevice/platform/getPermissionStatus/requestPermission/getExpoPushToken), `RegisterResult` union, `registerDeviceForPush(api: Pick<StrategyApi,"registerPush">, env)`, `unregisterDeviceForPush(api: Pick<StrategyApi,"unregisterPush">, token)`, StrategyApi `registerPush(token, platform)`/`unregisterPush(token)` — identical across service, tests, and StrategyApi, matching the spec.
- **Fail-safe:** `registerDeviceForPush` wraps steps 2–5 in try/catch (token/register failures → `error`); the `not_device`/`permission_denied` short-circuits return before the api call; `unregisterDeviceForPush` swallows. Tests 5–7 assert never-throws.
- **No native import:** `pushRegistration.ts` imports only the `StrategyApi` type; no `expo-notifications`/`expo-device` — safe under jest-expo.
