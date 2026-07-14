# Cutover Delegation Validation Harness — Design

> **Status:** approved design. Scope: a pre-flip validation harness that proves the engine→signer
> delegated path is correct against a **live signer** (+ optional testnet), so ops can gate the
> `SIGNER_DELEGATION` flip on green checks rather than hope.

## Context

The delegation cutover (PRs #102–#113) is code-complete behind `SIGNER_DELEGATION` (default OFF). Before
ops flips it on, the rollout runbook (`docs/SIGNER-DELEGATION-ROLLOUT.md`) prescribes a testnet E2E:
provision → approve → place → shadow match → reconcile. Today that's a manual checklist. This adds an
**automated harness** that runs the non-fund-moving correctness checks (and an optional full place)
against a live signer and prints a PASS/FAIL report with a CI-friendly exit code.

## Goal

`npm run validate:delegation` (against `SIGNER_URL`) proves, without moving funds:
1. the signer is reachable;
2. the **canonical action encoding matches** between the engine (`l1Action`) and the signer
   (`/v1/digest/l1`) for order (± cloid, ± builder), cancelByCloid, scheduleCancel;
3. the signer **provisions a key and signs a digest that recovers to the reported agent address**.

An opt-in `--place` step does the full fund-moving E2E on testnet when ops supplies an approved keyId.

## Architecture

```
src/agent/validateDelegation.ts   runValidation(deps) → ValidationReport   (pure-ish, injected deps, tested)
src/scripts/validateDelegation.ts CLI: read env → wire real deps → run → print → exit(0|1)
package.json                      "validate:delegation": build + node dist/scripts/validateDelegation.js
```

The **core** takes injected dependencies so it's unit-testable with fakes; the **CLI** wires the real
`SignerClient`, a `/v1/digest/l1` fetch, `@nktkas` `createL1ActionHash`, viem `hashTypedData` +
`recoverAddress`, and (for `--place`) an `HttpTransport` submit. No change to the production
`SignerClient`.

## Core: `runValidation(deps)`

```ts
interface ValidateDeps {
  isTestnet: boolean;
  owner: `0x${string}`;                 // a throwaway owner for provisioning
  health(): Promise<boolean>;            // GET /healthz ok
  digest(req: { kind; params; nonce; isTestnet }): Promise<{ actionHash: string }>;   // POST /v1/digest/l1
  localHash(action, nonce): string;      // @nktkas createL1ActionHash({action, nonce})
  agentDigest(action, nonce, isTestnet): `0x${string}`;   // viem hashTypedData (phantom-agent EIP-712)
  recover(digest, sig: { r; s; v }): Promise<`0x${string}`>;   // viem recoverAddress
  signer: Pick<SignerClient, "createKey" | "sign" | "deleteKey">;
  place?(): Promise<{ ok: boolean; detail: string }>;   // optional --place E2E (fund-moving)
}
type Check = { name: string; ok: boolean; detail: string };
type ValidationReport = { ok: boolean; checks: Check[] };
```

Checks (each a `Check`, `ok` short-circuits nothing — all run so the report is complete):
1. **health** — `await deps.health()`.
2. **parity** — for each of a fixed vector set (`buildValidationVectors()` returning `{ name, kind,
   params }` for order-gtc, order-cloid, **order-builder**, cancelByCloid, scheduleCancel), build the
   action via `actionFromKindParams(kind, params)`, and assert `localHash(action, NONCE) ===
   (await digest({ kind, params, nonce: NONCE, isTestnet })).actionHash`. One `Check` per vector.
3. **provision-sign-recover** — `createKey({ keyId: "validate:"+rand, ownerAddress: owner, allowedKinds,
   maxNotionalUsdc })` → `sign({ keyId, kind:"order", params, cloid, isTestnet })` → build the same
   action → `recover(agentDigest(action, sig.nonce, isTestnet), sig)` and assert it equals the
   provisioned `agentAddress` (case-insensitive). `deleteKey(keyId)` in a `finally` (cleanup best-effort).
4. **place** (only when `deps.place` is set) — run it; its `{ ok, detail }` becomes a `Check`.

`report.ok = checks.every((c) => c.ok)`.

## CLI: `src/scripts/validateDelegation.ts`

- Env: `SIGNER_URL` (required — fail fast), `HL_NETWORK` (`isTestnet = !== "mainnet"`), `VALIDATE_OWNER`
  (default a fixed non-zero test address). `--place` (argv) + `VALIDATE_PLACE_KEYID`, `VALIDATE_PLACE_COIN`
  (default a testnet perp) enable the optional place.
- Wire real deps:
  - `health` = `fetch(SIGNER_URL + "/healthz")` → ok.
  - `digest` = `fetch(SIGNER_URL + "/v1/digest/l1", POST json)` → `{ actionHash }`.
  - `localHash` = `createL1ActionHash` (`@nktkas/hyperliquid/signing`).
  - `agentDigest` = viem `hashTypedData({ domain:{name:"Exchange",version:"1",chainId:1337,verifyingContract:ZERO},
    types:{Agent:[{name:"source",type:"string"},{name:"connectionId",type:"bytes32"}]}, primaryType:"Agent",
    message:{ source: isTestnet?"b":"a", connectionId: createL1ActionHash({action,nonce}) } })` — the
    exact scheme from `gen-golden-vectors.mjs`.
  - `recover` = viem `recoverAddress({ hash, signature:{ r, s, v } })`.
  - `signer` = `new SignerClient(SIGNER_URL)`.
  - `place` (when `--place`) = build a small IoC order, `signer.sign`, submit via `HttpTransport.request("exchange", { action, signature, nonce })`, `signer.reconcile`, assert a non-error status.
- Print a table (`✓/✗ name — detail`) and `process.exit(report.ok ? 0 : 1)`.

## Testing (`cd server && npm run typecheck && npm test`)

`src/agent/validateDelegation.test.ts` — unit-test `runValidation` with fakes:
- all-pass: health true, digest returns the same hash `localHash` computes, recover returns the
  provisioned agentAddress → `report.ok === true`, `deleteKey` called.
- parity fail: digest returns a different hash for one vector → that check `ok:false`, `report.ok:false`.
- recover mismatch: recover returns a different address → provision-sign-recover `ok:false`.
- health fail: `health()` false → that check fails.
- cleanup: `deleteKey` is called even when `sign` throws.
- place: with a fake `place` returning ok/fail, the check reflects it; absent `place`, no place check.

The CLI wrapper is a thin env/IO shim (not unit-tested beyond typecheck) — its logic lives in the tested
core + already-tested libs (SignerClient, l1Action, viem).

## Decomposition (single PR, 2 steps)

1. `runValidation` core + `buildValidationVectors` + tests.
2. CLI wrapper + `package.json` script; `npm run typecheck` + a dry `--help`/no-env fail-fast check.

## Out of scope

- Running against real infra (ops runs it with a live `SIGNER_URL`).
- Approving an agent on-device for `--place` (ops pre-approves and passes the keyId).
- Flipping the flag (a separate, human-gated ops step, per the runbook).
