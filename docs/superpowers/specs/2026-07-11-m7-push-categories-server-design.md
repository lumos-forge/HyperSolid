# M7 P5b-server — Per-Category Push Notification Preferences (server)

Date: 2026-07-11
Status: Approved

## Context

The strategy backend (`server/`, TypeScript, Fastify + better-sqlite3) sends two
kinds of push notification (`data.kind`):

- `fill` — an order filled (via `NotifyingActivityStore`, category **fills**).
- `deadman_alert` / `deadman_recovered` — strategy-protection health
  (via `index.ts onHealthEvent`, category **alerts**).

Users want to enable/disable these categories independently. Because the server
sends the push, suppression must happen **server-side** — the client cannot stop
a notification that has already been dispatched. This unit adds server-authoritative
per-owner category preferences and gates delivery on them. The mobile UI to edit
these preferences is a separate follow-up unit (P5b-mobile).

## Goal

Let each owner independently turn the **fills** and **alerts** notification
categories on or off, enforced on the server so disabled categories are never
delivered. Default (no stored preference) is **on** for every category — zero
regression for existing users.

## Categories

```ts
export type PushCategory = "fills" | "alerts";
```

- **fills** — order-fill notifications.
- **alerts** — dead-man protection alert and recovered notifications.

## Design

### 1. `server/src/push/pushPrefStore.ts` (new)

A durable per-owner category preference store over SQLite.

Schema (created if absent; owner stored lower-cased for case-insensitive match,
consistent with `pushTokenStore`):

```sql
CREATE TABLE IF NOT EXISTS push_prefs (
  owner TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, category)
);
```

Interface:

```ts
export interface PushPrefs { fills: boolean; alerts: boolean; }

export interface PushPrefStore {
  /** Effective on/off for one category; absent row defaults to true (on). */
  isEnabled(owner: string, category: PushCategory): boolean;
  /** Effective prefs for all categories (absent → true). */
  get(owner: string): PushPrefs;
  /** Upsert only the provided categories. */
  set(owner: string, prefs: Partial<PushPrefs>, now: number): void;
}
```

Semantics:
- `isEnabled` / `get` treat a missing row as `true` (fail-open default: on).
- `set` upserts one row per provided category (`ON CONFLICT(owner, category)`),
  writing `enabled` as `1`/`0` and refreshing `updated_at`. Undefined keys are
  left untouched.

### 2. `Notifier.notify(owner, category, render)`

Add a `category: PushCategory` parameter and an **optional** `prefs` dependency:

```ts
export interface NotifierDeps {
  expo: ExpoLike;
  store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  prefs?: Pick<PushPrefStore, "isEnabled">;
  logger?: (msg: string, err?: unknown) => void;
  isValidToken?: (token: string) => boolean;
}
```

Gate at the top of `notify`, before any token lookup:

```ts
async notify(owner: string, category: PushCategory, render: (locale: PushLocale) => Notification): Promise<NotifyResult> {
  const result: NotifyResult = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
  if (this.prefs) {
    let enabled = true;
    try {
      enabled = this.prefs.isEnabled(owner, category);
    } catch (err) {
      this.log("push prefs lookup failed", err); // fail-open: send anyway
    }
    if (!enabled) return result; // category disabled → skip entirely
  }
  // ...existing token lookup / per-locale render / chunk-send/prune unchanged...
}
```

Rationale for fail-open on `prefs` error: a storage fault must not silently
suppress safety-critical dead-man alerts; only an explicit user "off" suppresses.

When `prefs` is not injected, behavior is identical to today (always send).

### 3. Callers

- `server/src/push/notifyingActivityStore.ts`:
  `notify(row.owner, "fills", (locale) => fillNotification(row, locale))`.
- `server/src/index.ts onHealthEvent`:
  - alert: `notify(owner, "alerts", (l) => deadManAlertNotification(ev, l))`.
  - recovered: `notify(owner, "alerts", (l) => deadManRecoveredNotification(l))`.

### 4. HTTP routes (`server/src/http/app.ts`)

Authed (owner from session), `503` if push not configured — mirroring
`/push/register`. A new optional dep `pushPrefs?: PushPrefStore`.

```
GET  /push/prefs           -> 200 { fills: boolean, alerts: boolean }
POST /push/prefs { fills?: boolean, alerts?: boolean } -> 204
```

- `GET` returns `deps.pushPrefs.get(owner)` (defaults on).
- `POST` accepts a body where each of `fills`/`alerts` is optional and, if
  present, must be a boolean; non-boolean present values → `400`. Only provided
  keys are written. Empty body `{}` is a no-op `204`.

### 5. Wiring (`server/src/index.ts`)

```ts
const pushPrefs = SqlitePushPrefStore.open(dbPath);
const notifier = new Notifier({ expo: new Expo(), store: pushTokens, prefs: pushPrefs });
// ...
const app = buildApp({ /* ...existing... */ pushTokens, pushPrefs, /* ... */ });
```

## Data flow

```
fill/health event
  → notify(owner, category, render)
    → prefs.isEnabled(owner, category)?  // false → return zeros (skip)
      → tokensForOwner / per-locale render / chunk-send / prune  (P5a, unchanged)

SettingsScreen (P5b-mobile, later)
  → GET /push/prefs   → { fills, alerts }
  → POST /push/prefs  → set(owner, {...})
```

## Error handling / compatibility

- Absent preference row → category **on** (no regression for current users).
- `prefs` not injected → Notifier sends exactly as before.
- `prefs.isEnabled` throwing → fail-open (send) + logged.
- `notify` remains fail-safe (never throws); the new gate only returns early.
- `POST /push/prefs` validates booleans and never partially applies a bad body
  (validate all present keys before writing).

## Testing

- `pushPrefStore.test.ts` — default `isEnabled`/`get` = true on a fresh DB;
  `set({fills:false})` then `get` = `{fills:false, alerts:true}`; `set` upsert
  overwrites; `set({})` no-op; case-insensitive owner.
- `notifier.test.ts` — add cases: category disabled via `prefs` → `{tokens:0,...}`
  and no `expo.sends`; category enabled → sends; no `prefs` dep → sends;
  `prefs.isEnabled` throws → sends (fail-open) + logs. Update every existing
  `notify(OWNER, () => N)` call to `notify(OWNER, "fills", () => N)`.
- `notifyingActivityStore.test.ts` — assert `notify` called with `"fills"` and a
  render fn (update the `notifierFake` signature to `(owner, category, render)`).
- `app.test.ts` — `GET /push/prefs` defaults `{fills:true, alerts:true}`;
  `POST /push/prefs {fills:false}` then `GET` reflects it; non-boolean value →
  `400`; unauthenticated → `401`; push-not-configured → `503`.
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope / deferred

- Mobile UI to view/edit category prefs (P5b-mobile — next unit).
- Additional categories beyond fills/alerts.
- P5c quiet hours, P2.5 receipt polling.
