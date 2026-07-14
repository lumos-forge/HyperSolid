# Signer-Delegation Rollout Runbook (`SIGNER_DELEGATION`)

> **Status:** code-complete, flag **OFF by default**. This runbook is the operational path to enable
> engine→signer key custody + signing (spec: `docs/superpowers/specs/2026-07-13-engine-signer-cutover-design.md`,
> `docs/superpowers/specs/2026-07-14-cutover-signing-delegation-design.md`).

## What the flag does

`SIGNER_DELEGATION=1` moves the agentic engine (`server/`) from **holding each owner's agent key
locally** to **delegating custody + signing to the Go signer** (`backend/`, spec §5.1a — the sole
security-critical surface). With the flag on:

- **Provisioning** (`POST /agent/provision`) → the engine calls the signer's `POST /v1/keys`; the
  signer generates + persists the agent key (encrypted, PG vault) bound to the reject-first policy caps
  and returns `{keyId, agentAddress}`. The engine stores only `{keyId, agentAddress}` — **no private key**.
- **Every L1 action** (order / cancelByCloid / scheduleCancel) → the engine builds the canonical action,
  calls the signer's `POST /v1/sign/l1`, and submits the pre-signed `{action, signature, nonce}` to
  Hyperliquid `/exchange` **itself** (sign-then-submit), then best-effort reconciles the order lifecycle
  via `POST /v1/reconcile`.

With the flag **off** (default), behavior is unchanged: the engine generates local trade-only keys
(encrypted at rest in SQLite) and signs with a local `ExchangeClient`.

## Preconditions (before enabling)

1. **Signer deployed and reachable** at `SIGNER_URL` from the engine, running as leader with:
   - `SIGNER_KEK` set (key-encryption key; the signer fails closed without it).
   - PG vault configured (durable keystore) — not the in-memory vault.
   - Reject-first policy caps sized to match the engine guardrails (see step "Caps parity" below).
2. **Signer version** includes the persistent keystore + provisioning endpoints + `scheduleCancel`
   (PRs #103, #104 — already on `main`).
3. **Engine version** includes the delegation path (PRs #103–#107 — already on `main`).
4. **Network:** testnet (`HL_NETWORK` unset or `!= "mainnet"`) for the validation phase.

## Caps parity

The engine binds these caps at provision time (`server/src/index.ts`), and they must match the signer's
policy so a request accepted by the engine is not silently denied by the signer (or vice-versa):

- `allowedKinds`: `order`, `cancel`, `cancelByCloid`, `scheduleCancel`
- `maxNotionalUsdc` ← `MAX_NOTIONAL_USDC`
- `perCoinMaxUsdc` ← `PER_COIN_CAPS`
- `dailyMaxNotionalUsdc` ← `DAILY_MAX_NOTIONAL_USDC`

Keep the signer's per-key / per-owner IP + daily-notional budgets consistent with these.

## Enable (staging / testnet)

1. Set on the **engine** process:
   ```
   SIGNER_DELEGATION=1
   SIGNER_URL=https://<signer-host>      # required when delegation is on; engine fails fast otherwise
   ```
   (Optionally keep `SIGNER_SHADOW_URL` pointed at the signer so the live shadow verifier keeps
   cross-checking `createL1ActionHash` parity during the soak.)
2. Restart the engine.
3. Provision a **fresh** owner (new wallet) — see Validation. Existing owners are unaffected until they
   re-provision (see Migration).

## Migration (existing owners)

The flag gates routing per record, so the rollout is **non-breaking**:

- **Existing local-custody records** (they have a `privateKey`) keep routing to the local client even
  with the flag on — they continue trading unchanged.
- **New provisions** (no prior record) with the flag on go to the signer (keyId custody).
- **An existing *unapproved* record is returned idempotently** before the delegation branch, so a pending
  local provision stays local until it is revoked.

To move an existing owner to signer custody: **revoke + re-approve** (re-provision). This is cheap in the
current TestFlight phase (no live-key import; spec Migration section). There is no in-place key migration.

## Validation (testnet E2E — required before flipping default)

1. **Provision:** `POST /agent/provision` for a fresh owner → returns `{agentAddress}`. Confirm in the
   engine DB that the record has a `key_id` and an **empty** `enc_private_key` (no local key). Confirm the
   signer persisted the key (`GET`/logs) bound to the caps.
2. **Approve:** approve the agent on-device (`approveAgent` signed by the main key), then `POST
   /agent/confirm`.
3. **Place:** run a strategy that emits a market/limit order. Verify:
   - the order lands on HL **testnet** (fill or resting);
   - the signer logged a `POST /v1/sign/l1` for kind `order` with the expected cloid;
   - the engine submitted `{action, signature, nonce}` to `/exchange` (no local signing);
   - the shadow verifier logs **match** (no `signer shadow mismatch`) — the canonical action hash agrees;
   - `POST /v1/reconcile` advanced the ledger status (`signed → open/filled`).
4. **Dead-man:** with `DEADMAN_TTL_MS` set, confirm `scheduleCancel` arms via the signer (signed +
   submitted) and clears on recovery.
5. **Guardrails:** submit an order exceeding a cap and confirm the signer denies (403 policy) and the
   engine fails closed (`{ok:false}`, retried next tick) — no local fallback once delegated.
6. **Idempotency:** force a re-tick (same deterministic cloid) and confirm the signer returns
   `duplicate:true` (no double-place).

Let it soak on testnet/staging with real strategies and watch the observability signals below.

## Flip the default (follow-up PR, after a clean soak)

Only after testnet E2E + a staging soak pass: open a small follow-up PR that defaults
`SIGNER_DELEGATION` on (and makes `SIGNER_URL` a hard startup requirement). Keep it a separate,
easily-revertible change. Do **not** flip the default in this repo until ops signs off.

## Rollback

Setting `SIGNER_DELEGATION=0` (or unsetting it) + restart reverts new provisions and signing to local.

⚠️ **Caveat:** owners that were **provisioned while the flag was on** are signer-custody records
(`keyId`, no `privateKey`). With the flag off, `makeClientFor` has no local key for them → they yield no
client and their strategies **fail closed** (no orders) until either the flag is re-enabled or they
re-provision to regenerate a local key. Prefer a **forward fix** (keep the signer reachable, flag on) over
rollback. In the current TestFlight phase, re-provisioning stranded owners is acceptable.

## Observability

- **Signer:** `hypersolid_budget_denials_total{budget=…}`, sign latency/availability SLOs, reconciler
  success SLO (`backend/ops/slo`). A spike in denials on enable → caps drift; re-check Caps parity.
- **Shadow verifier:** any `signer shadow mismatch` warning during the soak is a **hard stop** — the
  engine-built action and the signer digest diverged; do not flip the default. Investigate the canonical
  action shape (`server/src/agent/l1Action.ts` vs `backend/internal/hl/action.go`).
- **Engine:** placer/executor `{ok:false}` rate (fail-closed retries), reconcile errors (best-effort;
  a rise indicates signer `/v1/reconcile` trouble but does not block trading).

## Reference

- Design baseline: `docs/superpowers/specs/2026-07-13-engine-signer-cutover-design.md`
- Delegation design: `docs/superpowers/specs/2026-07-14-cutover-signing-delegation-design.md`
- PRs: #103 (keystore), #104 (provisioning endpoints), #105 (`SignerClient`), #106 (provisioning
  delegation), #107 (signer-backed exchange client + routing).
- Remaining after default-on: Phase 4 cleanup (remove local key generation + the `enc_private_key`
  column once no local-custody records remain).
