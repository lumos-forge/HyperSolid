# M8 Unit A — Routing Preference Store + Settings UI

Date: 2026-07-13
Status: Approved

## Context

M8 (China smart routing, `docs/CHINA-ACCESS-ANALYSIS.md`) routes traffic through a
Cloudflare Workers proxy pool for China-mainland users while keeping signed txns / private
WS on direct connections. The client needs a user-visible routing preference —
**Auto / Direct / Proxy** — persisted and overridable in Settings. This is the first,
foundational unit: it establishes the preference store and its Settings control. It does
**not** yet change how any request is routed (that is later units B–E: selection core,
environment detection, auto-degradation, HL-client wiring).

## Goal

Add a persisted `RoutingMode` preference (`auto`/`direct`/`proxy`, default `auto`) with a
Settings picker, mirroring the existing `localeStore` + Settings `SheetSelect` pattern.

## Design (all in `mobile/`)

### 1. `state/routingStore.ts` (mirrors `localeStore.ts`)

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

export const useRoutingStore = create<RoutingState>((set) => ({
  mode: "auto",
  setMode: (mode) => { set({ mode }); persist(mode); },
  hydrate: async () => {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      if (v && (ROUTING_MODES as string[]).includes(v)) set({ mode: v as RoutingMode });
    } catch { /* best-effort: keep the default */ }
  },
}));
```
- Device-bound persistence, hydrated once at launch — identical lifecycle to `localeStore`.

### 2. `App.tsx` — hydrate at startup

In the existing startup hydrate `useEffect` (the block calling
`useLockPrefsStore.getState().hydrate()` etc.), add:
```ts
void useRoutingStore.getState().hydrate();
```

### 3. `screens/SettingsScreen.tsx`

- Import `useRoutingStore, ROUTING_MODES, type RoutingMode`.
- Read `const routingMode = useRoutingStore((s) => s.mode);` and
  `const setRoutingMode = useRoutingStore((s) => s.setMode);`.
- Extend the `Picker` union: `... | "routing"`.
- A localized label helper:
  ```ts
  const routingLabel = (m: RoutingMode) =>
    t(m === "auto" ? "settings.routingAuto" : m === "direct" ? "settings.routingDirect" : "settings.routingProxy");
  ```
- Add a `SettingRow` in the prefs section, just after the network row:
  ```tsx
  <SettingRow theme={theme} icon="swap" name={t("settings.routing")} value={routingLabel(routingMode)} onPress={() => setPicker("routing")} />
  ```
- Add the picker sheet alongside the others:
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

### 4. i18n (`i18n/messages.ts`, en + zh)

- `settings.routing` — en `"Network routing"`, zh `"网络路由"`.
- `settings.routingTitle` — en `"Network routing"`, zh `"网络路由"`.
- `settings.routingAuto` — en `"Auto"`, zh `"自动"`.
- `settings.routingDirect` — en `"Direct"`, zh `"直连"`.
- `settings.routingProxy` — en `"Proxy"`, zh `"代理"`.

## Data flow

```
launch → useRoutingStore.hydrate() (reads SecureStore, default "auto")
Settings → tap "Network routing" → SheetSelect → setMode(m) → persist(m)
(consumed by later units B–E; this unit only stores + exposes the preference)
```

## Error handling / edge cases

- Persist/hydrate are best-effort (SecureStore failures are swallowed; default `auto`).
- `hydrate` ignores any stored value not in `ROUTING_MODES` (defends against corruption).
- No behavioral change to request routing yet.

## Testing

- `state/routingStore.test.ts` (mirrors `localeStore.test.ts`): default is `auto`;
  `setMode("proxy")` updates state and calls `SecureStore.setItemAsync`; `hydrate()` applies
  a valid stored value and ignores an invalid one. Mock `expo-secure-store`.
- `screens/SettingsScreen.test.tsx`: render, press the `Network routing` row, press
  `routing-opt-direct`, and assert `useRoutingStore.getState().mode === "direct"`.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred (later M8 units)

- B — proxy-selection core (consistent hashing + traffic separation).
- C — network-environment detection (China + direct reachability → Auto's effective route).
- D — auto-degradation (429/failure → pool cooldown → direct fallback).
- E — wiring the mode into `createInfoClient`/`createSubsClient`/`createExchangeClient`.
- F — the Cloudflare Worker proxy itself + wrangler.
