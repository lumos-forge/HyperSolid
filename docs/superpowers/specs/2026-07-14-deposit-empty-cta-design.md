# Zero-Balance Deposit CTA — Design

> **Status:** approved design. Scope: the discoverability half of gap C2 ("new user with no USDC can't
> start"). The deposit *education + flow* already exists (AccountScreen deposit sheet: native-USDC /
> Arbitrum One / 5-USDC-min / gas warnings + QR + copy + irreversibility confirm). This adds a
> zero-balance **call-to-action** that guides a funded-zero user into that flow.

## Context

A brand-new local wallet has **0 USDC on Hyperliquid**. Today:
- **AccountScreen** shows balances but no prompt to fund.
- **TradeScreen** just disables the submit button (`notional >= 10` + no balance) with no guidance.
- The complete deposit sheet exists but is only reachable by tapping "Deposit" in Account.

So a new user is left at a dead end. This adds a clear CTA — no new deposit UI, just discoverability.

## Goal

When a connected **local** wallet has a **withdrawable balance of 0** (loaded, not still-loading):
- **AccountScreen**: a prominent "Deposit USDC to start trading" card that opens the existing deposit sheet.
- **TradeScreen**: a "No USDC — deposit to start" CTA that navigates to Account and **auto-opens** the
  deposit sheet (one tap).

No change when the balance is unknown (loading), non-zero, or the wallet is view-only/absent.

## Architecture / data flow

```
useAvailableBalance(address) → withdrawable: number | null   (null = loading)

AccountScreen: local && withdrawable === 0 → <DepositCta> card → setSheet("deposit")
TradeScreen:   local && available === 0    → <DepositCta> → depositIntent.request() + navigation.navigate("Account")
depositIntentStore { requested } ── AccountScreen (on mount/focus) → if requested: setSheet("deposit"); clear()
```

## Components (all in `mobile/`)

### 1. `state/depositIntentStore.ts`

A tiny zustand flag for the cross-tab one-tap open: `{ requested: boolean; request(): void; consume(): boolean }`
(`consume` returns the flag and clears it — so AccountScreen opens the deposit sheet at most once per intent).

### 2. `components/DepositCta.tsx`

A small presentational CTA card: icon + title + subtitle + a primary button, theme-token styled (no
hardcoded hex). Props `{ onPress; title; subtitle; cta }` (strings passed in so both callers control
copy + i18n). Reused by both screens for a consistent look.

### 3. `AccountScreen`

- Track the loaded portfolio's `withdrawable` (it already loads the portfolio; expose the summary
  balance in state — e.g. `accountBalance: number | null`).
- When `mode === "local"` and `accountBalance === 0`, render `<DepositCta>` (near the top of the account
  content) whose button calls the existing `onDeposit()`/`setSheet("deposit")`.
- On mount/focus, if `depositIntentStore.consume()` is true, open the deposit sheet (`setSheet("deposit")`)
  — this is how a Trade-tab tap lands directly on the sheet.

### 4. `TradeScreen`

- When `mode === "local"` and `available === 0` (loaded), render a `<DepositCta>` (compact, near the
  submit area) whose button calls `depositIntentStore.request()` then `navigation.navigate("Account")`.
- TradeScreen already receives `navigation` (bottom-tab); if not typed, thread it like the existing
  screens (`AccountStack` passes a `navigation.navigate` shim).

### i18n / conventions

New `deposit.cta*` keys (en + zh parity): the Account card title/subtitle/button and the Trade CTA
title/subtitle/button. Theme tokens only.

## Detection rules

- `withdrawable === 0` exactly (a truly funded-zero account). A non-zero-but-insufficient balance is the
  existing disabled-button case and is **out of scope**.
- Only when the balance is **loaded** (`!== null`) — never flash the CTA while loading.
- Only for `mode === "local"` (a view-only address can't deposit from the app).

## Error handling

- Purely additive UI; no network/signing. The CTA just opens the (already fail-safe) deposit sheet.
- If the balance fails to load (`null`), no CTA is shown (no false "you have no funds").

## Testing (`cd mobile && npx tsc --noEmit && npm test`)

- **`depositIntentStore`:** `request` sets the flag; `consume` returns true once then false.
- **`DepositCta`:** renders the passed strings; the button fires `onPress`.
- **AccountScreen:** shows the CTA when local + balance 0; hides it when balance non-zero / loading /
  view-only; the CTA opens the deposit sheet; a pending deposit intent opens the sheet on mount.
- **TradeScreen:** shows the CTA when local + available 0; the button sets the intent + navigates to
  Account; hidden otherwise.
- **i18n parity** (`messages.test.ts`) + **no-hardcoded-colors** stay green.

## Decomposition (single PR, 3 steps)

1. `depositIntentStore` + `DepositCta` component + i18n (+ tests).
2. AccountScreen: zero-balance CTA + intent-consume-on-mount (+ tests).
3. TradeScreen: zero-balance CTA → intent + navigate (+ tests).

## Out of scope

- Any change to the deposit sheet / education (already complete).
- "Where to buy Arbitrum USDC" fiat-onramp guidance.
- The per-order "insufficient for this order" case (existing disabled button).
