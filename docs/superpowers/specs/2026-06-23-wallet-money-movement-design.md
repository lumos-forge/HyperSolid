# Wallet Money Movement (Phase B) — Design

> **Status:** Design for the v8-deviations Phase B. Brainstormed autonomously (user delegated the decision: "work autonomously, make good decisions"). Scope chosen = the recommended Option A. **User to review.**

## Goal

Give the non-custodial wallet real **Withdraw** (funds out of Hyperliquid) and an honest **Deposit** entry point, replacing the placeholder "coming soon" alerts shipped in v8 unit 9 — without touching the Phase 2 wallet-security layer or the Phase 3 order-encoding core.

## Scope decision (this iteration)

| Slice | Decision | Why |
|---|---|---|
| **B1 Withdraw** | **Build now**, real, via the SDK `ExchangeClient.withdraw3({destination, amount})` | Fully supported by the SDK; signs with the existing local viem account; mirrors the order-submit pattern we already trust. |
| **B2a Deposit (address view)** | **Build now**: show the wallet's own address + a Copy action + an honest Arbitrum-bridge explainer | Zero-signing, zero-risk, immediately useful. Adds one official Expo dep (`expo-clipboard`). |
| **B2b Deposit (in-app Arbitrum transfer)** | **Defer** | HL deposit = an Arbitrum USDC ERC-20 transfer to the bridge contract. Needs new EVM-transport infra (Arbitrum RPC, USDC + bridge constants, gas, tx tracking) — its own spec. |
| QR code for deposit | **Defer** (follow-up) | Nice-to-have; needs a community native dep. A copyable address + instructions is honest and sufficient now. |

## Architecture

Follow the existing seams exactly:

- **Service layer** (`src/services/exchange.ts`): add `withdrawUsdc(req)` to `ExchangeService`, and `withdraw3` to the injectable `ExchangeLike` interface (so tests inject a fake — **no real transfer in tests**). The real `createExchangeClient(network, viemAccount)` already returns an `ExchangeClient` that exposes `.withdraw3()`; signing happens inside it.
- **UI layer** (`src/screens/AccountScreen.tsx`): the existing `Deposit` / `Withdraw` buttons open inline panels (a `sheet` state machine: `"none" | "deposit" | "withdraw"`), rendered as `SurfaceCard`s. No new navigation.
- **No changes** to `src/wallet/*` (key custody/signing), `src/lib/hyperliquid/{buildOrder,order,cancel}.ts`, or the `IntentLedger`.

## B1 — Withdraw flow

```
Wallet (local) → tap Withdraw → panel:
  amount (USDC), destination (defaults to own address), shows withdrawable + HL fee note
  → Confirm (disabled until valid) → ExchangeService.withdrawUsdc()
     ├─ validate: destination 0x+40hex, amount>0, amount ≤ withdrawable  → reject in-app (no network)
     ├─ success: client.withdraw3({destination, amount: String(amount)})  → "Withdrawal submitted"
     └─ throw (network/timeout): { ok:false, uncertain:true } → honest "may or may not have been submitted; check before retrying"
```

- **Result type:** `WithdrawResult = { ok:true; response? } | { ok:false; error:string; uncertain?:boolean }`, reusing the existing `errorMessage()` helper. Same honesty principle as orders: never claim success on an uncertain receipt.
- **Safety:** disabled in view-only mode; the panel shows the active network (testnet via the asymmetric `NetworkWarning` strip); explicit Confirm; amount validated against `withdrawable` (from the account summary the screen already loads). Tests default to testnet and inject a fake client — never a real withdrawal.
- **Validation copy** stays Chinese to match the existing, untouchable order-rejection messages (`rejectionMessage`), keeping the wallet's transient dialogs consistent.

## B2a — Deposit (address) flow

```
Wallet (local) → tap Deposit → panel:
  "Deposit USDC on Arbitrum" explainer + the wallet's own address (mono, selectable)
  + Copy button (expo-clipboard) + warning: only send USDC on Arbitrum to the Hyperliquid bridge.
```

- Pure display + copy. No signing, no network. View-only shows the address read-only (copy still available — it's their own address to fund).

## Testing

- `ExchangeService.withdrawUsdc`: TDD with a fake `ExchangeLike.withdraw3`. Assert (a) invalid destination / non-positive / over-balance reject **without** calling `withdraw3`; (b) a valid request calls `withdraw3` with exactly `{destination, amount: "<string>"}` and returns `ok:true`; (c) a thrown client error yields `ok:false, uncertain:true`.
- `AccountScreen`: Deposit panel renders the address + Copy; Withdraw panel renders amount/destination + Confirm; Confirm with an over-balance amount surfaces the rejection and does not call the service; a valid Confirm calls the (mocked) service. View-only hides/disables Withdraw.

## Open questions (for the user, non-blocking)

1. **Mainnet enablement gating:** should Withdraw require an extra confirmation on mainnet (real money) beyond the standard Confirm? (Default shipped: standard Confirm + the always-visible network strip; easy to add a mainnet-only double-confirm later.)
2. **Withdraw fee display:** HL charges a flat withdraw fee. Source/show the exact fee, or show a static "a network fee applies" note? (Default shipped: static note; wire the exact fee when a fee source is chosen.)
3. **QR + in-app Arbitrum deposit (B2b):** prioritize next, or leave deposit as address-only?

## Out of scope (explicit)

- In-app Arbitrum bridge deposit transfer (B2b) — separate spec.
- Spot transfers / `usdSend` / `spotSend` — not requested.
- Any change to key custody, signing internals, or the order/ledger kernels.
