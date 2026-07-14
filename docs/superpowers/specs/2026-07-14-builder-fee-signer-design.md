# Delegated-Path Builder Fee (Sub-Unit B) — Design

> **Status:** approved design. Scope: thread the builder fee through the **delegated/signer** order path
> so agentic orders carry the builder even when `SIGNER_DELEGATION` is on. Hash-critical (Go signer + TS
> engine must build the same msgpack action). Completes the builder-fee story started in PR #111
> (mobile), #112 (engine local-key path).

## Context

The builder fee is attached on the mobile manual path (#111) and the engine's **local-key** path (#112,
sub-unit A). But the **delegated path** (`signerExchangeClient` → Go signer, active when
`SIGNER_DELEGATION` is on) does not carry a builder: the order action is built on **both** sides and
msgpack-hashed (the signer signs it; the engine submits the identical pre-signed action to HL), so a
builder must be added to **both** builders in lockstep or HL rejects the signature.

The HL `order` action field order is `{ type, orders, grouping, builder }` with
`builder = { b: address, f: feeTenthBps }` appended after `grouping` and **omitted when absent**
(@nktkas schema confirmed; `f` is 0.1bps, cap 100 for perps). The existing golden vectors
(`backend/internal/hl/testdata/golden.json`) + the parity tests (Go `golden_test.go`, TS
`l1Action.golden.test.ts` from PR #109) guard cross-language byte-equality.

## Goal

For an approved owner on the delegated path, the engine builds `{ type:"order", orders, grouping,
builder:{b,f} }`, has the signer sign exactly that, and submits it. Same approval-gating + fail-open as
sub-unit A (reuse the `BuilderInjector`). No change when no builder is attached (absent config /
unapproved owner) — the action is byte-identical to today.

## Architecture / data flow (delegated path)

```
makeClientFor delegated branch → wrapClientWithBuilder(signerBackedClient, owner, injector)
   (sub-unit A's wrapper now applied to the delegated branch too)

placer/resting → clientFor(owner).order({ orders:[o], grouping:"na" })
   └─ wrapper: b = await injector.builderFor(owner)   → merge { builder: b } when approved
signerExchangeClient.order({ orders, grouping, builder? }):
   params = { asset, isBuy, px, sz, reduceOnly, tif, grouping, cloid, builder? }
   ├─ signer.sign({ keyId, kind:"order", params, cloid, isTestnet })   → Go ActionFromKind builds {..., builder}
   ├─ action = l1Action.actionFromKindParams("order", params)          → TS builds the SAME {..., builder}
   └─ transport.request("exchange", { action, signature, nonce })      → HL accepts (hashes match)
```

## Components

### 1. Go signer (`backend/internal/hl/`)

- `action.go`:
  - `type BuilderInput struct { Address string; FeeTenthBps int64 }`.
  - `BuildOrderAction(orders []OrderInput, grouping string, builder *BuilderInput) Map` — when
    `builder != nil`, append `KV{"builder", Map{{"b", builder.Address}, {"f", builder.FeeTenthBps}}}`
    **after** the `grouping` entry; when nil, append nothing (HL omit rule).
  - Update the two `action_test.go` calls to pass `nil`; add a with-builder assertion.
- `digest.go` `ActionFromKind` "order" case: add `Builder *struct { B string `json:"b"`; F int64 `json:"f"` } `json:"builder"`` to the params struct; pass
  `builderInputFrom(p.Builder)` (nil when absent) to `BuildOrderAction`.
- `modify` / `batchModify` use `orderTuple` (no action-level builder in HL) → untouched.

### 2. Golden vectors (`mobile/scripts/gen-golden-vectors.mjs` + `backend/internal/hl/testdata/golden.json`)

- Extend `buildAction("order")`: after `grouping`, `if (p.builder) action.builder = p.builder;`.
- Add a vector: `{ name: "order-builder-mainnet", kind: "order", isTestnet: false, params: { asset: 0,
  isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na",
  builder: { b: "0x1111…1111", f: 20 } } }`.
- Regenerate: `cd mobile && node scripts/gen-golden-vectors.mjs`. The Go `golden_test.go` (rebuilds via
  `ActionFromKind`) and the TS `l1Action.golden.test.ts` (rebuilds via `actionFromKindParams`, iterates
  all order/cancelByCloid/scheduleCancel vectors) then both cover the new vector automatically.

### 3. TS engine (`server/src/agent/`)

- `l1Action.ts`:
  - `OrderParams` gains `builder?: { b: `0x${string}`; f: number }`.
  - `actionFromKindParams("order")`: after `grouping`, `if (p.builder) o_action.builder = { b: p.builder.b, f: p.builder.f }` (append last, matching the Go field order).
- `signerExchangeClient.ts` `order(arg)`:
  - `arg` type gains an optional `builder?: { b: `0x${string}`; f: number }` (the wrapper merges it).
  - Include `builder: arg.builder` in the sign `params` when present (so the signer's `ActionFromKind`
    builds it) — `l1Action` builds the submit action from the same params, so both match.
- `hlRuntime.ts` `makeClientFor`: apply `wrapClientWithBuilder` to the **delegated** branch too (not
  only local), so the signer-backed client's `order` receives `arg.builder`. Same injector, same
  approval-gating + fail-open.

## Correctness / parity

- The sign request `params` is the single source: the Go signer builds the action from it (`ActionFromKind`)
  and the TS engine builds the submit action from it (`l1Action`). Both must emit `builder` identically
  (field order `{b,f}`, appended after `grouping`). The golden vector proves
  `createL1ActionHash(l1Action-built) == Go-built actionHash` for the builder case; the shadow verifier
  and testnet stay as live guards (as for every action).
- Omit rule: no `builder` in params → neither side appends it → action byte-identical to today (zero
  regression when unapproved / no config).
- Only `order` carries a builder — `cancelByCloid` / `scheduleCancel` are untouched (no fee).

## Error handling

- Reuses sub-unit A's `BuilderInjector` (approval-gated, positive/negative TTL, fail-open on query
  error). An unapproved owner → no `builder` in params → the delegated action is exactly today's.
- The delegated path's existing fail-closed behavior (signer/transport error → `{ok:false}`, retried)
  is unchanged; adding an optional action field doesn't alter it.

## Testing

- **Go:** `BuildOrderAction` with a builder emits `{…, grouping, builder:{b,f}}` and omits it when nil;
  `golden_test.go` passes with the new `order-builder-mainnet` vector. `cd backend && gofmt -w ./... &&
  go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`.
- **TS:** `l1Action` builds the order action with/without builder (shape + field order);
  `l1Action.golden.test.ts` passes the new vector; `signerExchangeClient.order` puts `builder` in the
  sign params and submits an action containing `builder` when `arg.builder` is set (and omits it
  otherwise); `makeClientFor` wraps the delegated branch so an approved owner's signer-backed `order`
  carries a builder. `cd server && npm run typecheck && npm test`.
- Regenerate golden before running: `cd mobile && node scripts/gen-golden-vectors.mjs`.

## Decomposition (single PR, 3 steps)

1. Go signer builder (`action.go` + `digest.go` + tests).
2. Golden gen + regenerate (`gen-golden-vectors.mjs` + `golden.json`); Go golden_test green.
3. TS engine (`l1Action` + `signerExchangeClient` + `makeClientFor` delegated wrapping + tests); TS
   golden parity green.

## Out of scope

- Flipping `SIGNER_DELEGATION` on (ops, after testnet — the delegated builder only takes effect then).
- Spot builder fees; TWAP builder (HL `twapOrder` has no builder).
