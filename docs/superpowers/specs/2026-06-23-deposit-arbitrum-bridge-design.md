# Deposit via Arbitrum Bridge (Phase B2b) — Design

> **Status:** Design for Phase B2b (in-app Hyperliquid deposit). User chose **Option A** (build in-app
> transfer, skip QR) and the three sub-decisions: **RPC = user's own provider key (configurable, never
> hardcoded)**, **contract addresses pasted for the user to verify before use**, **mainnet adds a
> second confirmation**. **GATE: the contract constants below are PENDING USER VERIFICATION — do not
> write them into the money-moving transfer path until the user confirms.**

## Goal

Let a local (non-custodial) wallet deposit USDC into Hyperliquid **from inside the app**, by signing
an Arbitrum USDC transfer to the Hyperliquid bridge — eliminating the address-copy / wrong-sender
footgun of the address view. Hyperliquid credits the **sender**, so the app sending from the user's
own wallet is the only safe path.

## Mechanism (from official docs)

- Deposit = transfer **native USDC** (6 decimals) on **Arbitrum** to the **Bridge2** contract. Credited
  to the sender in <1 min. **Minimum 5 USDC** (less is lost forever).
- The user's wallet must hold **ETH on Arbitrum for gas** (a plain ERC-20 transfer costs gas). A fresh
  USDC-only wallet cannot deposit until funded with a little ETH — surface this clearly.
- (Future, out of scope) `batchedDepositWithPermit` enables a permit/relayer (gasless) flow.

## Contract constants — PENDING USER VERIFICATION

| | Mainnet (Arbitrum One, chainId 42161) | Testnet (Arbitrum Sepolia, chainId 421614) |
|---|---|---|
| Bridge2 | `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` | `0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89` |
| Native USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0x1baAbB04529D43a73232B713C0FE471f7c7334d5` |

Source: Hyperliquid Bridge2 docs (`hyperliquid.gitbook.io/.../api/bridge2`) + Arbiscan. **The user
verifies these before they are committed into the executable transfer path.**

## Decisions (locked)

1. **RPC:** the Arbitrum RPC URL (the user's provider key) is read from app config / env
   (`getArbitrumRpcUrl(network)` reading `EXPO_PUBLIC_ARBITRUM_RPC_MAINNET` / `…_TESTNET` or
   `app.json > expo.extra`). **Never hardcode or commit the key.** Tests inject a fake client.
2. **Addresses:** the table above, pending verification, will live in `src/lib/arbitrum/bridge.ts`
   constants once confirmed.
3. **Mainnet double-confirm:** on mainnet, the Confirm action requires a second explicit confirmation
   (a distinct "Yes, send real USDC" step) before signing. Testnet uses a single confirm.

## Architecture (new, isolated; existing seams untouched)

- `src/lib/arbitrum/deposit.ts` — pure, address-independent: `MIN_DEPOSIT_USDC`, `validateDeposit({amount, available?})`. (Built now — safe.)
- `src/lib/arbitrum/bridge.ts` — verified constants (chainId + USDC + bridge per network) + an `erc20TransferData` / address selector. (Built **after** the user confirms addresses.)
- `src/lib/arbitrum/client.ts` — `createArbitrumWalletClient(network, viemAccount)` over viem, RPC from config. ISOLATED like `fontAssets.ts` so native/config bits stay out of jest. Injected as a fake in tests.
- `src/services/deposit.ts` — `DepositService.depositUsdc({ amount, available })`: validate → (mainnet) require confirmed=true → `usdc.transfer(bridge, amount*1e6)` via the wallet client → return `{ ok, txHash } | { ok:false, error, uncertain? }`. Mirrors the order/withdraw honesty rules.
- `src/screens/AccountScreen.tsx` — replace the Deposit address panel with a deposit **form** (amount + min-5 hint + gas note; testnet single-confirm, mainnet two-step confirm). View-only disabled.

## Testing

- `validateDeposit`: amount ≤ 0, amount < 5, amount > available → reject; valid → ok. (Pure, no chain.)
- `DepositService.depositUsdc`: inject a fake wallet client; assert (a) invalid/under-min/over-balance reject **without** a chain call; (b) mainnet without the second confirm does **not** send; (c) a confirmed valid request calls `transfer` with the bridge address + `amount*1e6` and returns `ok` + txHash; (d) a thrown send → `uncertain`. **No real transfer in tests; testnet default.**
- `AccountScreen`: deposit form renders; mainnet shows the two-step confirm; confirm calls the (mocked) service.

## Honesty / safety rules

- Min 5 USDC enforced with an explicit "less is lost" message; native-USDC-only + Arbitrum-only made unmistakable; gas (ETH) requirement surfaced.
- Uncertain receipts never assumed successful; show the tx hash for the user to track.
- Mainnet two-step confirm; view-only has no deposit action; tests/CI default testnet.

## Out of scope

- Gasless/permit (`batchedDepositWithPermit`) deposits; bridging from other chains; QR (dropped — for HL it invites wrong-sender deposits).
