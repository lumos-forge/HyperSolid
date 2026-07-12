# M7 P4.5-mobile — Lifecycle Category Toggle in Settings

Date: 2026-07-12
Status: Approved

## Context

P4.5-server (PR #81) added a third push category, `lifecycle` (strategy completed),
default on, editable via `GET/POST /push/prefs` (which now returns/accepts
`{ fills, alerts, lifecycle }`). The mobile Settings screen (from P5b-mobile) already
renders category toggle rows for `fills` and `alerts` via `pushCategoryPrefs` +
`onToggleCategory`, but not `lifecycle`. This unit adds the third row, completing
P4.5 end to end. It is a direct mirror of the existing two rows.

## Goal

When the master notifications toggle is on, show a third category row — **策略完成 /
Strategy completed** — reflecting and editing the server's `lifecycle` preference,
using the exact optimistic-write + revert flow already used for `fills`/`alerts`.

## Design

All changes are in `mobile/`.

1. **`mobile/src/services/pushCategoryPrefs.ts`** — widen the type:
   ```ts
   export interface PushCategoryPrefs { fills: boolean; alerts: boolean; lifecycle: boolean; }
   ```
   The `fetch`/`set` functions are already generic over `PushCategoryPrefs` /
   `Partial<PushCategoryPrefs>` and need no other change.

2. **`mobile/src/services/strategyApi.ts`** — widen the request/response shapes:
   ```ts
   getPushPrefs() {
     return this.request<{ fills: boolean; alerts: boolean; lifecycle: boolean }>("/push/prefs", "GET");
   }
   setPushPrefs(prefs: { fills?: boolean; alerts?: boolean; lifecycle?: boolean }) {
     return this.request<void>("/push/prefs", "POST", prefs);
   }
   ```

3. **`mobile/src/screens/SettingsScreen.tsx`**
   - Widen the handler category type:
     `async function onToggleCategory(cat: "fills" | "alerts" | "lifecycle")`.
   - Add a third `SettingRow` after the `alerts` row inside the existing
     `{pushEnabled && categoryPrefs && ( ... )}` block:
     ```tsx
     <SettingRow theme={theme} icon="alert" name={t("settings.notifyLifecycle")}
       value={categoryPrefs.lifecycle ? t("settings.notificationsOn") : t("settings.notificationsOff")}
       onPress={() => onToggleCategory("lifecycle")} />
     ```

4. **i18n (`mobile/src/i18n/messages.ts`, en + zh)** — add one key:
   - `settings.notifyLifecycle` — en `"Strategy completed"`, zh `"策略完成"`.
   On/Off value labels reuse `settings.notificationsOn`/`settings.notificationsOff`.

## Data flow

Identical to `fills`/`alerts`:
```
Settings (push on) → fetchPushCategoryPrefs → GET /push/prefs → { fills, alerts, lifecycle }
  → render three rows
    → tap lifecycle → optimistic flip → setPushCategoryPrefs({ lifecycle: next }) → POST /push/prefs
      → false → revert + error toast
```

## Error handling / compatibility

- Server already returns `lifecycle` (default on); this unit only surfaces it in the UI.
- The existing fail-safe service + optimistic/revert handler are reused unchanged.
- Fetch `null` (no session / error) still hides all category rows.

## Testing

- `pushCategoryPrefs.test.ts` — the `apiFake` gains `lifecycle` in its prefs shape (a
  type requirement now that `PushCategoryPrefs` includes it); add/adjust an assertion
  that a `lifecycle` toggle is forwarded via `setPushCategoryPrefs`.
- `strategyApi.test.ts` — the `getPushPrefs` mock + assertion include `lifecycle`; a
  `setPushPrefs({ lifecycle: false })` body assertion.
- Validation: `cd mobile && npx tsc --noEmit && npm test`. Screen wiring is thin.

## Out of scope / deferred

- Any new category beyond fills/alerts/lifecycle.
- Reordering / grouping the category rows.
