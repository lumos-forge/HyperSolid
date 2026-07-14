# Cutover Phase 2b+3a — Engine Signing Delegation (combined)

Date: 2026-07-14
Status: Approved (architecture); implemented as flag-gated PRs, flipped last

## Context

Today the engine holds agent private keys and signs L1 actions locally (`AgentManager` +
`makeClientFor` → `ExchangeClient({wallet, transport})`). Phases 1a/1b/2a built the signer's
key custody + provisioning + a server `SignerClient`. This unit **cuts the whole agentic
signing path over to the signer**: provisioning creates the key in the signer, and placement
signs via the signer and submits the pre-signed action to Hyperliquid. Gated by
`SIGNER_DELEGATION` (default off → today's behavior); the flag flips only after the full path
is in place. Shadow mode already proved the TS and Go action hashes are byte-identical, which
de-risks the submit path.

## Goal

With `SIGNER_DELEGATION` on: `/agent/provision` creates the agent key **inside the signer**
(server stores only `{owner, keyId, agentAddress}`), and every order / scheduleCancel is signed
by the signer (`/v1/sign/l1`) and submitted by the engine to HL `/exchange` — the engine never
holds a private key. With the flag off, behavior is exactly as today.

## Architecture

```
provision  /agent/provision → AgentManager.provision(owner)   [delegation ON]
             → SignerClient.createKey({ keyId:"agent:"+owner, ownerAddress:owner, allowedKinds, caps })
             → store { owner, keyId, agentAddress, approved:false }   (NO privateKey)

place      scheduler → placer/resting → clientFor(owner)  [signer-backed for keyId records]
             → build action + cloid → SignerClient.sign(keyId, kind, params, cloid, isTestnet)
             → { r,s,v,nonce,duplicate }
             → transport.request("exchange", { action, signature:{r,s,v}, nonce })
             → parse HL fill; SignerClient.reconcile(keyId, cloid, status)

dead-man   deadManExecutor.scheduleCancel → signer-backed client → sign("scheduleCancel") → submit
```

## Components (all in `server/`)

### 1. Config + flag (`index.ts`, `config/appConfig.ts`)

- `SIGNER_DELEGATION` (`"1"` → on) and `SIGNER_URL` (the signer base URL). When on, construct a
  `SignerClient(SIGNER_URL)` and pass it to `AgentManager` + the signer-backed `clientFor`.
- `SIGNER_URL` is required when delegation is on (fail fast at startup otherwise).

### 2. Dual-custody data model (`agentManager.ts`, `sqliteAgentStore.ts`)

- `AgentRecord`: `privateKey?: 0x…` (now optional) + `keyId?: string`. A record is **either**
  local-custody (`privateKey`) **or** signer-custody (`keyId`) — never both.
- `SqliteAgentStore`: additive migration — add `key_id TEXT` column and make `enc_private_key`
  nullable (`ALTER TABLE ... ADD COLUMN key_id TEXT` guarded by a column check; store NULL for
  the key when signer-custody). `get`/`set` round-trip both fields.

### 3. Provisioning delegation (`agentManager.ts`)

- `AgentManager` gains an optional injected `signer?: SignerClient` + `deriveKeyId(owner)` +
  a `caps` config (mirroring the engine guardrails). `provision(owner)` becomes **async**.
  - delegation on: `keyId = "agent:" + owner.toLowerCase()`; `SignerClient.createKey({ keyId,
    ownerAddress: owner, allowedKinds: [...], maxNotionalUsdc, perCoinMaxUsdc, dailyMaxNotionalUsdc })`
    → `{agentAddress}`; store `{owner, keyId, agentAddress, approved:false}`.
  - delegation off: today's local key generation (unchanged).
  - idempotent: an existing un-approved record returns its address (the signer's provision is
    itself idempotent per keyId).
- `privateKeyFor(owner)` returns undefined for signer-custody records; a new `keyIdFor(owner)`
  returns the keyId. `/agent/provision` already `await`s `deps.agents.provision(owner)`.

### 4. `SignerBackedExchangeClient` (`agent/signerExchangeClient.ts`)

Implements the client surface used by placer/resting (`order(params)`) and deadMan
(`scheduleCancel(params)`), constructed per owner with `{ keyId, signer, transport, isTestnet }`:
- `order({ orders:[o], grouping })`:
  1. Build the canonical L1 action object `{ type:"order", orders, grouping }` (HL field order,
     matching the signer's `BuildOrderAction`), and the signer params
     `{ asset:o.a, isBuy:o.b, px:o.p, sz:o.s, reduceOnly:o.r, tif:"Ioc", grouping, cloid:o.c }`.
  2. `sig = await signer.sign({ keyId, kind:"order", params, cloid:o.c, isTestnet })`.
  3. `res = await transport.request("exchange", { action, signature:{ r:sig.r, s:sig.s, v:sig.v }, nonce:sig.nonce })`.
  4. Fire-and-forget `signer.reconcile(keyId, o.c, reconcileStatusFromRes(res))`.
  5. Return `res` (same shape the SDK returns → `fillOf` parsing is unchanged).
- `scheduleCancel({ time })`: build `{ type:"scheduleCancel", time? }`, sign kind
  `"scheduleCancel"` with a per-arm cloid, submit, return.
- Errors propagate (the placer/executors already fail closed on a throw → `{ok:false}` and
  retry next tick). A `SignerError` (policy/notLeader/etc.) surfaces via the existing paths.

### 5. `makeClientFor` (`hlRuntime.ts`)

- When delegation on and `agents.keyIdFor(owner)` resolves → return a cached
  `SignerBackedExchangeClient`. Else the existing local `ExchangeClient` path. Both gated by
  `agents.status(owner).approved` (unchanged fail-closed).

## Canonical-action / submit correctness (the key risk)

The submitted `action` must msgpack-hash to exactly what the signer signed, or HL rejects the
signature. Mitigations:
- The server builds the action object in HL field order, identical to the signer's Go
  `BuildOrderAction` (shadow mode already proves `createL1ActionHash(action) === signer hash`
  for the same kind/params).
- A unit test asserts the submitted action object equals the shadow-hashed action object (the
  same `actionFromKindParams` shape), and that `createL1ActionHash({action, nonce}) ===` the
  signer's `/v1/digest/l1` for a fixed vector (extends the existing shadow parity).
- The shadow verifier stays on during rollout as a live cross-check.
- Final validation is a testnet end-to-end place before flipping the flag in production.

## Error handling / rollout

- `SIGNER_DELEGATION` off by default → zero behavior change; every PR merges safely with the
  flag off. The flag flips only after provisioning + signing + dead-man are all in place and
  testnet-validated.
- Signer unreachable / 5xx / 429 / notLeader (retryable) → the `order`/`scheduleCancel` throws
  → placer returns `{ok:false}` → scheduler retries next tick (fail-closed, no local fallback
  once delegated).
- `403 policy` → throws → skip + surface via existing health/alerts.
- `duplicate:true` (cloid already authorized) → still submit (HL dedups by cloid), then
  reconcile — preserves crash-replay idempotency.
- Provisioning failure → `/agent/provision` errors; no partial record.

## Migration

Pre-launch (TestFlight): no live key import. Existing locally-provisioned agents keep working
with the flag off; when the flag flips, owners re-provision (revoke + re-approve) to move
custody to the signer. Documented in the rollout notes.

## Testing

- **Data model:** `SqliteAgentStore` round-trips a signer-custody record (`keyId`, null key) and
  a local-custody record; the `key_id` migration is idempotent.
- **Provision:** with a fake `SignerClient`, delegation-on `provision` calls `createKey` and
  stores `{keyId, agentAddress}` (no privateKey); delegation-off is unchanged.
- **SignerBackedExchangeClient:** with a fake signer + fake transport, `order` signs (kind
  "order", correct params + cloid) then submits `{action, signature, nonce}` to
  `transport.request("exchange", …)`; the submitted `action` matches the canonical shape; a
  fill is returned unchanged; a `SignerError` propagates (→ placer `{ok:false}`); reconcile is
  called with the terminal status. `scheduleCancel` likewise.
- **Canonical parity:** `createL1ActionHash({action, nonce})` for the built action equals a
  fixed golden (cross-checked with the signer's digest vector).
- **clientFor:** a keyId record → SignerBackedExchangeClient; a privateKey record → local
  client; unapproved → undefined.
- Validation: `cd server && npm run typecheck && npm test`.

## Implementation decomposition (flag-gated PRs; flag stays off until the last)

1. **Data model + provisioning delegation** — `AgentRecord.keyId`, store migration,
   `AgentManager` async provision via `SignerClient.createKey`, `keyIdFor`, config/flag. (No
   signing change yet; delegation-on provisioning is unit-tested.)
2. **SignerBackedExchangeClient + `makeClientFor` wiring** — signer-backed `order` /
   `scheduleCancel` (sign → submit → reconcile), routed for keyId records.
3. **Flip + rollout notes** — enable `SIGNER_DELEGATION` in staging/testnet, validate, then
   default on; update the roadmap.

## Out of scope (later)

- Phase 4 cleanup: remove local key generation + the `enc_private_key` column once delegation
  is the only path.
- KMS-backed KEK; live encrypted key import/migration.
