# M7 P4.5-server — Strategy-Completed Push + `lifecycle` Category (server)

Date: 2026-07-12
Status: Approved

## Context

The push module currently notifies two kinds of event: `fills` (per-order fills)
and `alerts` (dead-man protection). When a strategy actually *finishes* its job —
a TWAP completing its last slice, or a TP/SL trigger firing — the user gets no
notification. This unit adds a "strategy completed" push under a new, independently
toggleable `lifecycle` category. The mobile toggle UI for the new category is a
separate follow-up (P4.5-mobile).

Strategy completion is an intrinsic status transition that happens in exactly two
store methods: `recordFill` (TWAP, when `slicesDone >= slices`) and `recordTrigger`
(TP/SL). DCA / grid / gridLimit never auto-complete. Because the strategy store is
constructed *before* the `Notifier` in `index.ts`, and to keep the notification
concern out of the persistence layer, we mirror the existing `NotifyingActivityStore`
pattern with a `NotifyingStrategyStore` decorator rather than a store callback.

## Goal

When a strategy transitions to `completed`, send its owner a localized "strategy
completed" push under the `lifecycle` category (default on, independently
toggleable, suppressible by quiet hours). No behavior change for users who never
complete a strategy.

## Categories

`PushCategory` becomes `"fills" | "alerts" | "lifecycle"`.
- `fills` — order fills (unchanged).
- `alerts` — dead-man protection (unchanged, always bypasses quiet hours).
- `lifecycle` — strategy completed (new).

Quiet hours suppress the non-safety categories `{ fills, lifecycle }`; `alerts`
always send.

## Design

### 1. `server/src/push/pushPrefStore.ts`

```ts
export type PushCategory = "fills" | "alerts" | "lifecycle";
export interface PushPrefs { fills: boolean; alerts: boolean; lifecycle: boolean; }
const CATEGORIES: PushCategory[] = ["fills", "alerts", "lifecycle"];
```
`get(owner)` returns each category defaulting to `true` (add `lifecycle: map.get("lifecycle") ?? true`). `isEnabled` and `set` are already category-generic and need no change beyond the widened type/list.

### 2. `server/src/push/messages.ts`

Add to each locale block:
```ts
// en
lifecycleTitle: "Strategy completed",
lifecycleBody: (coin: string, kind: string) => `Your ${coin} ${kind} strategy finished.`,
// zh
lifecycleTitle: "策略已完成",
lifecycleBody: (coin: string, kind: string) => `你的 ${coin} ${kind} 策略已完成。`,
```

### 3. `server/src/push/notifications.ts`

```ts
import type { Strategy } from "../strategies/types";

/** Strategy-completed notification, localized. */
export function strategyCompletedNotification(s: Strategy, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  const coin = (s.params as { coin?: string }).coin ?? "";
  return {
    title: m.lifecycleTitle,
    body: m.lifecycleBody(coin, s.kind),
    data: { kind: "strategy_completed", strategyId: s.id, strategyKind: s.kind, coin },
  };
}
```

### 4. `server/src/strategies/notifyingStrategyStore.ts` (new)

A decorator implementing `StrategyStore`, mirroring `NotifyingActivityStore`:

```ts
export class NotifyingStrategyStore implements StrategyStore {
  constructor(
    private readonly inner: StrategyStore,
    private readonly notifier: Pick<Notifier, "notify">,
  ) {}
  // completion-producing methods: capture prior status, delegate, then fire on transition
  setStatus(id, status)          { const b = this.inner.get(id)?.status; this.inner.setStatus(id, status); this.fireIfCompleted(id, b); }
  recordFill(id, quote, nextRun)  { const b = this.inner.get(id)?.status; this.inner.recordFill(id, quote, nextRun); this.fireIfCompleted(id, b); }
  recordTrigger(id, now)          { const b = this.inner.get(id)?.status; this.inner.recordTrigger(id, now); this.fireIfCompleted(id, b); }
  // all other methods delegate straight through (create/get/list/listAll/seedGridLevel/
  //   recordGridAction/gridLimitRungs/setGridLimitRung/addFilledUsdc/remove)
}
```

`fireIfCompleted(id, before)`:
```ts
private fireIfCompleted(id: string, before: StrategyStatus | undefined): void {
  const s = this.inner.get(id);
  if (!s || before === "completed" || s.status !== "completed") return;
  try {
    void Promise.resolve(
      this.notifier.notify(s.owner, "lifecycle", (locale) => strategyCompletedNotification(s, locale)),
    ).catch(() => {});
  } catch {
    // fire-and-forget: a broken notifier must never break strategy persistence
  }
}
```

This exactly follows the fire-and-forget + swallow-sync-throw + swallow-async-reject
pattern already used in `NotifyingActivityStore`.

### 5. `server/src/push/notifier.ts` — quiet hours covers lifecycle

Replace the `fills`-only quiet-hours condition with a small quietable set so both
`fills` and `lifecycle` are suppressible:

```ts
const QUIETABLE = new Set<PushCategory>(["fills", "lifecycle"]);
// ...in notify, after the prefs gate:
if (QUIETABLE.has(category) && this.quietHours) {
  try {
    if (this.quietHours.isQuietNow(owner, this.now())) return result; // quiet → skip
  } catch (err) {
    this.log("push quiet-hours lookup failed", err); // fail-open
  }
}
```

`alerts` is not in the set, so it always bypasses quiet hours.

### 6. `server/src/http/app.ts` — `/push/prefs` route

The POST validation loop iterates the full category list:
```ts
for (const key of ["fills", "alerts", "lifecycle"] as const) { /* unchanged body */ }
```
GET returns `deps.pushPrefs.get(owner)` (now including `lifecycle`).

### 7. Wiring (`server/src/index.ts`)

After the `Notifier` is created (and after the raw `store`), wrap the store:
```ts
const notifyingStore = new NotifyingStrategyStore(store, notifier);
```
Pass `notifyingStore` everywhere the strategy store is consumed for reads/writes that
should observe completion — i.e. the scheduler `tick(...)` call and `buildApp({ store: notifyingStore, ... })`. (The dead-man `staleDeadManOwners`/`listAll` calls can keep using the raw `store`; they never complete strategies.)

## Data flow

```
scheduler tick → recordFill(twap last slice) / recordTrigger(tpsl)
  → NotifyingStrategyStore detects running→completed
    → notify(owner, "lifecycle", (l) => strategyCompletedNotification(s, l))
      → prefs.isEnabled(owner,"lifecycle")? false → skip
      → quietHours.isQuietNow? (lifecycle is quietable) true → skip
      → tokensForOwner / per-locale render / send
```

## Error handling / compatibility

- `lifecycle` defaults to on → existing users start receiving completion pushes with
  no config; no regression to `fills`/`alerts`.
- The decorator is fail-safe: a throwing/ rejecting notifier can never break strategy
  persistence (mirrors `NotifyingActivityStore`).
- Only a genuine `running`→`completed` transition fires (idempotent re-writes or
  already-completed strategies do not re-notify).
- P5b-mobile's UI reads `{ fills, alerts }` structurally and simply ignores the extra
  `lifecycle` field until P4.5-mobile adds its toggle row.
- `notify` remains fail-safe; quiet-hours/pref gates unchanged in behavior for
  `fills`/`alerts`.

## Testing

- `pushPrefStore.test.ts` — fresh `get` includes `lifecycle: true`; `set({lifecycle:false})`
  then `get` reflects it; `isEnabled(owner,"lifecycle")` default true.
- `notifications.test.ts` — `strategyCompletedNotification` en/zh title + body (coin+kind)
  + `data.kind === "strategy_completed"` with `strategyId`.
- `notifyingStrategyStore.test.ts` — a TWAP whose last `recordFill` completes it fires
  exactly one `notify(owner,"lifecycle",render)`; `recordTrigger` (tpsl) fires; a
  `recordFill` that does NOT complete fires nothing; `setStatus(id,"paused")` fires
  nothing; an already-completed strategy re-written fires nothing; a throwing notifier
  does not break the delegated call; read/passthrough methods return inner results.
- `notifier.test.ts` — `lifecycle` is suppressed during quiet hours (like fills);
  `alerts` still bypasses.
- `app.test.ts` — `GET /push/prefs` default now `{fills:true, alerts:true, lifecycle:true}`;
  `POST { lifecycle:false }` then `GET` reflects it; non-boolean `lifecycle` → 400.
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope / deferred

- Mobile `lifecycle` toggle row (P4.5-mobile — next unit).
- Notifications for DCA/grid ongoing progress, pause, or removal.
- Kill-switch / budget notifications.
