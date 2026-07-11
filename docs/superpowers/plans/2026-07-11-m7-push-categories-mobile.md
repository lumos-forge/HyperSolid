# M7 P5b-mobile — Category Toggle UI in Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two Settings rows (成交通知 / 保护告警) that read and edit the server's per-owner push category preferences via `GET/POST /push/prefs`, shown when the master notifications toggle is on.

**Architecture:** Two new `StrategyApi` methods hit `GET/POST /push/prefs`. A fail-safe `pushCategoryPrefs.ts` service (injected `makeAuthedApi`, mirroring `pushToggle.ts`) fetches/writes prefs without throwing. `SettingsScreen` holds `categoryPrefs` local state (server is the sole source): fetch on enable, optimistic flip on tap, revert on failure. New i18n keys with en/zh parity.

**Tech Stack:** Expo RN + TypeScript, jest-expo.

Spec: `docs/superpowers/specs/2026-07-11-m7-push-categories-mobile-design.md`

---

## Task 1: `StrategyApi.getPushPrefs` / `setPushPrefs`

Additive, no ripple. `request<T>(path, method, body?)` already supports GET (see `getStatus`).

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/services/strategyApi.test.ts`

- [ ] **Step 1: Write the failing tests**

In `mobile/src/services/strategyApi.test.ts`, add these two tests just before the
final `});` that closes the top-level `describe("StrategyApi", ...)` block:
```ts
  it("fetches push prefs via GET", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({ fills: true, alerts: false }));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const prefs = await api.getPushPrefs();
    expect(prefs).toEqual({ fills: true, alerts: false });
    expect(fetchMock).toHaveBeenCalledWith("https://api/push/prefs", expect.objectContaining({ method: "GET" }));
  });

  it("sets push prefs via POST with the partial body", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({}));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.setPushPrefs({ fills: false });
    expect(fetchMock).toHaveBeenCalledWith("https://api/push/prefs", expect.objectContaining({ method: "POST" }));
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ fills: false });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts`
Expected: FAIL — `api.getPushPrefs` / `api.setPushPrefs` are not functions.

- [ ] **Step 3: Add the two methods**

In `mobile/src/services/strategyApi.ts`, immediately after the `unregisterPush`
method (the `return this.request<void>("/push/unregister", "POST", { token }); }`),
add:
```ts
  getPushPrefs() {
    return this.request<{ fills: boolean; alerts: boolean }>("/push/prefs", "GET");
  }
  setPushPrefs(prefs: { fills?: boolean; alerts?: boolean }) {
    return this.request<void>("/push/prefs", "POST", prefs);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts && git commit -m "feat(push): StrategyApi getPushPrefs/setPushPrefs (GET/POST /push/prefs)"
```

---

## Task 2: `pushCategoryPrefs` fail-safe service

**Files:**
- Create: `mobile/src/services/pushCategoryPrefs.ts`
- Create: `mobile/src/services/pushCategoryPrefs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mobile/src/services/pushCategoryPrefs.test.ts`:
```ts
import { fetchPushCategoryPrefs, setPushCategoryPrefs } from "./pushCategoryPrefs";

function apiFake(opts: { prefs?: { fills: boolean; alerts: boolean }; getThrows?: boolean; setThrows?: boolean } = {}) {
  const calls: { set: Array<Partial<{ fills: boolean; alerts: boolean }>> } = { set: [] };
  return {
    calls,
    async getPushPrefs() {
      if (opts.getThrows) throw new Error("net");
      return opts.prefs ?? { fills: true, alerts: true };
    },
    async setPushPrefs(prefs: Partial<{ fills: boolean; alerts: boolean }>) {
      calls.set.push(prefs);
      if (opts.setThrows) throw new Error("net");
    },
  };
}

describe("fetchPushCategoryPrefs", () => {
  it("returns prefs on success", async () => {
    const api = apiFake({ prefs: { fills: true, alerts: false } });
    const r = await fetchPushCategoryPrefs(async () => api);
    expect(r).toEqual({ fills: true, alerts: false });
  });

  it("returns null when there is no session", async () => {
    const r = await fetchPushCategoryPrefs(async () => null);
    expect(r).toBeNull();
  });

  it("returns null when getPushPrefs throws", async () => {
    const api = apiFake({ getThrows: true });
    const r = await fetchPushCategoryPrefs(async () => api);
    expect(r).toBeNull();
  });
});

describe("setPushCategoryPrefs", () => {
  it("returns true and forwards the partial on success", async () => {
    const api = apiFake();
    const ok = await setPushCategoryPrefs(async () => api, { fills: false });
    expect(ok).toBe(true);
    expect(api.calls.set).toEqual([{ fills: false }]);
  });

  it("returns false when there is no session", async () => {
    const ok = await setPushCategoryPrefs(async () => null, { alerts: false });
    expect(ok).toBe(false);
  });

  it("returns false when setPushPrefs throws", async () => {
    const api = apiFake({ setThrows: true });
    const ok = await setPushCategoryPrefs(async () => api, { fills: true });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/services/pushCategoryPrefs.test.ts`
Expected: FAIL — `Cannot find module './pushCategoryPrefs'`.

- [ ] **Step 3: Implement the service**

Create `mobile/src/services/pushCategoryPrefs.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/services/pushCategoryPrefs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/pushCategoryPrefs.ts mobile/src/services/pushCategoryPrefs.test.ts && git commit -m "feat(push): fail-safe pushCategoryPrefs service (fetch/set)"
```

---

## Task 3: i18n keys (en + zh)

`messages.test.ts` enforces en/zh key parity, so both blocks must gain the same keys.

**Files:**
- Modify: `mobile/src/i18n/messages.ts`

- [ ] **Step 1: Add the English keys**

In `mobile/src/i18n/messages.ts`, in the English block, immediately after the line
`"settings.notificationsOff": "Off",` add:
```ts
    "settings.notifyFills": "Fill notifications",
    "settings.notifyAlerts": "Protection alerts",
    "settings.pushPrefsFailed": "Couldn't update notification settings",
```

- [ ] **Step 2: Add the Chinese keys**

In the Chinese block, immediately after the line `"settings.notificationsOff": "关",`
add:
```ts
    "settings.notifyFills": "成交通知",
    "settings.notifyAlerts": "保护告警",
    "settings.pushPrefsFailed": "通知设置更新失败",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS (en/zh key sets match).

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/i18n/messages.ts && git commit -m "i18n(push): add category-toggle strings (fills/alerts/failed)"
```

---

## Task 4: Wire the category rows into `SettingsScreen`

Thin UI wiring; validated by `tsc` + full jest suite (no bespoke screen test).

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add imports**

In `mobile/src/screens/SettingsScreen.tsx`, change the React import (currently
`import React, { useMemo, useState } from "react";`) to include `useEffect`:
```ts
import React, { useMemo, useState, useEffect } from "react";
```
And add, next to the `applyPushPreference` import line, a new import:
```ts
import { fetchPushCategoryPrefs, setPushCategoryPrefs, type PushCategoryPrefs } from "../services/pushCategoryPrefs";
```

- [ ] **Step 2: Add local state**

In the component body, immediately after the existing
`const [copied, setCopied] = useState(false);` line, add:
```ts
  const [categoryPrefs, setCategoryPrefs] = useState<PushCategoryPrefs | null>(null);
```

- [ ] **Step 3: Fetch on enable / clear on disable**

Immediately after the `onToggleNotifications` function definition (the block ending
with the `useToastStore.getState().show(t("settings.pushDisabled"), "success");`
branch and its closing `}`), add:
```ts
  useEffect(() => {
    let alive = true;
    if (!pushEnabled) {
      setCategoryPrefs(null);
      return;
    }
    void fetchPushCategoryPrefs(makeAuthedApi).then((p) => {
      if (alive) setCategoryPrefs(p);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushEnabled]);

  async function onToggleCategory(cat: "fills" | "alerts") {
    if (!categoryPrefs) return;
    const next = !categoryPrefs[cat];
    setCategoryPrefs({ ...categoryPrefs, [cat]: next });
    const ok = await setPushCategoryPrefs(makeAuthedApi, { [cat]: next });
    if (!ok) {
      setCategoryPrefs((p) => (p ? { ...p, [cat]: !next } : p));
      useToastStore.getState().show(t("settings.pushPrefsFailed"), "error");
    }
  }
```

- [ ] **Step 4: Render the two category rows**

In the JSX, immediately after the notifications `SettingRow` (the line
`<SettingRow theme={theme} icon="alert" name={t("settings.notifications")} value={pushEnabled ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={onToggleNotifications} />`),
add:
```tsx
          {pushEnabled && categoryPrefs && (
            <>
              <SettingRow theme={theme} icon="alert" name={t("settings.notifyFills")} value={categoryPrefs.fills ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={() => onToggleCategory("fills")} />
              <SettingRow theme={theme} icon="alert" name={t("settings.notifyAlerts")} value={categoryPrefs.alerts ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={() => onToggleCategory("alerts")} />
            </>
          )}
```

- [ ] **Step 5: Typecheck + full test suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full jest-expo suite passes (no regressions).

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/screens/SettingsScreen.tsx && git commit -m "feat(push): category toggle rows in Settings (fills/alerts)"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, replace the P5b-mobile deferred note. Replace:
```
（P5b-mobile 子开关 UI 待做）
```
with:
```
；P5b-mobile 子开关 UI 落地：设置页推送开启时显示「成交通知/保护告警」两行（`StrategyApi.getPushPrefs/setPushPrefs` + fail-safe `pushCategoryPrefs` 服务 + 进入拉取/乐观写/失败回滚，服务器为唯一来源）
```

- [ ] **Step 2: Full mobile validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full suite passes.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P5b-mobile category toggle UI landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-categories-mobile
gh pr create --title "feat(push): M7 P5b-mobile — category toggle UI in Settings" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** StrategyApi get/set → Task 1. pushCategoryPrefs service (fetch
null-on-error, set false-on-error) → Task 2. i18n keys → Task 3. Settings state +
effect + rows + optimistic/revert handler → Task 4. Roadmap + validation → Task 5.
No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after.
(Task 5 Step 4 PR body-file composed at execution time.)

**Type consistency:** `PushCategoryPrefs { fills: boolean; alerts: boolean }` is used
identically in pushCategoryPrefs.ts and SettingsScreen.tsx. `getPushPrefs()` returns
`{ fills, alerts }` and `setPushPrefs(prefs: { fills?, alerts? })` match the service's
`AuthedApi = Pick<StrategyApi, "getPushPrefs" | "setPushPrefs">` and the server routes.
`onToggleCategory(cat: "fills" | "alerts")` keys match `PushCategoryPrefs`.
