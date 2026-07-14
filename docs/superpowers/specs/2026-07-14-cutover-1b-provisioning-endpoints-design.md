# Cutover Phase 1b — Signer Provisioning Endpoints

Date: 2026-07-14
Status: Approved (per the cutover baseline + Phase 1a)

## Context

Phase 1a gave the signer a durable encrypted `keystore.Manager` (Provision/Load/Remove/
AgentAddress), but it is only held via `_ = keyManager` — nothing exposes it. This phase adds
the HTTP provisioning surface so the server (Phase 2) can create/revoke agent keys **in the
signer** and bind each key's reject-first policy. `scheduleCancel` is **already** a fully
supported signer L1 action (`hl.ActionFromKind` case + `BuildScheduleCancelAction` + golden
vectors), so this phase is purely the key endpoints + policy binding.

## Goal

`POST /v1/keys` provisions (idempotently) an agent key in the signer and binds its policy;
`DELETE /v1/keys/{keyId}` zeroizes+deletes the key and unbinds its policy. Both are
leader-gated. No per-request auth (the signer is an internal, network-isolated service, like
`/v1/sign/l1`).

## Design (all in `backend/`)

### 1. `internal/policy/store.go` — `Delete`

Add `func (s *Store) Delete(keyID string)` that removes the key's `Config` and recomputes any
owner budget-conflict state (mirroring `Set`), so a revoked key leaves no stale policy/budget.

### 2. Thread `keystore.Manager` through the mux

- `buildHandler`: construct a `*keystore.Manager` in **both** branches — DB branch uses the PG
  vault (already built for the startup `Load`); the no-DB branch uses `keystore.NewMemVault()`.
  Pass it to `newMux`.
- `newMux(ks *keystore.Keystore, mgr *keystore.Manager, policies *policy.Store, led
  ledger.Ledger, fencer Fencer, nowMs func() int64)`.
- The test helper `leaderMux` builds a `Manager` over a `MemVault` with a 32-byte test KEK.

### 3. `POST /v1/keys` — `handleProvisionKey(mgr, policies, fencer)`

Request:
```go
type provisionKeyRequest struct {
	KeyID                       string             `json:"keyId"`
	OwnerAddress                string             `json:"ownerAddress"`
	AllowedKinds                []string           `json:"allowedKinds"`
	MaxNotionalUsdc             float64            `json:"maxNotionalUsdc"`
	PerCoinMaxUsdc              map[string]float64 `json:"perCoinMaxUsdc"`
	DailyMaxNotionalUsdc        float64            `json:"dailyMaxNotionalUsdc"`
	RatePerSec                  float64            `json:"ratePerSec"`
	RateBurst                   float64            `json:"rateBurst"`
	IPRatePerSec                float64            `json:"ipRatePerSec"`
	IPRateBurst                 float64            `json:"ipRateBurst"`
	AddressDailyMaxNotionalUsdc float64            `json:"addressDailyMaxNotionalUsdc"`
}
```
Response: `{ "keyId": ..., "agentAddress": "0x..." }`.

Flow:
- `POST` only (else 405); decode (400 on bad json); `keyId` required (400 if empty).
- Leader-gate: `_, isLeader := fencer.Fence()`; if not leader → 503 (mirrors `handleSignL1`).
- **Idempotent:** if `mgr.AgentAddress(keyId)` already resolves, reuse that address (do NOT
  regenerate — regenerating would overwrite the key and invalidate the already-approved agent
  address); otherwise `mgr.Provision(ctx, keyId)`.
- Always (re)bind the policy: `policies.Set(keyId, toPolicyConfig(req))` where `AllowedKinds`
  `[]string → map[string]bool`.
- Respond `{keyId, agentAddress}`; `mgr.Provision` failure → 500.

### 4. `DELETE /v1/keys/{keyId}` — `handleDeleteKey(mgr, policies, fencer)`

- Register via a Go 1.22 method+wildcard pattern: `DELETE /v1/keys/{keyId}`; read
  `r.PathValue("keyId")` (400 if empty).
- Leader-gate (503 if not leader).
- `mgr.Remove(ctx, keyId)` (zeroize + vault delete) + `policies.Delete(keyId)`; return 204.
- Idempotent (removing an unknown key is a no-op 204).

Register both under the existing `loggedRoute` middleware in `newMux` (path `/v1/keys` for
POST, `DELETE /v1/keys/{keyId}` for delete).

## Data flow

```
server → POST /v1/keys {keyId, ownerAddress, caps...}
  signer: leader? → AgentAddress(keyId)? reuse : Provision(keyId) → addr
          policies.Set(keyId, Config{owner, allowedKinds, caps...})
          → { keyId, agentAddress }
server → DELETE /v1/keys/{keyId}
  signer: leader? → Manager.Remove(keyId) + policies.Delete(keyId) → 204
```

## Error handling / edge cases

- Non-leader → 503 (both endpoints); the server retries against the leader.
- Re-provision an existing keyId → returns the SAME address (key not regenerated); policy is
  re-bound (caps may be updated) — safe and idempotent.
- Provision seal failure (e.g. missing KEK in a misconfigured no-DB dev signer) → 500.
- Delete of an unknown key → 204 (idempotent).
- No key material is ever logged or returned (only the public agent address).

## Testing (`backend/cmd/signer` + `internal/policy`)

- `internal/policy/store_test.go`: `Delete` removes a Config (`Get` returns the zero/default)
  and clears owner budget-conflict state.
- `cmd/signer/main_test.go` (via `leaderMux` + `httptest`):
  - `POST /v1/keys` → 200, a `0x…`(42-char) address, the signer is registered
    (a subsequent `/v1/sign/l1` for that keyId with an allowed kind is NOT 404), and the policy
    is bound (a disallowed kind → 403).
  - Re-`POST` the same keyId → SAME address (idempotent; key not regenerated).
  - `POST` with an empty keyId → 400; wrong method → 405; bad json → 400.
  - Non-leader (`constFencer{leader:false}`) → 503.
  - `DELETE /v1/keys/{keyId}` → 204; afterwards `/v1/sign/l1` for that keyId → 404 (key gone)
    and the policy is unbound; delete of an unknown key → 204.
- Validation: `cd backend && gofmt -w ./... && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`;
  keystore PG integration still runs under `-tags=integration` in CI.

## Out of scope (later phases)

- 2a: server `SignerClient` calling these endpoints.
- 2b: `/agent/provision` cutover to the signer; server stops storing private keys.
- 3a+: signer-backed placer, dead-man delegation, cleanup.
- `scheduleCancel` action — already complete (no work here).
