# Engine Builder-Fee Attachment (Local-Key Path) — Design

> **Status:** approved design. Scope: the agentic engine attaches the builder code to its orders for
> owners who have approved the builder fee, on the **local-key** path (the active path;
> `SIGNER_DELEGATION` off). This is sub-unit **A**; the delegated/signer path is sub-unit **B** (later).

## Context

The mobile app now earns the builder fee on manual trades (PR #111): server-delivered
`builder { address, perpFeeTenthBps }`, a one-time main-wallet `approveBuilderFee`, and the builder
attached to manual orders. But the **agentic engine** (`server/`) still places orders with **no
builder** — every strategy fill misses the fee.

The engine has two order paths:
- **Local-key** (`makeClientFor` → `@nktkas` `ExchangeClient`, active while `SIGNER_DELEGATION` is off):
  `placer.ts` and `restingExecutor.ts` call `client.order({ orders:[o], grouping:"na" })`. `@nktkas`
  accepts an optional `builder: { b, f }` sibling — so attaching is a params change, **no Go changes**.
- **Delegated/signer** (`signerExchangeClient` → Go signer): the action is built on both sides and
  msgpack-hashed, so the builder must be threaded through `l1Action.ts`, `signerExchangeClient`, and the
  Go `BuildOrderAction`/`ActionFromKind` + golden vectors. **Hash-critical → sub-unit B, out of scope.**

Agentic orders can only carry a builder for owners who **already approved** it (main-wallet, via the
app) — otherwise HL rejects the order and breaks the strategy. The engine can't prompt (it's a backend),
so it only **checks** approval and attaches when approved (fail-open otherwise).

## Goal

Attach `builder { b: address, f: perpFeeTenthBps }` to the engine's local-key `order` calls for owners
whose on-chain `maxBuilderFee` covers the configured fee. Absent config, unapproved owners, or any query
error → no builder, order proceeds unchanged. No behavior change on the delegated path.

## Non-goals

- Delegated/signer-path builder (Go `BuildOrderAction` + `ActionFromKind` + golden + `l1Action` +
  `signerExchangeClient`) — sub-unit B.
- Prompting/approving on the server (approval is a main-wallet action done in the app).
- Builder on cancels or `scheduleCancel` (no fee) or TWAP (HL `twapOrder` has no builder).

## Architecture / data flow

```
index.ts:  builder = appConfigFromEnv(process.env).builder      (reuse the SAME env + validation)
   └─ makeBuilderInjector({ info, address, perpFeeTenthBps })    (per-owner approval cache)
   └─ makeClientFor(agents, transport, now, delegation?, builderInjector?)   [local branch wraps order]

placer / restingExecutor  →  clientFor(owner).order({ orders:[o], grouping:"na" })
   └─ local wrapper:  b = await injector.builderFor(owner)
        approved  → client.order({ orders, grouping, builder: b })
        else      → client.order({ orders, grouping })            (unchanged)
@nktkas ExchangeClient → HL /exchange (builder attached only for approved owners)
```

## Components (all in `server/`)

### 1. Config (`index.ts`)

Reuse the existing parser: `const builder = appConfigFromEnv(process.env).builder`
(`{ address: 0x; perpFeeTenthBps: number } | undefined`, already validated to 0x+40hex + int in
[1,100]). When present, construct the injector and pass it to `makeClientFor`.

### 2. `makeBuilderInjector` (`agent/builderInjector.ts`)

- Ctor deps: `{ info: BuilderInfoLike; address: 0x; perpFeeTenthBps: number; now?: () => number; negativeTtlMs?: number }`
  where `BuilderInfoLike = { maxBuilderFee(params: { user: 0x; builder: 0x }): Promise<number> }`.
- `builderFor(owner): Promise<{ b: 0x; f: number } | undefined>`:
  - Per-owner cache `Map<ownerLower, { approved: boolean; at: number }>`.
  - **Approved** cached for the process lifetime (approval is effectively permanent); returns
    `{ b: address, f: perpFeeTenthBps }`.
  - **Unapproved / unknown** cached with a short TTL (default `negativeTtlMs = 10 min`) so a user who
    approves in the app is picked up on the next tick after the TTL; returns `undefined`.
  - On a fresh check: `maxBuilderFee(user, builder) >= perpFeeTenthBps` → approved. A thrown query →
    treated as unapproved-this-window (undefined), cached with the negative TTL (**fail-open**).
- Owner is lower-cased for the cache key (consistent addressing).

### 3. `makeClientFor` builder wrapper (`agent/hlRuntime.ts`)

- Signature gains an optional `builderInjector?: BuilderInjector` (5th arg, after `delegation`).
- **Local-key branch only:** wrap the `ExchangeClient` so `order(params)` first resolves
  `await builderInjector.builderFor(owner)` and, when defined, merges `builder` into the params (a
  builder already on the params is preserved). `cancelByCloid` and `scheduleCancel` pass through
  untouched. The wrapper is created once per owner (cached like today).
- **Delegated branch:** unchanged (no builder — sub-unit B). The injector is simply not applied there.

The wrapper keeps the same `RestingClientLike` surface, so `placer` / `restingExecutor` / `deadMan` are
unchanged.

## Error handling

- No `builder` config → no injector → the local client is exactly today's client (zero change).
- `maxBuilderFee` throws / owner unapproved → `builderFor` returns undefined → order placed without a
  builder (fail-open). The injector never throws into `order()`.
- The existing placer/resting `try/catch` (fail-closed to `{ok:false}` on a real order error) is
  unaffected — a wrapped `order` only adds a params field.

## Testing (`cd server && npm run typecheck && npm test`)

- **`makeBuilderInjector`:** approved when `maxBuilderFee >= perpFeeTenthBps` (returns `{b,f}`);
  undefined when below; undefined + fail-open when the query throws; positive result cached (second call
  makes no query); negative result re-checked after `negativeTtlMs`.
- **`makeClientFor` local wrapper:** for an approved owner, `order({orders,grouping})` reaches the
  underlying client with `builder:{b,f}`; for an unapproved owner, no `builder`; with no injector,
  params are unchanged; `cancelByCloid`/`scheduleCancel` never carry a builder; a delegated (keyId) owner
  is routed to the signer-backed client with no builder wrapper.

## Decomposition (single PR, 2 steps)

1. `makeBuilderInjector` + tests.
2. `makeClientFor` builder wrapper + `index.ts` wiring (reuse `appConfigFromEnv().builder`) + tests.

## Out of scope (follow-ups)

- Sub-unit **B**: delegated/signer-path builder (Go action + golden parity + `l1Action` +
  `signerExchangeClient`).
- Making the negative-cache TTL server-tunable (a constant default is fine for now).
