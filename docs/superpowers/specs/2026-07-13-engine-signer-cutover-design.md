# Engine → Signer Cutover — Overall Design

Date: 2026-07-13
Status: Approved (architecture); phased implementation follows

## Context & problem

Per spec §5.1a, the Go **signer** (M5) is meant to be the *only* holder of agent private
keys — the agentic engine calls it to sign, never holding key material itself. Today the
opposite is true: the TS engine (`server/`) generates agent keys (`agent/agentManager.ts`),
stores them **encrypted at rest** (`agent/sqliteAgentStore.ts` + `secretBox` AES-256-GCM), and
signs L1 actions **locally** with an agent-signed HL `ExchangeClient` (`agent/placer.ts`). The
Go signer (`backend/cmd/signer`) is fully built — `/v1/sign/l1` (reject-first policy gate →
nonce fencing → cloid-idempotent ledger → `{r,s,v,nonce,duplicate}`), `/v1/reconcile`,
`/v1/orphans`, rate limits, address caps, observability — but its keystore is **in-memory and
starts empty** (`keystore.New()`), and the engine only *shadow-verifies* against it
(`agent/signerShadow.ts`, "never affects placement"). So the signer has never held a real key
and is not on the live signing path.

This project cuts the agentic signing path over to the signer, making the signer the sole key
custodian and realizing the non-custodial security boundary. Shadow mode has already proven
the TS and Go action-encoding/digests are byte-identical, which de-risks the cutover.

## Goals & non-goals

**Goals**
- Agent private keys are **generated, held, and zeroized only inside the signer**; the engine
  never sees private key material after cutover.
- The engine signs L1 actions by calling the signer (`/v1/sign/l1`) and submits the signed
  payload to Hyperliquid itself (sign-then-submit split).
- The signer's reject-first policy gate enforces the same guardrail caps the engine applies.
- Restart-safe: provisioned agent keys survive signer restarts (encrypted at rest).

**Non-goals**
- KMS/HSM/enclave key storage (later hardening; the interface leaves room — see §Keystore).
- Live migration/import of existing engine-held keys — pre-launch (TestFlight) we require
  re-provisioning (§Migration).
- Changing the on-device `approveAgent` flow (the user still approves the agent address with
  their main wallet).

## Target architecture

```
provision  app → server POST /agent/provision
                  → SignerClient.createKey(owner, caps)
                    → signer: generate secp256k1 keypair (never leaves signer),
                      encrypt+persist (PG), bind per-keyId policy (owner+caps),
                      return { keyId, agentAddress }
                  → server stores { owner → keyId, agentAddress } (NO private key)
                  → app receives agentAddress

approve     app signs approveAgent(agentAddress) with the MAIN wallet (unchanged)

place       engine scheduler → placer.build(action, cloid)
                  → SignerClient.sign(keyId, kind, params, cloid, isTestnet)
                    → signer: policy gate → fence → nonce → cloid ledger → { r,s,v,nonce,duplicate }
                  → engine assembles HL /exchange { action, nonce, signature:{r,s,v} } and POSTs
                  → engine → SignerClient.reconcile(keyId, cloid, status) (submitted/open/filled/…)

revoke      app → server /agent/revoke → SignerClient.deleteKey(keyId) (zeroize + delete)
```

**Invariant:** the only components that ever touch a private key are the signer's keystore and
`hl.Signer`. The engine holds only `{keyId, agentAddress}` (both public).

## Components

### 1. Signer: persistent encrypted keystore (Go)

Replace the in-memory-only keystore with a durable, encrypted one, mirroring the ledger's
`interface + mem + pg` layering (`internal/ledger/{ledger.go,mem.go,pg/pg.go}`):

- `keystore.Store` interface: `Add/Get(keyId)→signer/Remove/List` **plus** persistence of the
  encrypted key blob and the derived `agentAddress`.
- `keystore/mem` (tests) and `keystore/pg` (production): the PG impl stores
  `(key_id PK, agent_address, enc_priv BYTEA, created_at)` with the private key sealed via
  **AES-256-GCM** (reuse the sealing pattern from `server/src/agent/secretBox.ts`, ported to
  Go, or the existing Go crypto). The master key (KEK) comes from env `SIGNER_KEK` (base64 32
  bytes) — a KMS-backed KEK is a later drop-in behind the same interface.
- At startup the signer **loads all keys** from PG into the in-memory `hl.Signer` registry
  (decrypting with the KEK), so `/v1/sign/l1` resolves keyIds after a restart.
- Zeroization on `Remove`/`Close` is preserved (`hl.Signer.Close`).

### 2. Signer: key-provisioning + policy binding endpoints (Go)

- `POST /v1/keys` → generate a keypair **inside the signer**, seal+persist, bind a per-keyId
  policy config (owner address + caps, into the existing `policy.Store`), return
  `{ keyId, agentAddress }`. Idempotent per an operator-supplied `keyId` (or server-supplied).
- `DELETE /v1/keys/{keyId}` → zeroize + delete the key and its policy binding.
- These are leader-gated and authenticated the same way the signer's other privileged routes
  are; they never return or log private material.
- `scheduleCancel` is added to the signer's L1 action set (`hl.ActionFromKind` + `intentFor`)
  so the dead-man arm/disarm path can also delegate.

### 3. Server: `SignerClient` (TS)

A typed, fault-handled client for the signer:
- `createKey(owner, caps) → { keyId, agentAddress }`
- `deleteKey(keyId)`
- `sign({ keyId, kind, params, cloid, isTestnet }) → { r, s, v, nonce, duplicate }`
- `reconcile(keyId, cloid, status)`
It surfaces the signer's status codes (403 policy/cap, 409 fenced/cloid, 429 rate, 503 not
leader) as typed errors so the placer can react (retry/skip/alert). Injectable `fetch` for tests.

### 4. Server: provisioning cutover (TS)

`AgentManager`/`/agent/provision` stops generating/storing private keys; it calls
`SignerClient.createKey` and persists only `{ owner, keyId, agentAddress }` (the encrypted
`SqliteAgentStore` private-key column is dropped in the cleanup phase). `/agent/status` and
`/agent/revoke` are updated accordingly. The on-device `approveAgent` flow is unchanged.

### 5. Server: signer-backed placer (TS)

A new placement path parallel to the local one, behind a flag `SIGNER_DELEGATION`:
- Build the L1 action + `cloid` exactly as today (the shadow verifier already proves parity).
- `SignerClient.sign(...)` → assemble the HL `/exchange` body `{ action, nonce, signature }`
  and POST it via the existing HL runtime (the engine keeps HL connectivity + fill parsing).
- `SignerClient.reconcile(...)` the lifecycle status back to the signer's ledger.
- `deadManExecutor` similarly routes `scheduleCancel` through the signer.
When the flag is off, behavior is exactly today's local signing (safe default during rollout).

### 6. Cleanup (TS/Go)

Once the delegated path is validated, remove the engine's local key custody
(`agentManager` key generation + `SqliteAgentStore` private-key storage + the agent-signed
`ExchangeClient`), make `SIGNER_DELEGATION` the default/only path, and keep `signerShadow` only
if still useful for parity monitoring.

## Data flow — signing (detail)

```
placer: action = buildOrder(coin, sizeUsdc, price, cloid)     // TS, unchanged encoding
        POST signer /v1/sign/l1 { keyId, kind:"order", params, cloid, isTestnet }
signer: policy.Evaluate(intent, cfg) → fence → ledger.Authorize(cloid,digest,nonce) → sign
        → { r, s, v, nonce, duplicate }
placer: body = { action, nonce, signature:{ r, s, v }, vaultAddress?:null }
        POST hl /exchange body → parse fill
        POST signer /v1/reconcile { keyId, cloid, status }
```
`duplicate:true` (cloid replay) means the signer already authorized this cloid → the engine
must NOT double-submit; it treats it as an in-flight/So-far result and reconciles, preserving
crash-replay idempotency.

## Security invariants

- Private keys are generated by and never leave the signer; encrypted at rest (AES-256-GCM,
  env/KMS KEK); zeroized on revoke/close.
- The engine after cutover holds only `{keyId, agentAddress}`.
- The signer's reject-first policy gate is the authoritative guardrail; the engine's caps are
  mirrored into `policy.Store` at provision time (never weaker).
- Signing is leader-gated + nonce-fenced + cloid-idempotent (already enforced by the signer).
- Signed `/exchange` payloads are integrity-protected by the EIP-712 signature — the engine
  (the submitter) cannot alter the action without invalidating it.

## Error handling / rollout

- Feature flag `SIGNER_DELEGATION` gates the cutover; default off → today's behavior. Flip on
  in staging → verify against shadow parity + live testnet → default on → remove local path.
- Signer unreachable / 5xx on `sign` → the placement is skipped this tick and retried next tick
  (no local-key fallback once cutover is default; during rollout the flag falls back to local).
- `403` (policy/cap) → skip + surface via existing health/alerts (mirrors today's `withinCaps`
  rejection).
- `429`/`503` → backoff/retry next tick.
- Provisioning failure → `/agent/provision` returns an error; no partial key state (the signer
  persists only on success).

## Migration

Pre-launch (TestFlight): no live key import. New agents provision through the signer. Any
existing locally-provisioned agents must be re-provisioned (revoke + re-approve) — documented
in the rollout notes. A one-time encrypted import path is explicitly deferred.

## Testing strategy

- **Signer keystore (Go):** conformance tests across `mem` + `pg` (like the ledger conformance
  suite); seal/open round-trip; startup reload decrypts and resolves keyIds; zeroize on remove;
  PG integration test behind the existing `-tags=integration`.
- **Signer provisioning (Go):** `POST /v1/keys` generates a valid keypair, persists, binds
  policy, returns the address; `DELETE` zeroizes; leader-gating; `scheduleCancel` action parity
  vs `@nktkas` (extend the golden-vector suite).
- **SignerClient (TS):** typed status-code mapping with an injected `fetch`.
- **Placer cutover (TS):** with a fake SignerClient, a placement calls `sign` then submits the
  assembled `{action,nonce,signature}` to a fake HL and reconciles; `duplicate:true` does not
  double-submit; signer error → skip.
- **Parity:** keep the shadow verifier during rollout as a live cross-check.
- Commands: `cd backend && go test ./... && go test -tags=integration ./internal/keystore/...`;
  `cd server && npm run typecheck && npm test`.

## Phased decomposition (implementation order)

Each phase is its own spec → plan → PR(s):
1. **1a — Signer persistent encrypted keystore** (PG store interface + mem/pg + KEK sealing +
   startup reload). *Foundation; no runtime behavior change.*
2. **1b — Signer provisioning endpoints** (`POST/DELETE /v1/keys` + per-keyId policy binding +
   `scheduleCancel` action).
3. **2a — Server `SignerClient`** (typed client + error mapping).
4. **2b — Provisioning cutover** (`/agent/provision` → signer; server stops storing private keys).
5. **3a — Signer-backed placer** (sign→submit→reconcile, behind `SIGNER_DELEGATION`).
6. **3b — Dead-man scheduleCancel via signer**; flip the flag on in staging.
7. **4 — Cleanup** (remove local key custody; make delegation the default).

## Out of scope / deferred

- KMS/HSM/enclave-backed KEK and keys (interface leaves room).
- Live encrypted key import/migration of existing engine-held agents.
- Engine-side HA / Temporal (a separate M4 gap, unrelated to key custody).
