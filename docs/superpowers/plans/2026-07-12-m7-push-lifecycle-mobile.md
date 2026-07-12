# M7 P4.5-mobile — Lifecycle Category Toggle in Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third Settings category toggle (`lifecycle` / Strategy completed) reading and editing the server's `/push/prefs.lifecycle`, mirroring the existing fills/alerts rows.

**Architecture:** Widen `PushCategoryPrefs` and the `StrategyApi` prefs shapes to include `lifecycle`; add a third `SettingRow` + widen `onToggleCategory` in `SettingsScreen`; add one i18n key. Optimistic-write + revert logic is reused unchanged.

**Tech Stack:** Expo RN + TypeScript, jest-expo.

Spec: `docs/superpowers/specs/2026-07-12-m7-push-lifecycle-mobile-design.md`

---

## Task 1: Widen the prefs shapes (service + API) with lifecycle

Widening `PushCategoryPrefs` requires the test fakes to include `lifecycle`, so the
type change + tests land together.

**Files:**
- Modify: `mobile/src/services/pushCategoryPrefs.ts`
- Modify: `mobile/src/services/pushCategoryPrefs.test.ts`
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/services/strategyApi.test.ts`

- [ ] **Step 1: Update the tests to the lifecycle shape**

(a) `mobile/src/services/pushCategoryPrefs.test.ts` — widen the `apiFake` prefs shape
and add a lifecycle forward test. Replace:
```ts
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
```
with:
```ts
function apiFake(opts: { prefs?: { fills: boolean; alerts: boolean; lifecycle: boolean }; getThrows?: boolean; setThrows?: boolean } = {}) {
  const calls: { set: Array<Partial<{ fills: boolean; alerts: boolean; lifecycle: boolean }>> } = { set: [] };
  return {
    calls,
    async getPushPrefs() {
      if (opts.getThrows) throw new Error("net");
      return opts.prefs ?? { fills: true, alerts: true, lifecycle: true };
    },
    async setPushPrefs(prefs: Partial<{ fills: boolean; alerts: boolean; lifecycle: boolean }>) {
      calls.set.push(prefs);
      if (opts.setThrows) throw new Error("net");
    },
  };
}
```
Update the "returns prefs on success" test to use a full shape. Replace:
```ts
    const api = apiFake({ prefs: { fills: true, alerts: false } });
    const r = await fetchPushCategoryPrefs(async () => api);
    expect(r).toEqual({ fills: true, alerts: false });
```
with:
```ts
    const api = apiFake({ prefs: { fills: true, alerts: false, lifecycle: true } });
    const r = await fetchPushCategoryPrefs(async () => api);
    expect(r).toEqual({ fills: true, alerts: false, lifecycle: true });
```
Add a new test inside `describe("setPushCategoryPrefs", ...)`:
```ts
  it("forwards a lifecycle toggle", async () => {
    const api = apiFake();
    const ok = await setPushCategoryPrefs(async () => api, { lifecycle: false });
    expect(ok).toBe(true);
    expect(api.calls.set).toEqual([{ lifecycle: false }]);
  });
```

(b) `mobile/src/services/strategyApi.test.ts` — include lifecycle in the prefs
mock/assertions. Replace:
```ts
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({ fills: true, alerts: false }));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const prefs = await api.getPushPrefs();
    expect(prefs).toEqual({ fills: true, alerts: false });
```
with:
```ts
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({ fills: true, alerts: false, lifecycle: true }));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const prefs = await api.getPushPrefs();
    expect(prefs).toEqual({ fills: true, alerts: false, lifecycle: true });
```
Replace:
```ts
    await api.setPushPrefs({ fills: false });
    expect(fetchMock).toHaveBeenCalledWith("https://api/push/prefs", expect.objectContaining({ method: "POST" }));
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ fills: false });
```
with:
```ts
    await api.setPushPrefs({ lifecycle: false });
    expect(fetchMock).toHaveBeenCalledWith("https://api/push/prefs", expect.objectContaining({ method: "POST" }));
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ lifecycle: false });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest src/services/pushCategoryPrefs.test.ts src/services/strategyApi.test.ts`
Expected: FAIL — `PushCategoryPrefs` / `getPushPrefs` shapes don't yet include
`lifecycle` (type/assertion mismatch).

- [ ] **Step 3: Widen `PushCategoryPrefs`**

In `mobile/src/services/pushCategoryPrefs.ts`, replace:
```ts
export interface PushCategoryPrefs {
  fills: boolean;
  alerts: boolean;
}
```
with:
```ts
export interface PushCategoryPrefs {
  fills: boolean;
  alerts: boolean;
  lifecycle: boolean;
}
```

- [ ] **Step 4: Widen the `StrategyApi` prefs methods**

In `mobile/src/services/strategyApi.ts`, replace:
```ts
  getPushPrefs() {
    return this.request<{ fills: boolean; alerts: boolean }>("/push/prefs", "GET");
  }
  setPushPrefs(prefs: { fills?: boolean; alerts?: boolean }) {
    return this.request<void>("/push/prefs", "POST", prefs);
  }
```
with:
```ts
  getPushPrefs() {
    return this.request<{ fills: boolean; alerts: boolean; lifecycle: boolean }>("/push/prefs", "GET");
  }
  setPushPrefs(prefs: { fills?: boolean; alerts?: boolean; lifecycle?: boolean }) {
    return this.request<void>("/push/prefs", "POST", prefs);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mobile && npx jest src/services/pushCategoryPrefs.test.ts src/services/strategyApi.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/pushCategoryPrefs.ts mobile/src/services/pushCategoryPrefs.test.ts mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts && git commit -m "feat(push): add lifecycle to mobile category prefs shapes"
```

---

## Task 2: i18n key

`messages.test.ts` enforces en/zh parity.

**Files:**
- Modify: `mobile/src/i18n/messages.ts`

- [ ] **Step 1: Add the English key**

In `mobile/src/i18n/messages.ts`, in the English block, immediately after the line
`"settings.notifyAlerts": "Protection alerts",` add:
```ts
    "settings.notifyLifecycle": "Strategy completed",
```

- [ ] **Step 2: Add the Chinese key**

In the Chinese block, immediately after the line `"settings.notifyAlerts": "保护告警",`
add:
```ts
    "settings.notifyLifecycle": "策略完成",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/i18n/messages.ts && git commit -m "i18n(push): add notifyLifecycle string (en/zh)"
```

---

## Task 3: Third category row in SettingsScreen

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Widen the toggle handler category type**

In `mobile/src/screens/SettingsScreen.tsx`, replace:
```ts
  async function onToggleCategory(cat: "fills" | "alerts") {
```
with:
```ts
  async function onToggleCategory(cat: "fills" | "alerts" | "lifecycle") {
```

- [ ] **Step 2: Add the lifecycle row**

In the JSX, immediately after the `notifyAlerts` `SettingRow` (the line rendering
`t("settings.notifyAlerts")` with `onPress={() => onToggleCategory("alerts")}`), add:
```tsx
              <SettingRow theme={theme} icon="alert" name={t("settings.notifyLifecycle")} value={categoryPrefs.lifecycle ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={() => onToggleCategory("lifecycle")} />
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full jest-expo suite passes (no regressions).

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/screens/SettingsScreen.tsx && git commit -m "feat(push): lifecycle category toggle row in Settings"
```

---

## Task 4: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, replace the P4.5-mobile deferred note. Replace:
```
（P4.5-mobile 开关 UI 待做）
```
with:
```
；P4.5-mobile 开关 UI 落地：设置页第三个类别开关「策略完成」（`PushCategoryPrefs.lifecycle` + `StrategyApi` get/set 含 lifecycle + SettingRow，复用乐观写/失败回滚）
```

(If the surrounding text differs, replace only the literal `（P4.5-mobile 开关 UI 待做）`.)

- [ ] **Step 2: Full mobile validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full suite passes.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P4.5-mobile lifecycle toggle landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-lifecycle-mobile
gh pr create --title "feat(push): M7 P4.5-mobile — lifecycle category toggle in Settings" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** `PushCategoryPrefs.lifecycle` → Task 1. `StrategyApi` get/set
lifecycle → Task 1. i18n `notifyLifecycle` → Task 2. `onToggleCategory` widening +
third row → Task 3. Roadmap + validation → Task 4. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after.
(Task 4 Step 4 PR body-file composed at execution time.)

**Type consistency:** `PushCategoryPrefs { fills, alerts, lifecycle }` is used
identically in pushCategoryPrefs.ts and SettingsScreen.tsx (`categoryPrefs.lifecycle`,
`onToggleCategory("lifecycle")`). `getPushPrefs()` returns
`{ fills, alerts, lifecycle }` and `setPushPrefs(prefs: { fills?, alerts?, lifecycle? })`
match the service's `AuthedApi = Pick<StrategyApi, "getPushPrefs" | "setPushPrefs">`
and the server's `/push/prefs` contract. The row's `t("settings.notifyLifecycle")`
matches the i18n key added in Task 2.
