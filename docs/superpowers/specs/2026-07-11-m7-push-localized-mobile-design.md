# M7 P5a-mobile — report device locale at push registration

Date: 2026-07-11
Status: Approved

## Context

P5a-server (PR #74) made the strategy backend localize push notifications per
device: `push_tokens.locale` stores each token's locale, and
`Notifier.notify(owner, render)` renders each token in `toPushLocale(row.locale)`
(missing/unknown → `en`). `POST /push/register` accepts an optional `locale`
field (`en`/`zh`, else `null`).

The mobile app already reports its Expo push token to `/push/register` but does
not send a locale, so every device is stored with `locale = null` and renders in
English. This unit closes that gap: report the user's current UI language at
registration so localized push works end to end.

## Goal

When the mobile app registers a device push token, include the user's active UI
locale (`useLocaleStore` → `en` | `zh`) in the `/push/register` body so the
server localizes subsequent notifications for that device.

## Scope (this unit)

Report the locale **at registration time only** (a one-time snapshot taken when
the user enables push). Automatically re-registering when the user later switches
languages is intentionally **out of scope** (YAGNI); a user who changes language
after enabling push must toggle push off/on to update the stored locale.

## Design

All changes are in `mobile/`; four production touch points plus tests.

1. **`StrategyApi.registerPush(token, platform, locale)`**
   (`mobile/src/services/strategyApi.ts`) — add a `locale: string` parameter and
   include it in the POST body: `POST /push/register { token, platform, locale }`.
   The server already whitelists `en`/`zh` and coerces anything else to `null`,
   so the client passes the raw locale string as-is.

2. **`PushEnv` seam** (`mobile/src/services/pushRegistration.ts`) — add a
   `locale: string` field. It is a one-time snapshot supplied by the caller,
   exactly like the existing `platform` field, so `registerDeviceForPush` stays
   unit-testable and never imports the locale store directly.

3. **`registerDeviceForPush`** (`mobile/src/services/pushRegistration.ts`) —
   change the register call to `api.registerPush(token, env.platform, env.locale)`.
   The fail-safe contract (never throws; device/permission short-circuits) is
   unchanged.

4. **`expoPushEnv()` adapter** (`mobile/src/services/pushEnv.ts`) — add
   `locale: useLocaleStore.getState().locale`, reading the persisted UI language
   once at the moment the env is constructed (i.e. when the user toggles push on
   in `SettingsScreen`).

## Data flow

```
SettingsScreen.onToggleNotifications
  → expoPushEnv()               // locale = useLocaleStore.getState().locale
  → applyPushPreference(true, { env, ... })
    → registerDeviceForPush(api, env)
      → api.registerPush(token, env.platform, env.locale)
        → POST /push/register { token, platform, locale }
          → server persists push_tokens.locale
```

## Error handling / compatibility

- `useLocaleStore.locale` always has a value (defaults to `en`), so `locale` is
  always a non-empty string — no optional/undefined handling is needed on the
  client.
- The server coerces any unexpected value to `en` (`toPushLocale`), so there is
  no regression risk from the client side.
- `applyPushPreference` / `registerDeviceForPush` remain fail-safe; adding a
  parameter does not introduce any new throw path.

## Testing

- `mobile/src/services/pushRegistration.test.ts` — the `PushEnv` fakes gain a
  `locale` field; add/adjust an assertion that `registerPush` is called with the
  env's locale (e.g. `zh`).
- If a test exercises `StrategyApi.registerPush` directly, update its body
  assertion to include `locale`.
- Validation: `cd mobile && npx tsc --noEmit && npm test` (jest-expo) — expect no
  regressions.

## Out of scope / deferred

- Automatic re-registration on locale change while push is enabled (YAGNI).
- Launch-time re-registration (already deferred from P3c).
- P5b category toggles, P5c quiet hours.
