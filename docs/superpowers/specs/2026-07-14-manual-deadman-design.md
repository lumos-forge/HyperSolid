# Manual-Trader Client-Side Dead-Man Switch — Design

> **Status:** approved design. Scope: an opt-in client-side dead-man for **manual** traders (gap A2's
> remaining piece). While the app is foregrounded it keeps an HL `scheduleCancel` armed; if the app is
> backgrounded/killed, the schedule fires and cancels all resting orders.

## Context

The agentic engine has a server-side dead-man (`scheduleCancel` heartbeat) for **offline agentic**
users (`engine/deadMan`, durable budget #110). But a **pure manual trader** who places resting limit
orders and then loses the app (crash/kill/lost phone) has **no protection** — their orders stay live.
Gap analysis A2 flagged scheduleCancel as a general safety primitive that should also cover manual
trading.

HL `scheduleCancel { time }`: `time ≥ now+5s`; at `time` it cancels **all** resting orders for the
account; omitting `time` clears the schedule. Refreshing a still-future schedule is **free**; a counting
arm is capped at **10/day** per account (00:00 UTC reset). The manual trader's **local wallet** signs it
(same wallet that signs manual orders — non-custodial).

## Decisions (locked)

- **Opt-in, default OFF** — a Settings toggle with clear copy ("auto-cancel all orders N minutes after
  the app closes"). Auto-cancellation is a perceptible behavior, so never on by default.
- **TTL user-selectable: 1 / 2 / 5 minutes** (default 2). The heartbeat refreshes at an interval < TTL.
- **Arm always while enabled + foregrounded** (no order-gating) — no race where an order placed right
  before backgrounding is unprotected; arming with no resting orders is harmless.
- **≤10/day counting-arm budget guard** (refresh is free; a re-arm after expiry counts; skip when
  exhausted) — mirrors the engine's dead-man budget semantics.

## Interaction with the agentic (server-side) dead-man

Both target the single per-account HL scheduled-cancel (last-write-wins; refresh free). This is benign:
the more-frequent refresher dominates and both want the account protected. A **pure manual** user has no
server-side dead-man, so this fills the gap. For an **overlap** user (manual orders + running agentic
dead-man), the server keeps refreshing the schedule while the manual app is backgrounded, so the manual
switch is effectively a no-op for them (harmless). On **disable**, the manual switch clears its schedule
(brief gap the server re-fills next tick).

## Architecture / data flow

```
Settings toggle → deadManStore { enabled, ttlMinutes }   (persisted)
App-wide useManualDeadMan() (mounted like useLiveMarkets):
   AppState "active" + enabled + local wallet →
      every heartbeat (< TTL): budget.decide → arm scheduleCancel(now + TTL*60s) via local-wallet client
   AppState "background"      → stop the interval (schedule fires at TTL if unrefreshed)
   disable / sign-out         → scheduleCancel({}) clear
```

## Components (all in `mobile/`)

### 1. `state/deadManStore.ts`

zustand + persist: `{ enabled: boolean; ttlMinutes: 1 | 2 | 5; setEnabled; setTtlMinutes }`. Default
`{ enabled: false, ttlMinutes: 2 }`. Persisted (survives restart) so the user's choice sticks.

### 2. `services/exchange.ts` — `scheduleCancel`

- `ExchangeLike` gains `scheduleCancel(params: { time?: number }): Promise<unknown>`.
- `ExchangeService.scheduleCancel(time?)` wraps it (uncertain-receipt honest, like `approveAgent`):
  arms when `time` is set, clears when omitted. Returns `{ ok } | { ok:false, error, uncertain? }`.

### 3. `lib/deadManBudget.ts` — pure ≤10/day guard

Ported from the engine's pure semantics: `decideArm(prev, nowMs, ttlMs) → { skip } | { skip:false,
time, counts }` and `nextArm(prev, nowMs, time, counts) → { day, count, armedUntil }` with
`DEADMAN_MAX_PER_DAY = 10`. A refresh (armedUntil > now) is free; a fresh arm counts; exhausted → skip.
Pure + unit-tested (no HL involved).

### 4. `hooks/useManualDeadMan.ts`

App-wide hook (mounted once, like `useLiveMarkets` in `App.tsx`):
- Reads `deadManStore` (enabled, ttlMinutes), the wallet (`walletStore`), and the network.
- When **enabled + AppState active + local wallet present**: builds a `scheduleCancel` client
  (`createExchangeClient(network, account)` → `ExchangeService`), starts an interval (~TTL/2, min 20s)
  that, per tick, runs the budget guard and — unless skipped — arms `scheduleCancel(now + ttlMs)`. Fail-
  safe: a signing/network error just skips this tick (retried next), never throws.
- On **AppState → background/inactive**: clears the interval (the armed schedule fires at TTL).
- On **disable or sign-out** (enabled → false / wallet gone): clears the interval AND fires a one-shot
  `scheduleCancel({})` to remove the schedule (no surprise cancellation while the user is active).
- Holds the per-owner budget state in a ref (reset on wallet/day change).

### 5. `SettingsScreen` — toggle + TTL picker

A "safety" row group: a `Toggle` for enable + a `SheetSelect` for 1/2/5 min (shown when enabled), with
i18n copy explaining the behavior. Follows the existing biometric/quiet-hours toggle patterns.

### i18n / conventions

New `deadMan.*` keys (en + zh parity, enforced by `messages.test.ts`): title, description, the 1/2/5-min
labels, enabled/disabled toasts. Theme tokens only (no hardcoded hex).

## Error handling

- Signing/network failure on an arm → skip this tick, retry next (fail-safe; never blocks the UI).
- Budget exhausted (10/day) → skip arming; the last-armed schedule still stands until it expires.
- The clear-on-disable `scheduleCancel({})` is best-effort (a thrown receipt is logged, not surfaced as
  a hard error).

## Testing (`cd mobile && npx tsc --noEmit && npm test`)

- **`deadManBudget`:** refresh is free; a fresh arm counts; exhausted → skip; day rollover resets.
- **`ExchangeService.scheduleCancel`:** forwards `{ time }` (arm) / `{}` (clear); an uncertain receipt
  is reported, not assumed ok.
- **`useManualDeadMan`:** with fake timers + a mocked `AppState` + a fake client — arms on active+enabled,
  refreshes without extra counting, stops on background, clears (`scheduleCancel({})`) on disable and on
  sign-out, and skips when the budget is exhausted; does nothing when disabled or no wallet.
- **i18n parity** (`messages.test.ts`) and **no hardcoded colors** guard stay green.

## Decomposition (single PR, 3 steps)

1. `deadManStore` + `ExchangeService.scheduleCancel` + `lib/deadManBudget` (+ tests).
2. `useManualDeadMan` hook (+ tests) and app-wide mount.
3. `SettingsScreen` toggle + TTL picker + i18n (+ tests).

## Out of scope

- Coordinating explicitly with the server-side agentic dead-man (the benign last-write-wins interaction
  is accepted; no cross-signaling).
- Per-order or per-coin selective cancel (HL scheduleCancel is account-wide by design).
