# M7 P5c-mobile — Quiet Hours UI in Settings

Date: 2026-07-11
Status: Approved

## Context

P5c-server (PR #78) added server-authoritative, timezone-aware quiet hours that
suppress only `fills` (alerts always send), exposed via `GET/POST /push/quiet-hours`
returning/accepting `{ enabled, start, end, tz }` (start/end are minute-of-day
`0`–`1439` in the stored IANA timezone). The mobile app has no UI to configure it
yet — this unit adds it, completing P5c end to end.

The Settings screen (`mobile/src/screens/SettingsScreen.tsx`) uses tap-to-toggle
`SettingRow`s plus a `Picker` state machine driving bottom-sheet `SheetSelect`
single-selects (network / theme / locale / auto-lock). Quiet-hours editing reuses
this exact infrastructure — no new dependency, no native time picker.

## Goal

When the master notifications toggle is on, let the user enable quiet hours and pick
a start and end **hour** (whole-hour granularity). Edits write to the server (server
is the sole source of truth) with the device's current timezone; failures revert and
toast.

## Design

### 1. `StrategyApi` (`mobile/src/services/strategyApi.ts`)

```ts
getQuietHours() {
  return this.request<{ enabled: boolean; start: number; end: number; tz: string }>("/push/quiet-hours", "GET");
}
setQuietHours(qh: { enabled: boolean; start: number; end: number; tz: string }) {
  return this.request<void>("/push/quiet-hours", "POST", qh);
}
```

### 2. `mobile/src/services/pushQuietHours.ts` (new)

Fail-safe service mirroring `pushCategoryPrefs.ts`, plus a device-timezone helper.
`AuthedApi = Pick<StrategyApi, "getQuietHours" | "setQuietHours">`.

```ts
export interface QuietHours { enabled: boolean; start: number; end: number; tz: string; }

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

### 3. `SettingsScreen.tsx`

- Local state: `const [quietHours, setQuietHours] = useState<QuietHours | null>(null);`
  (`null` = not loaded).
- Extend the picker state machine: `type Picker = ... | "qh_start" | "qh_end";`.
- Effect (reuse the category-prefs pattern): when `pushEnabled` becomes true,
  `fetchQuietHours(makeAuthedApi)` → set state; when false, reset to `null`.
- A single write helper applies an optimistic change and reverts on failure:
  ```ts
  async function writeQuietHours(next: QuietHours) {
    const prev = quietHours;
    setQuietHours(next);
    const ok = await saveQuietHours(makeAuthedApi, next);
    if (!ok) {
      setQuietHours(prev);
      useToastStore.getState().show(t("settings.pushPrefsFailed"), "error");
    }
  }
  ```
- Handlers:
  ```ts
  function onToggleQuiet() {
    if (!quietHours) return;
    void writeQuietHours({ ...quietHours, enabled: !quietHours.enabled, tz: deviceTimeZone() });
  }
  function onPickQuietHour(which: "start" | "end", hour: number) {
    if (!quietHours) return;
    const minute = hour * 60;
    void writeQuietHours({ ...quietHours, [which]: minute, tz: deviceTimeZone() });
    setPicker("none");
  }
  ```
- A minute→label helper: `const fmtHour = (m: number) => \`${String(Math.floor(m / 60)).padStart(2, "0")}:00\`;`.
- Rows, rendered after the category rows, only when `pushEnabled && quietHours`:
  ```tsx
  <SettingRow theme={theme} icon="lock" name={t("settings.quietHours")}
    value={quietHours.enabled ? t("settings.notificationsOn") : t("settings.notificationsOff")}
    onPress={onToggleQuiet} />
  {quietHours.enabled && (
    <>
      <SettingRow theme={theme} icon="lock" name={t("settings.quietStart")} value={fmtHour(quietHours.start)} onPress={() => setPicker("qh_start")} />
      <SettingRow theme={theme} icon="lock" name={t("settings.quietEnd")} value={fmtHour(quietHours.end)} onPress={() => setPicker("qh_end")} />
    </>
  )}
  ```
- Two `SheetSelect`s (one for start, one for end), each with 24 whole-hour options.
  The options are built once:
  ```ts
  const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));
  ```
  Rendered:
  ```tsx
  <SheetSelect visible={picker === "qh_start"} onClose={() => setPicker("none")} title={t("settings.quietStart")}
    sections={[{ options: HOUR_OPTIONS }]} value={String(Math.floor((quietHours?.start ?? 0) / 60))}
    onSelect={(v) => onPickQuietHour("start", Number(v))} theme={theme} testIDPrefix="qh-start" />
  <SheetSelect visible={picker === "qh_end"} onClose={() => setPicker("none")} title={t("settings.quietEnd")}
    sections={[{ options: HOUR_OPTIONS }]} value={String(Math.floor((quietHours?.end ?? 0) / 60))}
    onSelect={(v) => onPickQuietHour("end", Number(v))} theme={theme} testIDPrefix="qh-end" />
  ```

### 4. i18n (`mobile/src/i18n/messages.ts`, en + zh)

- `settings.quietHours` — en `"Quiet hours"`, zh `"免打扰时段"`.
- `settings.quietStart` — en `"Start"`, zh `"开始"`.
- `settings.quietEnd` — en `"End"`, zh `"结束"`.

On/Off value labels reuse `settings.notificationsOn`/`settings.notificationsOff`;
the failure toast reuses `settings.pushPrefsFailed`.

## Timezone handling

Whole-hour start/end are interpreted as wall-clock times in the device's current
IANA timezone. Every write sends `tz: deviceTimeZone()`, so the server always stores
the user's current zone. The fetched `tz` is not shown; start/end are displayed
numerically as `HH:00`. `Intl.DateTimeFormat().resolvedOptions().timeZone` is
available in the app's Hermes runtime; the helper falls back to `"UTC"` if it throws.

## Data flow

```
Settings mounts / push toggled on
  → fetchQuietHours(makeAuthedApi) → GET /push/quiet-hours → { enabled, start, end, tz }
    → render enable row (+ start/end rows when enabled)
      → toggle / pick hour → optimistic setQuietHours + saveQuietHours(makeAuthedApi, { ..., tz: deviceTimeZone() }) → POST
        → false → revert + error toast
```

## Error handling / compatibility

- Fetch `null` (no session/error) → rows not shown (no misleading state), consistent
  with the category rows.
- The service never throws; the effect guards with an `alive` flag against unmount.
- Whole-hour granularity → `start`/`end` are always multiples of 60, well within the
  server's `0..1439` validation.
- Master toggle + category rows behavior unchanged.

## Testing

- `strategyApi.test.ts` — `getQuietHours` issues `GET /push/quiet-hours` and returns
  the parsed body; `setQuietHours` issues `POST /push/quiet-hours` with the full body.
- `pushQuietHours.test.ts` — `fetchQuietHours` returns config on success, `null` when
  `makeAuthedApi` yields `null`, and `null` when `getQuietHours` throws;
  `saveQuietHours` returns `true` on success, `false` on no session, and `false` when
  `setQuietHours` throws; `deviceTimeZone` returns a non-empty string (and never
  throws).
- Validation: `cd mobile && npx tsc --noEmit && npm test`. Screen wiring is thin.

## Out of scope / deferred

- Sub-hour (minute/30-min) granularity and native time pickers.
- Showing/editing the timezone directly (device tz is used implicitly).
- P2.5 receipt polling, additional categories.
