# M7 P5c-mobile — Quiet Hours UI in Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings quiet-hours editor (enable + whole-hour start/end) that reads/writes the server's `/push/quiet-hours` with the device timezone, shown when the master notifications toggle is on.

**Architecture:** Two new `StrategyApi` methods hit `GET/POST /push/quiet-hours`. A fail-safe `pushQuietHours.ts` service (injected `makeAuthedApi`, plus a `deviceTimeZone()` helper) fetches/writes without throwing. `SettingsScreen` holds `quietHours` local state (server is the sole source): fetch on enable, optimistic write on toggle/hour-pick, revert on failure, using existing `SettingRow` + `SheetSelect` + `Picker` infrastructure. New i18n keys with en/zh parity.

**Tech Stack:** Expo RN + TypeScript, jest-expo. No new dependency.

Spec: `docs/superpowers/specs/2026-07-11-m7-push-quiet-hours-mobile-design.md`

---

## Task 1: `StrategyApi.getQuietHours` / `setQuietHours`

Additive; `request<T>(path, method, body?)` already supports GET.

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/services/strategyApi.test.ts`

- [ ] **Step 1: Write the failing tests**

In `mobile/src/services/strategyApi.test.ts`, add these two tests just before the
final `});` that closes the top-level `describe("StrategyApi", ...)` block:
```ts
  it("fetches quiet hours via GET", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({ enabled: true, start: 1320, end: 480, tz: "Asia/Shanghai" }));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const qh = await api.getQuietHours();
    expect(qh).toEqual({ enabled: true, start: 1320, end: 480, tz: "Asia/Shanghai" });
    expect(fetchMock).toHaveBeenCalledWith("https://api/push/quiet-hours", expect.objectContaining({ method: "GET" }));
  });

  it("sets quiet hours via POST with the full body", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({}));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.setQuietHours({ enabled: true, start: 1320, end: 480, tz: "UTC" });
    expect(fetchMock).toHaveBeenCalledWith("https://api/push/quiet-hours", expect.objectContaining({ method: "POST" }));
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true, start: 1320, end: 480, tz: "UTC" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts`
Expected: FAIL — `api.getQuietHours` / `api.setQuietHours` are not functions.

- [ ] **Step 3: Add the two methods**

In `mobile/src/services/strategyApi.ts`, immediately after the `setPushPrefs`
method (the `return this.request<void>("/push/prefs", "POST", prefs); }`), add:
```ts
  getQuietHours() {
    return this.request<{ enabled: boolean; start: number; end: number; tz: string }>("/push/quiet-hours", "GET");
  }
  setQuietHours(qh: { enabled: boolean; start: number; end: number; tz: string }) {
    return this.request<void>("/push/quiet-hours", "POST", qh);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts && git commit -m "feat(push): StrategyApi getQuietHours/setQuietHours (GET/POST /push/quiet-hours)"
```

---

## Task 2: `pushQuietHours` fail-safe service + `deviceTimeZone`

**Files:**
- Create: `mobile/src/services/pushQuietHours.ts`
- Create: `mobile/src/services/pushQuietHours.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mobile/src/services/pushQuietHours.test.ts`:
```ts
import { fetchQuietHours, saveQuietHours, deviceTimeZone, type QuietHours } from "./pushQuietHours";

const QH: QuietHours = { enabled: true, start: 1320, end: 480, tz: "UTC" };

function apiFake(opts: { qh?: QuietHours; getThrows?: boolean; setThrows?: boolean } = {}) {
  const calls: { set: QuietHours[] } = { set: [] };
  return {
    calls,
    async getQuietHours() {
      if (opts.getThrows) throw new Error("net");
      return opts.qh ?? QH;
    },
    async setQuietHours(qh: QuietHours) {
      calls.set.push(qh);
      if (opts.setThrows) throw new Error("net");
    },
  };
}

describe("fetchQuietHours", () => {
  it("returns config on success", async () => {
    const api = apiFake({ qh: QH });
    expect(await fetchQuietHours(async () => api)).toEqual(QH);
  });

  it("returns null when there is no session", async () => {
    expect(await fetchQuietHours(async () => null)).toBeNull();
  });

  it("returns null when getQuietHours throws", async () => {
    const api = apiFake({ getThrows: true });
    expect(await fetchQuietHours(async () => api)).toBeNull();
  });
});

describe("saveQuietHours", () => {
  it("returns true and forwards the config on success", async () => {
    const api = apiFake();
    const ok = await saveQuietHours(async () => api, QH);
    expect(ok).toBe(true);
    expect(api.calls.set).toEqual([QH]);
  });

  it("returns false when there is no session", async () => {
    expect(await saveQuietHours(async () => null, QH)).toBe(false);
  });

  it("returns false when setQuietHours throws", async () => {
    const api = apiFake({ setThrows: true });
    expect(await saveQuietHours(async () => api, QH)).toBe(false);
  });
});

describe("deviceTimeZone", () => {
  it("returns a non-empty string and never throws", () => {
    const tz = deviceTimeZone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/services/pushQuietHours.test.ts`
Expected: FAIL — `Cannot find module './pushQuietHours'`.

- [ ] **Step 3: Implement the service**

Create `mobile/src/services/pushQuietHours.ts`:
```ts
import type { StrategyApi } from "./strategyApi";

export interface QuietHours {
  enabled: boolean;
  start: number; // minute-of-day 0..1439
  end: number;   // minute-of-day 0..1439
  tz: string;    // IANA timezone
}

type AuthedApi = Pick<StrategyApi, "getQuietHours" | "setQuietHours">;

/** Device IANA timezone, or "UTC" when unavailable. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Fetch quiet hours; null when there is no session or on any error. */
export async function fetchQuietHours(
  makeAuthedApi: () => Promise<AuthedApi | null>,
): Promise<QuietHours | null> {
  try {
    const api = await makeAuthedApi();
    if (!api) return null;
    return await api.getQuietHours();
  } catch {
    return null;
  }
}

/** Write quiet hours; false when there is no session or on any error. */
export async function saveQuietHours(
  makeAuthedApi: () => Promise<AuthedApi | null>,
  qh: QuietHours,
): Promise<boolean> {
  try {
    const api = await makeAuthedApi();
    if (!api) return false;
    await api.setQuietHours(qh);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/services/pushQuietHours.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/pushQuietHours.ts mobile/src/services/pushQuietHours.test.ts && git commit -m "feat(push): fail-safe pushQuietHours service + deviceTimeZone"
```

---

## Task 3: i18n keys (en + zh)

`messages.test.ts` enforces en/zh key parity.

**Files:**
- Modify: `mobile/src/i18n/messages.ts`

- [ ] **Step 1: Add the English keys**

In `mobile/src/i18n/messages.ts`, in the English block, immediately after the line
`"settings.pushPrefsFailed": "Couldn't update notification settings",` add:
```ts
    "settings.quietHours": "Quiet hours",
    "settings.quietStart": "Start",
    "settings.quietEnd": "End",
```

- [ ] **Step 2: Add the Chinese keys**

In the Chinese block, immediately after the line
`"settings.pushPrefsFailed": "通知设置更新失败",` add:
```ts
    "settings.quietHours": "免打扰时段",
    "settings.quietStart": "开始",
    "settings.quietEnd": "结束",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/i18n/messages.ts && git commit -m "i18n(push): add quiet-hours strings (quietHours/quietStart/quietEnd)"
```

---

## Task 4: Wire the quiet-hours editor into `SettingsScreen`

Thin UI wiring; validated by `tsc` + full jest suite.

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add imports**

In `mobile/src/screens/SettingsScreen.tsx`, next to the `pushCategoryPrefs` import
line, add:
```ts
import { fetchQuietHours, saveQuietHours, deviceTimeZone, type QuietHours } from "../services/pushQuietHours";
```

- [ ] **Step 2: Extend the picker type + add module-level hour options**

Change the `Picker` type (currently
`type Picker = "none" | "network" | "theme" | "locale" | "autolock";`) to:
```ts
type Picker = "none" | "network" | "theme" | "locale" | "autolock" | "qh_start" | "qh_end";
```
Immediately below that line, add a module-level constant:
```ts
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));
```

- [ ] **Step 3: Add local state**

In the component body, immediately after
`const [categoryPrefs, setCategoryPrefs] = useState<PushCategoryPrefs | null>(null);`
add:
```ts
  const [quietHours, setQuietHours] = useState<QuietHours | null>(null);
```

- [ ] **Step 4: Fetch on enable / clear on disable + write helpers**

Immediately after the existing category-prefs `useEffect` block (the one ending with
`}, [pushEnabled]);`), add a second effect and the handlers:
```ts
  useEffect(() => {
    let alive = true;
    if (!pushEnabled) {
      setQuietHours(null);
      return;
    }
    void fetchQuietHours(makeAuthedApi).then((q) => {
      if (alive) setQuietHours(q);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushEnabled]);

  async function writeQuietHours(next: QuietHours) {
    const prev = quietHours;
    setQuietHours(next);
    const ok = await saveQuietHours(makeAuthedApi, next);
    if (!ok) {
      setQuietHours(prev);
      useToastStore.getState().show(t("settings.pushPrefsFailed"), "error");
    }
  }

  function onToggleQuiet() {
    if (!quietHours) return;
    void writeQuietHours({ ...quietHours, enabled: !quietHours.enabled, tz: deviceTimeZone() });
  }

  function onPickQuietHour(which: "start" | "end", hour: number) {
    if (!quietHours) return;
    void writeQuietHours({ ...quietHours, [which]: hour * 60, tz: deviceTimeZone() });
    setPicker("none");
  }

  const fmtHour = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:00`;
```

- [ ] **Step 5: Render the quiet-hours rows**

In the JSX, immediately after the category-prefs block (the `)}` that closes
`{pushEnabled && categoryPrefs && ( ... )}`) and before the auto-lock `SettingRow`,
add:
```tsx
          {pushEnabled && quietHours && (
            <>
              <SettingRow theme={theme} icon="lock" name={t("settings.quietHours")} value={quietHours.enabled ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={onToggleQuiet} />
              {quietHours.enabled && (
                <>
                  <SettingRow theme={theme} icon="lock" name={t("settings.quietStart")} value={fmtHour(quietHours.start)} onPress={() => setPicker("qh_start")} />
                  <SettingRow theme={theme} icon="lock" name={t("settings.quietEnd")} value={fmtHour(quietHours.end)} onPress={() => setPicker("qh_end")} />
                </>
              )}
            </>
          )}
```

- [ ] **Step 6: Add the two hour SheetSelects**

Immediately after the auto-lock `SheetSelect` block (the one with
`testIDPrefix="autolock"`, ending with `/>`), and before the closing
`</ScreenScaffold>`, add:
```tsx
      <SheetSelect<string>
        visible={picker === "qh_start"}
        onClose={() => setPicker("none")}
        title={t("settings.quietStart")}
        value={String(Math.floor((quietHours?.start ?? 0) / 60))}
        onSelect={(v) => onPickQuietHour("start", Number(v))}
        sections={[{ options: HOUR_OPTIONS }]}
        theme={theme}
        testIDPrefix="qh-start"
      />
      <SheetSelect<string>
        visible={picker === "qh_end"}
        onClose={() => setPicker("none")}
        title={t("settings.quietEnd")}
        value={String(Math.floor((quietHours?.end ?? 0) / 60))}
        onSelect={(v) => onPickQuietHour("end", Number(v))}
        sections={[{ options: HOUR_OPTIONS }]}
        theme={theme}
        testIDPrefix="qh-end"
      />
```

- [ ] **Step 7: Typecheck + full test suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full jest-expo suite passes (no regressions).

- [ ] **Step 8: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/screens/SettingsScreen.tsx && git commit -m "feat(push): quiet-hours editor in Settings (enable + hour start/end)"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, replace the P5c-mobile deferred note. Replace:
```
（P5c-mobile 时段 UI 待做）
```
with:
```
；P5c-mobile 时段 UI 落地：设置页推送开启时可开关免打扰并选整点开始/结束（`StrategyApi.getQuietHours/setQuietHours` + fail-safe `pushQuietHours` 服务 + `deviceTimeZone` + SheetSelect 整点选择器，乐观写/失败回滚，保存带设备 tz）
```

- [ ] **Step 2: Full mobile validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full suite passes.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P5c-mobile quiet-hours UI landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-quiet-hours-mobile
gh pr create --title "feat(push): M7 P5c-mobile — quiet hours UI in Settings" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** StrategyApi get/set → Task 1. pushQuietHours service +
deviceTimeZone (null-on-error, false-on-error) → Task 2. i18n keys → Task 3.
Settings state + effect + write/toggle/pick handlers + rows + two hour SheetSelects
→ Task 4. Roadmap + validation → Task 5. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after.
(Task 5 Step 4 PR body-file composed at execution time.)

**Type consistency:** `QuietHours { enabled, start, end, tz }` is used identically in
strategyApi.ts (method body shape), pushQuietHours.ts, and SettingsScreen.tsx.
`getQuietHours()`/`setQuietHours(qh)` match the service's
`AuthedApi = Pick<StrategyApi, "getQuietHours" | "setQuietHours">`. `Picker` includes
`"qh_start" | "qh_end"` used by both the rows (`setPicker`) and the SheetSelects
(`picker === ...`). `HOUR_OPTIONS` value strings are hour indices `0..23`, converted
back via `Number(v) * 60` in `onPickQuietHour`, consistent with `fmtHour` dividing by
60.
