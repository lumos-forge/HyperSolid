# M7 P2.5 — Expo Push Receipt Polling & Delayed Token Pruning (server)

Date: 2026-07-11
Status: Approved

## Context

The `Notifier` (server/src/push/notifier.ts) prunes a device token only when the
**immediate** send ticket returns `DeviceNotRegistered`. But Expo delivers many
delivery failures **asynchronously** via push *receipts*: each successful send
ticket carries a receipt id, and the actual per-message outcome (including
`DeviceNotRegistered` for a token that has since become invalid) is only available
minutes later from `getPushNotificationReceiptsAsync`. Without polling receipts,
stale tokens accumulate and we keep sending to dead devices.

This unit (server-only) records receipt ids on successful sends and polls them on a
timer, pruning tokens that come back `DeviceNotRegistered`.

## Goal

After a successful send, remember each receipt id → token. On a periodic poll, fetch
receipts, prune the token for any receipt that reports `DeviceNotRegistered`, log
other errors without pruning, and clean up processed and long-stale receipt rows.

## Pruning policy

Only `DeviceNotRegistered` receipts prune a token (Expo's recommended practice).
Other receipt errors (`MessageRateExceeded`, `MessageTooBig`, `InvalidCredentials`,
etc.) are logged and their receipt rows removed, but the token is kept — those are
not token-invalidation signals.

## Design

### 1. `server/src/push/pushReceiptStore.ts` (new — SQLite)

```sql
CREATE TABLE IF NOT EXISTS push_receipts (
  receipt_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Interface:

```ts
export interface PendingReceipt { receiptId: string; token: string; }

export interface PushReceiptStore {
  /** Remember a receipt id → token (idempotent by receipt_id). */
  record(receiptId: string, token: string, now: number): void;
  /** Oldest-first pending receipts, up to `limit`. */
  pending(limit: number): PendingReceipt[];
  /** Delete the given receipt rows (processed). No-op on empty. */
  remove(receiptIds: string[]): void;
  /** Delete receipt rows created before cutoffMs (never got a receipt). */
  pruneOlderThan(cutoffMs: number): void;
}
```

- `record` → `INSERT OR IGNORE` (a resend with the same receipt id is harmless).
- `pending` → `SELECT receipt_id, token ... ORDER BY created_at ASC LIMIT ?`.
- `remove` → parameterized `DELETE ... WHERE receipt_id IN (...)`; empty list is a
  no-op.
- `pruneOlderThan` → `DELETE ... WHERE created_at < ?`.

### 2. `Notifier` records receipt ids

Add an optional dep and record on success:

```ts
export interface NotifierDeps {
  // ...existing...
  receipts?: Pick<PushReceiptStore, "record">;
}
```

In the ticket loop, in the `status === "ok"` branch (a success ticket has `id`):

```ts
if (ticket.status === "ok") {
  if (this.receipts && ticket.id && token) {
    try {
      this.receipts.record(ticket.id, token, this.now());
    } catch (err) {
      this.log("push receipt record failed", err); // fail-safe
    }
  }
  result.sent++;
  continue;
}
```

When `receipts` is not injected, behavior is unchanged. `this.now()` already exists
(added for quiet hours; defaults to `Date.now`).

### 3. `server/src/push/receiptPoller.ts` (new)

A seam over the receipt-side of expo-server-sdk (kept separate from `ExpoLike` so the
Notifier's fakes are unaffected):

```ts
import type { ExpoPushReceipt } from "expo-server-sdk";

export interface ExpoReceiptLike {
  chunkPushNotificationReceiptIds(ids: string[]): string[][];
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

export interface PollDeps {
  expo: ExpoReceiptLike;
  receipts: Pick<PushReceiptStore, "pending" | "remove" | "pruneOlderThan">;
  tokens: Pick<PushTokenStore, "deleteToken">;
  now: () => number;
  logger?: (msg: string, err?: unknown) => void;
  /** Max receipts to check per poll (default 1000). */
  batchLimit?: number;
  /** Rows older than this are pruned as never-resolved (default 24h). */
  maxAgeMs?: number;
}

export interface PollResult { checked: number; ok: number; pruned: number; errors: number; }
```

`pollPushReceipts(deps): Promise<PollResult>` — fail-safe (never throws):

1. `const result = { checked: 0, ok: 0, pruned: 0, errors: 0 };`
2. Wrap everything in try/catch → log and return `result` on any thrown error.
3. `const rows = receipts.pending(batchLimit)`. Build `tokenByReceipt` map.
4. If `rows.length > 0`:
   - `const ids = rows.map(r => r.receiptId)`; `const chunks = expo.chunkPushNotificationReceiptIds(ids)`.
   - For each chunk: `const map = await expo.getPushNotificationReceiptsAsync(chunk)`
     (per-chunk try/catch → on throw, log and skip that chunk).
   - For each `receiptId` in the chunk that is present in `map`:
     - `result.checked++`; push `receiptId` to `processed`.
     - `status === "ok"` → `result.ok++`.
     - `status === "error"` → `result.errors++`; log `receipt.message`; if
       `receipt.details?.error === "DeviceNotRegistered"`, prune the mapped token
       (`tokens.deleteToken(token)` in try/catch) and `result.pruned++`.
     - ids absent from `map` (receipt not ready yet) are left pending.
   - `receipts.remove(processed)`.
5. `receipts.pruneOlderThan(now() - maxAgeMs)` (always, even when nothing pending).
6. Return `result`.

### 4. Wiring (`server/src/index.ts`)

```ts
const pushReceipts = SqlitePushReceiptStore.open(dbPath);
const notifier = new Notifier({ expo, store: pushTokens, prefs: pushPrefs, quietHours, receipts: pushReceipts });
// ...
const expoInstance = new Expo(); // reused for both send and receipts
const receiptPollMs = Number(process.env.RECEIPT_POLL_MS ?? 15 * 60 * 1000);
const receiptTimer = setInterval(() => {
  void pollPushReceipts({ expo: expoInstance, receipts: pushReceipts, tokens: pushTokens, now })
    .catch(() => { /* pollPushReceipts is itself fail-safe */ });
}, receiptPollMs);
receiptTimer.unref?.();
```

- The real `Expo` instance already implements `chunkPushNotificationReceiptIds` and
  `getPushNotificationReceiptsAsync`, satisfying `ExpoReceiptLike` structurally.
- `clearInterval(receiptTimer)` is added to the existing `shutdown()`.
- `RECEIPT_POLL_MS` env overrides the 15-minute default.

## Data flow

```
send success (ticket.ok) → receipts.record(receiptId, token, now)
        ⟳ every RECEIPT_POLL_MS
pollPushReceipts:
  pending(1000) → getPushNotificationReceiptsAsync(chunks)
    ok        → remove row
    error+DeviceNotRegistered → deleteToken(token) + remove row
    error(other)              → log + remove row
    not-yet-available         → keep row
  pruneOlderThan(now - 24h)
```

## Error handling / compatibility

- `Notifier.receipts` optional → when absent, sends behave exactly as today.
- Recording a receipt id never affects the send outcome (try/catch).
- `pollPushReceipts` never throws; a failing receipts fetch skips that chunk;
  a failing `deleteToken` is logged and skipped.
- Receipts not yet available are retried on the next poll; rows that never resolve
  are reaped after `maxAgeMs` (24h).
- Only `DeviceNotRegistered` prunes a token.

## Testing

- `pushReceiptStore.test.ts` — `record` then `pending` returns it; oldest-first
  ordering; `record` is idempotent by receipt id; `remove` deletes only the listed
  ids and no-ops on empty; `pruneOlderThan` deletes rows below the cutoff and keeps
  newer ones.
- `notifier.test.ts` — with a `receipts` stub: an `ok` ticket records `(id, token)`;
  no `receipts` dep → no crash and still counts `sent`; a throwing `receipts.record`
  is swallowed and the send still counts `sent`. (Use `fakeExpo` tickets that carry
  an `id`.)
- `receiptPoller.test.ts` — ok receipt → removed, not pruned; `DeviceNotRegistered`
  → token pruned + removed; other error → logged + removed, not pruned; a receipt id
  absent from the response is left pending (not removed); empty pending → no fetch,
  still calls `pruneOlderThan`; `getPushNotificationReceiptsAsync` throwing → no
  throw, chunk skipped; correct `PollResult` counts. Inject `now`.
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope / deferred

- Backoff / adaptive poll cadence (fixed interval is enough).
- Persisting receipt *error* analytics beyond logging.
- Per-owner receipt metrics.
