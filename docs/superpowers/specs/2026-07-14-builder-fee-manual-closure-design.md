# Builder-Fee Manual-Trading Closure — Design

> **Status:** approved design. Scope: wire the existing (but unused) builder-fee plumbing so manual
> trades actually earn the builder fee — the documented #1 severity gap (gap analysis A1).

## Context

The mobile app already has all the builder-fee *plumbing* but none of the *wiring*:
- `buildOrder` / `buildBracketOrder` / `buildScaleOrder` accept an optional `builder: { address, feeTenthBps }`
  and emit `params.builder = { b, f }` (cap-validated per market kind in `builderField`).
- `builderFee.ts` has `BUILDER_FEE_CAP_TENTH_BPS` (perp 100, spot 1000), `isBuilderFeeWithinCap`,
  `tenthBpsToPercent`, and `buildApproveBuilderFee`.
- `@nktkas/hyperliquid` exposes `ExchangeClient.approveBuilderFee({ maxFeeRate, builder })` (main-wallet
  signed) and `InfoClient.maxBuilderFee({ user, builder }) → number` (approved rate in tenth-bps).

But **no runtime path attaches a builder code**, there is **no server-delivered builder config**, and
there is **no `approveBuilderFee` onboarding**. Result: every manual order carries no builder → the app
earns **zero builder revenue**.

## Goal

Close the loop for **manual trading (perps)**: a server-delivered builder config, a one-time
`approveBuilderFee` gate before the first fee-bearing order, and the builder code attached to every
manual order (single / bracket / scale). The agentic-engine order path (needs Go-signer changes) is a
**separate follow-up unit**.

## Decisions (locked)

- **Fee rate:** perps **0.02% = 20 tenth-bps**, server-delivered (tunable later).
- **Approve rate:** approve at the perp **cap 0.1% (100 tenth-bps)** so the server can tune the
  per-order fee up to the cap without forcing users to re-approve.
- **Approve UX:** lazy, pre-first-order. Check `maxBuilderFee`; if under the needed rate, show a one-time
  approve sheet (main wallet signs), then place. Cached so it does not re-prompt.
- **Fail-open:** if the approval check errors or the user declines/approve fails, **place the order
  anyway without a builder** (trade UX wins; the builder fee is value-add, not a gate). Do not re-nag in
  the same session.
- **TWAP is excluded:** HL's `twapOrder` action has no builder field (SDK-confirmed).
- **Zero-config safe:** absent/invalid builder config → feature is dark (no builder attached, no
  approve prompt), exactly like the empty `proxyPool` pattern. Ships safely before ops sets a real
  registered-builder address.

## Architecture / data flow

```
server /app-config  ──►  builder: { address, perpFeeTenthBps }   (omitted → feature off)
        │
mobile loadAppConfig ──►  runtimeConfigStore.builder
        │
TradeScreen place ──►  ensureBuilderApproved(user)         [lazy, before the first order]
   ├─ no builder config → skip (place without builder)
   ├─ cached approved   → place with builder
   ├─ maxBuilderFee(user, builder) ≥ perpFeeTenthBps → cache approved → place with builder
   └─ else → show one-time approve sheet
          ├─ user approves → approveBuilderFee(maxFeeRate="0.1%", builder) [main wallet]
          │      ├─ ok   → cache approved → place with builder
          │      └─ fail → place WITHOUT builder (suppress re-prompt this session)
          └─ user declines → place WITHOUT builder (suppress re-prompt this session)

ExchangeService(builderConfig) ──►  attaches { address, feeTenthBps } to single/bracket/scale req
                                    (buildOrder caps by market kind; TWAP untouched)
```

## Components

### 1. Config plumbing (`server/src/config/appConfig.ts`, `mobile/src/services/appConfig.ts` + store)

- Server `/app-config` gains an optional `builder: { address: 0x…, perpFeeTenthBps: number }` sourced from
  env (e.g. `BUILDER_ADDRESS`, `BUILDER_PERP_FEE_TENTH_BPS`), omitted when unset.
- Mobile `RawAppConfig` + `AppRuntimeConfig` gain `builder?: { address; perpFeeTenthBps } | null`.
  Parse defensively: require a `0x`+40-hex address and an integer `perpFeeTenthBps` in `[1, 100]`;
  otherwise treat as absent (null). No hardcoded fallback.

### 2. Builder attachment (`mobile/src/services/exchange.ts`)

- `ExchangeService` takes an optional `builderConfig?: { address: 0x…; perpFeeTenthBps: number }`.
- A private `withBuilder(req)` merges `builder: { address, feeTenthBps: perpFeeTenthBps }` into an
  `OrderRequest` when `builderConfig` is set and the request has no explicit builder. Applied in
  `placeOrder`, `placeBracket` (on `entry`), and `placeScale`. `placeTwap` is left unchanged.
- No change to the existing idempotency/reconcile pipeline; `buildOrder`'s cap check remains the
  fail-safe (an over-cap fee → `builderFeeRejected`, surfaced as today).

### 3. Approval gate (`mobile/src/services/builderApproval.ts` + TradeScreen)

- New `BuilderApproval` service: `ensureApproved({ user, builder, perpFeeTenthBps })` returning
  `"approved" | "unapproved" | "unknown"` using `InfoClient.maxBuilderFee`. Positive result is cached
  (module/store state) so later orders skip the query.
- `ExchangeLike` gains `approveBuilderFee({ maxFeeRate, builder })`; `ExchangeService.approveBuilderFee(rate)`
  wraps it with the same uncertain-receipt honesty as `approveAgent` (never assume success on a thrown
  receipt).
- TradeScreen (or a small `useBuilderApprovalGate` hook) runs the lazy gate before the first order:
  shows the one-time approve sheet on `unapproved`, calls `approveBuilderFee` on confirm, and follows the
  fail-open rules above. A session-scoped `suppressed` flag prevents re-nagging after a decline/error.

### UX / conventions

- The approve sheet + toasts use `i18n/messages.ts` (en + zh parity) and theme tokens only (no hardcoded
  hex, per the design-system guard). Copy explains: a one-time signature lets the app collect a 0.02%
  builder fee on trades; it can never move or withdraw funds.

## Error handling

- Approval **query error** → `"unknown"` → place without builder, no prompt (retry cheaply next order /
  next session).
- User **declines** or **approve fails** → place without builder; set session `suppressed`.
- **Uncertain approve receipt** (network/timeout on `approveBuilderFee`) → treated as not-approved
  (place without builder); never cached as approved.
- **Over-cap fee** (misconfig) → `buildOrder` returns `builderFeeRejected` (existing behavior), so a bad
  config can never silently place at an illegal fee.

## Testing (`cd mobile && npx tsc --noEmit && npm test`)

- **appConfig:** parses a valid `builder`; drops an invalid address / out-of-range `perpFeeTenthBps` /
  absent block to `null`.
- **ExchangeService:** with a `builderConfig`, `placeOrder` / `placeBracket` / `placeScale` submit
  `params.builder = { b: address, f: 20 }`; `placeTwap` never carries a builder; with no config, no
  builder is attached (unchanged behavior); an explicit `req.builder` is not overwritten.
- **BuilderApproval:** `maxBuilderFee ≥ rate` → approved (+cached, second call skips the query);
  `< rate` → unapproved; a thrown query → unknown; `approveBuilderFee` sends `maxFeeRate = "0.1%"` and the
  configured builder; an uncertain receipt is not cached as approved.
- **Gate (hook/screen):** prompts once on unapproved; on approve success places with builder; on
  decline/error places without builder and does not re-prompt in the session; skipped entirely when no
  builder config.

## Decomposition (single PR, 3 steps)

1. **Config plumbing** — server `/app-config` `builder` block + mobile parse/store (+ tests).
2. **Builder attachment** — `ExchangeService.builderConfig` + `withBuilder` on single/bracket/scale
   (+ tests).
3. **Approval gate** — `BuilderApproval` service + `ExchangeLike.approveBuilderFee` + the one-time
   approve sheet/hook wired into TradeScreen + i18n (+ tests).

## Out of scope

- Agentic-engine builder attachment (requires the Go signer's `BuildOrderAction` to carry `builder` +
  policy) — a separate follow-up unit.
- Spot builder fees (product is perps-only).
- TWAP builder fee (unsupported by HL `twapOrder`).
