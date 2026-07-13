# M8 Routing Preference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted `RoutingMode` preference (`auto`/`direct`/`proxy`, default `auto`) with a Settings picker, mirroring `localeStore` + the Settings `SheetSelect` pattern. Preference-only; does not yet route requests.

**Architecture:** A zustand `useRoutingStore` (device-bound SecureStore persistence, hydrated at launch) plus a `SheetSelect` in `SettingsScreen`; identical lifecycle to `localeStore`.

**Tech Stack:** Expo RN + TypeScript, zustand, expo-secure-store, jest-expo + @testing-library/react-native, i18n via `useT()` (en default, en+zh parity enforced).

Spec: `docs/superpowers/specs/2026-07-13-m8-routing-preference-design.md`
Branch: `feat/m8-routing-preference`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: `routingStore` (TDD)

**Files:**
- Create: `mobile/src/state/routingStore.ts`
- Test: `mobile/src/state/routingStore.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors `localeStore.test.ts`)

```ts
import { act } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { useRoutingStore } from "./routingStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

describe("routingStore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    act(() => useRoutingStore.setState({ mode: "auto" }));
  });

  it("defaults to auto", () => {
    expect(useRoutingStore.getState().mode).toBe("auto");
  });

  it("setMode sets and persists the mode", () => {
    setItem.mockResolvedValue(undefined);
    act(() => useRoutingStore.getState().setMode("proxy"));
    expect(useRoutingStore.getState().mode).toBe("proxy");
    expect(setItem).toHaveBeenCalledWith("hypersolid.pref.routing", "proxy", expect.anything());
  });

  it("hydrates a persisted mode", async () => {
    getItem.mockResolvedValue("direct");
    await useRoutingStore.getState().hydrate();
    expect(useRoutingStore.getState().mode).toBe("direct");
  });

  it("keeps the default when an invalid value is persisted", async () => {
    getItem.mockResolvedValue("bogus");
    await useRoutingStore.getState().hydrate();
    expect(useRoutingStore.getState().mode).toBe("auto");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/state/routingStore.test.ts`
Expected: FAIL (Cannot find module './routingStore').

- [ ] **Step 3: Write the implementation**

```ts
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

export type RoutingMode = "auto" | "direct" | "proxy";
export const ROUTING_MODES: RoutingMode[] = ["auto", "direct", "proxy"];

const KEY = "hypersolid.pref.routing";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

interface RoutingState {
  mode: RoutingMode;
  setMode: (m: RoutingMode) => void;
  hydrate: () => Promise<void>;
}

function persist(mode: RoutingMode) {
  void SecureStore.setItemAsync(KEY, mode, opts).catch(() => {});
}

/**
 * Network routing preference for M8 (China smart routing). Auto lets the app decide (later
 * units), Direct forces direct-to-HL, Proxy forces the Cloudflare Workers pool. Device-bound
 * persistence, hydrated once at launch (mirrors localeStore).
 */
export const useRoutingStore = create<RoutingState>((set) => ({
  mode: "auto",
  setMode: (mode) => { set({ mode }); persist(mode); },
  hydrate: async () => {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      if (v && (ROUTING_MODES as string[]).includes(v)) set({ mode: v as RoutingMode });
    } catch {
      /* best-effort: keep the default */
    }
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/state/routingStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/state/routingStore.ts mobile/src/state/routingStore.test.ts
git commit -m "feat(m8): routing preference store (auto/direct/proxy)"
```

---

### Task 2: i18n keys + startup hydrate

**Files:**
- Modify: `mobile/src/i18n/messages.ts` (en block after `settings.language` ~line 49; zh after ~line 564)
- Modify: `mobile/App.tsx` (startup hydrate `useEffect`)

- [ ] **Step 1: Add EN keys** (after `"settings.language": "Language",`)

```
    "settings.routing": "Network routing",
    "settings.routingTitle": "Network routing",
    "settings.routingAuto": "Auto",
    "settings.routingDirect": "Direct",
    "settings.routingProxy": "Proxy",
```

- [ ] **Step 2: Add ZH keys** (after `"settings.language": "语言",`)

```
    "settings.routing": "网络路由",
    "settings.routingTitle": "网络路由",
    "settings.routingAuto": "自动",
    "settings.routingDirect": "直连",
    "settings.routingProxy": "代理",
```

- [ ] **Step 3: Hydrate at startup**

In `mobile/App.tsx`, add the import near the other store imports:
```ts
import { useRoutingStore } from "./src/state/routingStore";
```
In the startup hydrate `useEffect` (the block with `void useLockPrefsStore.getState().hydrate();` …), add:
```ts
    void useRoutingStore.getState().hydrate();
```

- [ ] **Step 4: Run the i18n parity test + typecheck**

Run: `cd mobile && npx jest src/i18n/messages.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/i18n/messages.ts mobile/App.tsx
git commit -m "feat(m8): routing i18n keys (en+zh) + startup hydrate"
```

---

### Task 3: Settings picker (TDD)

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx` (imports; store reads; `Picker` union; label helper; row; `SheetSelect`)
- Test: `mobile/src/screens/SettingsScreen.test.tsx`

- [ ] **Step 1: Write the failing test**

Add after the locale test:
```tsx
  it("changes the network routing mode", () => {
    render(<SettingsScreen />);
    fireEvent.press(screen.getByText("Network routing"));
    fireEvent.press(screen.getByTestId("routing-opt-direct"));
    expect(useRoutingStore.getState().mode).toBe("direct");
  });
```
Add the import at the top of the test file:
```ts
import { useRoutingStore } from "../state/routingStore";
```
And reset it in `beforeEach` (near `useEnvStore.setState(...)`):
```ts
    useRoutingStore.setState({ mode: "auto" });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/screens/SettingsScreen.test.tsx -t "network routing"`
Expected: FAIL (no "Network routing" text).

- [ ] **Step 3: Add imports + store reads in `SettingsScreen.tsx`**

Import:
```ts
import { useRoutingStore, ROUTING_MODES, type RoutingMode } from "../state/routingStore";
```
In the component body (near the other store reads, e.g. after the `locale` reads):
```ts
  const routingMode = useRoutingStore((s) => s.mode);
  const setRoutingMode = useRoutingStore((s) => s.setMode);
```

- [ ] **Step 4: Extend the `Picker` union + add the label helper**

Change:
```ts
type Picker = "none" | "network" | "theme" | "locale" | "autolock" | "qh_start" | "qh_end" | "routing";
```
In the component body (after the store reads), add:
```ts
  const routingLabel = (m: RoutingMode) =>
    t(m === "auto" ? "settings.routingAuto" : m === "direct" ? "settings.routingDirect" : "settings.routingProxy");
```

- [ ] **Step 5: Add the row (after the network row) + the picker sheet**

After the network `SettingRow` in the prefs section, add:
```tsx
      <SettingRow theme={theme} icon="swap" name={t("settings.routing")} value={routingLabel(routingMode)} onPress={() => setPicker("routing")} />
```
After the network `SheetSelect` block, add:
```tsx
      <SheetSelect<RoutingMode>
        visible={picker === "routing"}
        onClose={() => setPicker("none")}
        title={t("settings.routingTitle")}
        value={routingMode}
        onSelect={(v) => { setRoutingMode(v); setPicker("none"); }}
        sections={[{ options: ROUTING_MODES.map((m) => ({ value: m, label: routingLabel(m) })) }]}
        theme={theme}
        testIDPrefix="routing"
      />
```

- [ ] **Step 6: Run the routing test to verify it passes**

Run: `cd mobile && npx jest src/screens/SettingsScreen.test.tsx -t "network routing"`
Expected: PASS.

- [ ] **Step 7: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add mobile/src/screens/SettingsScreen.tsx mobile/src/screens/SettingsScreen.test.tsx
git commit -m "feat(m8): network routing picker in Settings (auto/direct/proxy)"
```

---

### Task 4: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/m8-routing-preference
gh pr create --title "feat(m8): routing preference store + Settings picker" --body-file <body>
```
Body: summarize the store + hydrate + Settings picker + i18n + tests; note this is M8 unit A (preference only — no request routing yet; units B–E follow).

- [ ] **Step 3: Code review + CI**

Dispatch the code-review agent (background) + `gh pr checks <n> --watch` in parallel.

- [ ] **Step 4: Merge**

On clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** store (Task 1) ✔, i18n + startup hydrate (Task 2) ✔, Settings row + picker (Task 3) ✔, store + settings tests (Tasks 1,3) ✔, no request-routing behavior (documented out-of-scope) ✔.
- **Placeholder scan:** none — all steps carry concrete code/commands.
- **Type consistency:** `RoutingMode`/`ROUTING_MODES` defined in Task 1 and consumed in Task 3; `useRoutingStore` methods (`mode`/`setMode`/`hydrate`) used consistently; `Picker` union extended with `"routing"` matching the `picker === "routing"` guard and `testIDPrefix="routing"` → `routing-opt-direct`.
- **Test locale:** en default → row label "Network routing", option testIDs `routing-opt-*`, matching the i18n en values and the SheetSelect testID convention (`${prefix}-opt-${value}`).
