# M7 P5c-server — Quiet Hours (server)

Date: 2026-07-11
Status: Approved

## Context

P5b-server (PR #76) added per-owner push category preferences (`fills`, `alerts`)
enforced in `Notifier.notify`. This unit adds a per-owner **quiet hours** window
that suppresses **fills only** during the user's local night hours; **alerts**
(dead-man protection) always pass through, consistent with the fund-safety
fail-open stance used elsewhere. The mobile UI to configure the window is a
separate follow-up unit (P5c-mobile).

## Goal

Let each owner define one daily quiet-hours window in their local time. When the
current time (in the owner's timezone) falls within the window, `fills`
notifications are suppressed; `alerts` are unaffected. Default (no configuration)
is **disabled** — zero regression.

## Timezone model

Quiet hours are stored as the owner's IANA timezone string (e.g.
`"Asia/Shanghai"`) plus a start and end **minute-of-day** in that local time
(`0`–`1439`). At send time the server computes the current minute-of-day in that
timezone via `Intl.DateTimeFormat`, which handles DST correctly. This avoids
storing brittle fixed UTC offsets.

## Design

### 1. `server/src/push/pushQuietHours.ts` (new — pure logic)

```ts
export interface QuietHours {
  enabled: boolean;
  start: number; // minute-of-day 0..1439, local (tz) time
  end: number;   // minute-of-day 0..1439, local (tz) time
  tz: string;    // IANA timezone
}

/** Current minute-of-day (0..1439) in the given IANA timezone; throws RangeError on a bad tz. */
export function minuteOfDayInTz(nowMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(nowMs));
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

/** True when nowMs is inside the quiet window. Fail-open: disabled, empty
 *  (start===end), or an unparseable tz all return false (not quiet → send). */
export function isWithinQuietHours(qh: QuietHours, nowMs: number): boolean {
  if (!qh.enabled || qh.start === qh.end) return false;
  let m: number;
  try {
    m = minuteOfDayInTz(nowMs, qh.tz);
  } catch {
    return false; // bad tz → don't suppress
  }
  return qh.start < qh.end
    ? m >= qh.start && m < qh.end          // same-day window
    : m >= qh.start || m < qh.end;         // overnight (wraps midnight)
}
```

### 2. `server/src/push/pushQuietHoursStore.ts` (new — SQLite)

Schema (owner lower-cased for case-insensitive match, consistent with the other
push stores):

```sql
CREATE TABLE IF NOT EXISTS push_quiet_hours (
  owner TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  tz TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Interface:

```ts
export interface QuietHoursStore {
  /** Absent row → { enabled:false, start:0, end:0, tz:"UTC" }. */
  get(owner: string): QuietHours;
  set(owner: string, qh: QuietHours, now: number): void;
  /** Effective suppression check now; false (send) on any error. */
  isQuietNow(owner: string, nowMs: number): boolean;
}
```

- `get` maps a missing row to the disabled default.
- `set` upserts the single per-owner row (`ON CONFLICT(owner)`).
- `isQuietNow(owner, nowMs)` = `isWithinQuietHours(this.get(owner), nowMs)` wrapped
  in try/catch → `false` on any storage error (fail-open).

### 3. `Notifier.notify` gate

Add two optional deps and gate `fills` only:

```ts
export interface NotifierDeps {
  expo: ExpoLike;
  store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  prefs?: Pick<PushPrefStore, "isEnabled">;
  quietHours?: { isQuietNow(owner: string, nowMs: number): boolean };
  now?: () => number; // defaults to Date.now
  logger?: (msg: string, err?: unknown) => void;
  isValidToken?: (token: string) => boolean;
}
```

In `notify`, after the existing category gate:

```ts
if (category === "fills" && this.quietHours) {
  try {
    if (this.quietHours.isQuietNow(owner, this.now())) return result; // quiet → skip fills
  } catch (err) {
    this.log("push quiet-hours lookup failed", err); // fail-open: send anyway
  }
}
```

`alerts` never reach this branch (only `fills` is gated), so safety alerts always
send. When `quietHours` is not injected, behavior is unchanged.

### 4. HTTP routes (`server/src/http/app.ts`)

Authed (owner from session), `503` if quiet hours not configured — a new optional
dep `quietHours?: QuietHoursStore`.

```
GET  /push/quiet-hours            -> 200 { enabled, start, end, tz }
POST /push/quiet-hours { enabled, start, end, tz } -> 204
```

`POST` validation (all fields required; reject before any write):
- `enabled` must be a boolean.
- `start` and `end` must be integers in `0..1439`.
- `tz` must be a non-empty string that `Intl.DateTimeFormat` accepts (construct it
  in a try/catch; `RangeError` → `400`).
- Any violation → `400`; on success write via `set(owner, { enabled, start, end, tz }, now())`.

### 5. Wiring (`server/src/index.ts`)

```ts
const quietHours = SqliteQuietHoursStore.open(dbPath);
const notifier = new Notifier({ expo: new Expo(), store: pushTokens, prefs: pushPrefs, quietHours });
// ...
const app = buildApp({ /* ...existing... */ pushTokens, pushPrefs, quietHours, /* ... */ });
```

`now` is left to the Notifier default (`Date.now`) in production.

## Data flow

```
fill event → notify(owner, "fills", render)
  → prefs.isEnabled(owner,"fills")? false → skip
  → quietHours.isQuietNow(owner, now())? true → skip (fills only)
  → tokensForOwner / per-locale render / send (unchanged)

alert event → notify(owner, "alerts", render)
  → prefs gate only; quiet-hours branch never taken → always send
```

## Error handling / compatibility

- Absent config → disabled → never suppresses (no regression).
- Disabled, `start===end`, unparseable tz, or any store error → not quiet (send).
- Only `fills` is gated; `alerts` bypass quiet hours entirely.
- `quietHours` not injected → Notifier unchanged.
- `notify` remains fail-safe; the gate only returns early.
- `POST` validates all fields before writing (no partial/bad write).

## Testing

- `pushQuietHours.test.ts` — `isWithinQuietHours`: same-day window in/out; overnight
  wraparound in/out; disabled → false; `start===end` → false; bad tz → false; and a
  timezone correctness case (fixed `nowMs` UTC instant evaluated against two
  different `tz`s yields different minute-of-day / in-out results).
- `pushQuietHoursStore.test.ts` — fresh DB `get` = disabled default; `set` then `get`
  round-trips; `isQuietNow` true inside an enabled window and false when disabled;
  case-insensitive owner.
- `notifier.test.ts` — with a `quietHours` stub: `fills` suppressed when
  `isQuietNow` true (`{tokens:0,...}`, no sends); `fills` sent when false; `alerts`
  sent even when `isQuietNow` true; `isQuietNow` throws → `fills` sent (fail-open).
  Inject `now: () => FIXED`.
- `app.test.ts` — `GET /push/quiet-hours` default `{enabled:false,start:0,end:0,tz:"UTC"}`;
  `POST` valid body then `GET` reflects it; out-of-range `start` → `400`; bad `tz` →
  `400`; non-boolean `enabled` → `400`; unauthenticated → `401`; not configured → `503`.
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope / deferred

- Mobile UI to configure the window (P5c-mobile — next unit).
- Per-category quiet hours (only fills is quietable here).
- P2.5 receipt polling, additional categories.
