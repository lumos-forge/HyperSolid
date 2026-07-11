# M7 P5b-mobile — Category Toggle UI in Settings

Date: 2026-07-11
Status: Approved

## Context

P5b-server (PR #76) added server-authoritative per-owner push category
preferences (`fills`, `alerts`, default on) with `GET/POST /push/prefs`, and the
`Notifier` now suppresses a disabled category. The mobile app has no UI to view or
change these preferences yet — this unit adds it, completing the P5b feature end
to end.

The Settings screen (`mobile/src/screens/SettingsScreen.tsx`) renders tappable
`SettingRow`s (tap-to-toggle), including a master "Notifications" row backed by
`usePushPrefsStore` + `applyPushPreference`. Category preferences are distinct
from the master on/off: master off = no device token registered = no push at all;
categories are a finer server-side filter applied when push is on.

## Goal

When the master notifications toggle is on, show two category rows — **成交通知
/ Fill notifications** and **保护告警 / Protection alerts** — that reflect and edit
the server's per-owner category preferences via `GET/POST /push/prefs`. The server
is the single source of truth: fetch on entry, optimistic write on tap, revert on
failure.

## Design

### 1. `StrategyApi` (`mobile/src/services/strategyApi.ts`)

Two methods mirroring the existing `registerPush`/`unregisterPush` style:

```ts
getPushPrefs() {
  return this.request<{ fills: boolean; alerts: boolean }>("/push/prefs", "GET");
}
setPushPrefs(prefs: { fills?: boolean; alerts?: boolean }) {
  return this.request<void>("/push/prefs", "POST", prefs);
}
```

### 2. `mobile/src/services/pushCategoryPrefs.ts` (new)

A fail-safe service mirroring `pushToggle.ts`'s injected `makeAuthedApi` seam, so
it is unit-testable without React or the network. `AuthedApi` is
`Pick<StrategyApi, "getPushPrefs" | "setPushPrefs">`.

```ts
export interface PushCategoryPrefs { fills: boolean; alerts: boolean; }

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

### 3. `SettingsScreen.tsx`

- Local state: `const [categoryPrefs, setCategoryPrefs] = useState<PushCategoryPrefs | null>(null)`
  (`null` = not loaded).
- Effect: when `pushEnabled` is true, call `fetchPushCategoryPrefs(makeAuthedApi)`
  and store the result; when `pushEnabled` is false, reset to `null`.
  ```ts
  useEffect(() => {
    let alive = true;
    if (!pushEnabled) { setCategoryPrefs(null); return; }
    void fetchPushCategoryPrefs(makeAuthedApi).then((p) => { if (alive) setCategoryPrefs(p); });
    return () => { alive = false; };
  }, [pushEnabled]);
  ```
- Render two `SettingRow`s immediately after the master notifications row, only
  when `pushEnabled && categoryPrefs !== null`:
  ```tsx
  {pushEnabled && categoryPrefs && (
    <>
      <SettingRow theme={theme} icon="alert" name={t("settings.notifyFills")}
        value={categoryPrefs.fills ? t("settings.notificationsOn") : t("settings.notificationsOff")}
        onPress={() => onToggleCategory("fills")} />
      <SettingRow theme={theme} icon="alert" name={t("settings.notifyAlerts")}
        value={categoryPrefs.alerts ? t("settings.notificationsOn") : t("settings.notificationsOff")}
        onPress={() => onToggleCategory("alerts")} />
    </>
  )}
  ```
- Handler (optimistic + revert):
  ```ts
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

### 4. i18n (`mobile/src/i18n/messages.ts`, en + zh)

Add keys (parity enforced by `messages.test.ts`):
- `settings.notifyFills` — en `"Fill notifications"`, zh `"成交通知"`.
- `settings.notifyAlerts` — en `"Protection alerts"`, zh `"保护告警"`.
- `settings.pushPrefsFailed` — en `"Couldn't update notification settings"`, zh `"通知设置更新失败"`.

The On/Off value labels reuse the existing `settings.notificationsOn` /
`settings.notificationsOff`.

## Data flow

```
Settings mounts / push toggled on
  → fetchPushCategoryPrefs(makeAuthedApi) → GET /push/prefs → { fills, alerts }
    → render two rows
      → tap → optimistic local flip → setPushCategoryPrefs(makeAuthedApi, { [cat]: v }) → POST /push/prefs
        → false → revert local + error toast
```

## Error handling / compatibility

- Fetch returns `null` on no session or any error → category rows are simply not
  shown (no misleading state), consistent with the master toggle already being on.
- The service never throws; the screen effect guards with an `alive` flag to avoid
  setState after unmount.
- Master toggle behavior (`applyPushPreference`, sign-out unregister) is unchanged.
- The two categories match the server's `PushPrefs` shape exactly.

## Testing

- `strategyApi.test.ts` — `getPushPrefs` issues `GET /push/prefs` and returns the
  parsed body; `setPushPrefs` issues `POST /push/prefs` with the partial body.
- `pushCategoryPrefs.test.ts` — `fetchPushCategoryPrefs` returns prefs on success,
  `null` when `makeAuthedApi` yields `null`, and `null` when `getPushPrefs` throws;
  `setPushCategoryPrefs` returns `true` on success, `false` on no session, and
  `false` when `setPushPrefs` throws.
- Validation: `cd mobile && npx tsc --noEmit && npm test` (jest-expo). Screen
  wiring is thin; logic lives in the tested service.

## Out of scope / deferred

- Re-fetching category prefs on navigation focus (fetch-on-mount/enable is enough).
- Persisting category prefs locally (server is the sole source).
- P5c quiet hours, P2.5 receipt polling, additional categories.
