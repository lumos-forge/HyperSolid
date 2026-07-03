# Go Signing Core (Tier ①) + Cross-Language Golden Vectors

Date: 2026-07-03
Status: Approved (brainstorming)
Depends on: `docs/BACKEND-ARCHITECTURE.md` §5 (M5 tiers), §7 (backend/ skeleton), §8.2 (this spike); ADR-013 (self-written Go signing core + golden vectors); the TS reference `@nktkas/hyperliquid/signing` (`createL1ActionHash`, `signL1Action`)

## 1. Goal

Stand up the **first slice of the Go backend track**: a self-written, minimal
**HL L1-action signing core** in a new `backend/` Go module, proven byte-for-byte
against the TypeScript client `@nktkas/hyperliquid` via **cross-language golden
vectors**. This is the security keystone (M5, the only key-holding, safety-critical
module) and the ADR-013 prerequisite ("守住精度/asset-id/cloid 三件套零漂移").

Scope of this slice: **L1 actions only** — `order`, `cancel`, `twapOrder`,
`twapCancel` — signed with the phantom-agent EIP-712 scheme. Tier ① key custody
(in-process). No server/mobile changes.

### Non-goals (YAGNI — later slices)
- User-signed actions (`approveAgent`, the `HyperliquidSignTransaction` domain +
  `hyperliquidChain` replay guard).
- Tier ② (KMS/HSM) / Tier ③ (Nitro Enclave) key custody.
- Nonce lease/fencing single-writer, the reject-first policy engine, the other
  M1–M11 modules, deployment, networking, storage.
- `vaultAddress` / `expiresAfter` action fields (the encoder supports them in the
  hash layout, but the first-slice vectors don't exercise them).

## 2. Decisions (from brainstorming)

- **Scope:** L1 action signing only (order / cancel / twapOrder / twapCancel).
  User-signed is a separate follow-up slice.
- **msgpack:** a hand-written minimal encoder (zero dependency, full byte control,
  auditable) — aligns with M5's minimal-dependency mandate; correctness is proven
  by the golden vectors (chosen over `vmihailenco/msgpack`).

## 3. The HL L1 signing scheme (what Go replicates, byte-exact)

Reference: `@nktkas/hyperliquid/esm/signing/mod.js` (`createL1ActionHash`,
`signL1Action`). Reproduced here so the Go core is byte-accurate.

### 3.1 Action hash (`connectionId`)
```
connectionId = keccak256(
    msgpack(action)                                  // fields in insertion order, undefined dropped
  ‖ nonce            as 8-byte big-endian uint64
  ‖ vaultMarker      = [1] if vaultAddress else [0]   // ALWAYS present
  ‖ vaultBytes       = 20-byte address if vaultAddress else <empty>
  ‖ expiresMarker    = [0] if expiresAfter != undefined else <empty>   // asymmetric: absent → nothing
  ‖ expiresBytes     = 8-byte big-endian if expiresAfter != undefined else <empty>
)
```
keccak256 = **legacy Keccak-256** (Ethereum), not SHA3-256. For the first slice
(no vault, no expires): `keccak256( msgpack(action) ‖ nonce8 ‖ [0] )`.

msgpack notes: the action contains only **strings, ints, bools, nested maps,
arrays — no floats** (prices/sizes are strings). Map keys are emitted in insertion
order. Integers use the smallest msgpack representation; ints `≥ 2^32` (or
`< -2^31`) are widened to 64-bit (the TS `largeIntToBigInt`); asset ids are small
so they stay compact.

### 3.2 EIP-712 signature
- Domain: `{ name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0000000000000000000000000000000000000000 }`.
- Types: `Agent(string source,bytes32 connectionId)`; primaryType `Agent`.
- Message: `{ source: isTestnet ? "b" : "a", connectionId }`.
- `digest = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(Agent))`; sign with
  secp256k1 → `{ r, s, v }` where `v ∈ {27, 28}` and `s` is low-S (canonical).

## 4. HL action field order (byte-critical; from the SDK schemas)

The Go builders MUST emit these fields in exactly this order:

- **order:** `{ type: "order", orders: [ { a, b, p, s, r, t, c? } ], grouping, builder? }`
  - order tuple: `a`(int asset), `b`(bool isBuy), `p`(string px), `s`(string sz),
    `r`(bool reduceOnly), `t`(OrderType), `c?`(string cloid, optional).
  - `t` = `{ limit: { tif } }` (tif ∈ "Gtc"|"Ioc"|"Alo") OR
    `{ trigger: { isMarket, triggerPx, tpsl } }` (tpsl ∈ "tp"|"sl").
  - `grouping` ∈ "na"|"normalTpsl"|"positionTpsl". `builder?` = `{ b, f }` (omitted this slice).
- **cancel:** `{ type: "cancel", cancels: [ { a, o } ] }` (`o` = int oid).
- **twapOrder:** `{ type: "twapOrder", twap: { a, b, s, r, m, t } }`
  (`m` = int minutes, `t` = bool randomize).
- **twapCancel:** `{ type: "twapCancel", a, t }` (`t` = int twapId).

## 5. Go module structure + dependencies

```
backend/
  go.mod                         # module github.com/lumos-forge/hypersolid/backend ; go 1.26
  internal/hl/
    msgpack.go                   # minimal ordered msgpack encoder
    msgpack_test.go
    action.go                    # typed L1 action builders → ordered msgpack Value
    action_test.go
    hash.go                      # L1ActionHash (byte layout of §3.1)
    hash_test.go
    eip712.go                    # Agent EIP-712 digest (hand-written domainSeparator + hashStruct)
    eip712_test.go
    signer.go                    # tier ① in-process Signer (holds key, SignL1Action, Close zeroizes)
    signer_test.go
    golden_test.go               # loads testdata/golden.json; asserts Go hash+sig == golden
    testdata/
      golden.json                # committed cross-language vectors (TS SDK = oracle)
      gen/generate.mjs           # Node generator (regenerates golden.json from the TS SDK)
```

**Dependencies (minimal, pinned):**
- keccak256: `golang.org/x/crypto/sha3` → `sha3.NewLegacyKeccak256()`.
- secp256k1: `github.com/decred/dcrd/dcrec/secp256k1/v4` (+ `.../v4/ecdsa`) for
  signing with a recovery id and canonical low-S.
- EIP-712 struct/domain hashing: **hand-written** (pure keccak concatenation) — no
  `go-ethereum` apitypes.
- *Fallback:* if the recovery-id / `v` handling with dcrec proves fiddly, the
  implementer may substitute `github.com/ethereum/go-ethereum/crypto` for
  `crypto.Sign`/`crypto.Keccak256`. The golden vectors are the arbiter of
  correctness either way; do not change the vectors to fit an implementation.
- `go vet` clean; `go mod tidy`; dependency versions pinned in `go.sum`.

## 6. Components

### 6.1 `msgpack.go` — minimal ordered encoder
- A small value model that preserves map order:
  ```go
  type KV struct{ K string; V any }
  type Map []KV            // ordered map
  // Encode supports: string, int64, uint64, bool, []any, Map
  func Encode(v any) ([]byte, error)
  ```
- Emit: `fixstr`/`str8`/`str16` for strings; positive `fixint`/`uint8..64` and
  negative `fixint`/`int8..64` (smallest form) for ints; `true`/`false`; `fixarray`/
  `array16` for `[]any`; `fixmap`/`map16` for `Map`. This mirrors `@std/msgpack`.
- Unit-tested at the byte level (known encodings for each type + a nested action).

### 6.2 `action.go` — typed L1 action builders
- Types + builders that produce an ordered `Map` for each action, fields in §4 order:
  ```go
  type LimitTif string   // "Gtc" | "Ioc" | "Alo"
  type OrderInput struct { Asset int64; IsBuy bool; Px, Sz string; ReduceOnly bool; Tif LimitTif; Cloid string /*optional*/ }
  func BuildOrderAction(orders []OrderInput, grouping string) msgpack.Map
  func BuildCancelAction(cancels []struct{ Asset, Oid int64 }) msgpack.Map
  func BuildTwapOrderAction(a int64, isBuy bool, sz string, reduceOnly bool, minutes int64, randomize bool) msgpack.Map
  func BuildTwapCancelAction(asset, twapId int64) msgpack.Map
  ```
  (Trigger-order `t` shape is included as a variant; first-slice vectors focus on
  limit + twap, but the builder covers `t.limit`.)

### 6.3 `hash.go`
```go
func L1ActionHash(action msgpack.Map, nonce uint64, vaultAddress []byte /*nil ok*/, expiresAfter *uint64) ([32]byte, error)
```
Implements §3.1 exactly (nonce big-endian, vault marker always present, expires
marker only when non-nil).

### 6.4 `eip712.go`
```go
func AgentDigest(connectionId [32]byte, isTestnet bool) [32]byte
```
Hand-written: `domainSeparator` = keccak256 of the EIP712Domain type hash ‖
keccak256("Exchange") ‖ keccak256("1") ‖ uint256(1337) ‖ address(0);
`hashStruct(Agent)` = keccak256(AgentTypeHash ‖ keccak256(source) ‖ connectionId);
`digest = keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct)`. Domain-separator
constant is asserted in a test.

### 6.5 `signer.go` — tier ① in-process signer
```go
type Sig struct { R, S [32]byte; V byte }               // V ∈ {27,28}
type Signer struct { /* holds the 32-byte private key */ }
func NewSigner(priv []byte) (*Signer, error)
func (s *Signer) SignL1Action(action msgpack.Map, nonce uint64, isTestnet bool) (Sig, error)
func (s *Signer) Close()                                  // best-effort zeroization of the key bytes
```
`SignL1Action` = `L1ActionHash` → `AgentDigest` → secp256k1 sign → `Sig`. `Close`
zeros the key slice (documented tier-① limitation: Go GC can't guarantee erasure;
see BACKEND-ARCHITECTURE §5 tier ①). No logging of key material.

## 7. Golden vectors (TS oracle → Go assertion)

### 7.1 Generator `testdata/gen/generate.mjs`
- Node ESM, run from the `mobile/` directory so it resolves `@nktkas/hyperliquid/signing`
  and `viem` from `mobile/node_modules` (documented in a header comment + the plan).
- For a **fixed private key** and a fixed set of cases (a limit order Gtc, a market
  order Ioc, a cancel, a twapOrder, a twapCancel; each for `isTestnet` true→source
  "b" and false→source "a"), it builds the exact action object, computes
  `createL1ActionHash({action,nonce})` and `signL1Action({wallet,action,nonce,isTestnet})`,
  and writes `golden.json`:
  ```json
  [{ "name": "...", "kind": "order|cancel|twapOrder|twapCancel",
     "params": { ... },              // the semantic inputs the Go builder also consumes
     "nonce": 1700000000000, "isTestnet": false,
     "privKey": "0x…",
     "actionHash": "0x…",            // createL1ActionHash
     "sig": { "r": "0x…", "s": "0x…", "v": 27 } }]
  ```
- Committed to the repo so vectors are reproducible + auditable. Regeneration is an
  occasional, deliberate step (documented command).

### 7.2 Go assertion `golden_test.go`
- Loads `golden.json`; for each vector: build the action from `kind`+`params` via
  the Go builders (§6.2), compute `L1ActionHash` and `SignL1Action`, and assert
  **byte-for-byte** equality with `actionHash` and `sig{r,s,v}`.
- A mismatch fails the build — this is the zero-drift proof.

## 8. Testing / gate

- **New gate:** `cd backend && go test ./...` (unit tests + golden vectors) and
  `go vet ./...`. Add a `backend` job to CI mirroring the existing server/mobile
  jobs (Go 1.26). This slice does not touch server/ or mobile/, so their gates are
  unchanged.
- Unit coverage beyond golden: msgpack per-type byte encodings; `L1ActionHash`
  byte layout (with and without a synthetic vault/expires to exercise the markers);
  the EIP-712 `domainSeparator` constant; `Signer.Close` zeroization.
- Determinism: fixed private key + fixed nonces ⇒ deterministic signatures, so the
  golden assertions are stable across runs.

## 9. Rejected alternatives
- **`vmihailenco/msgpack`:** less code but a dependency and relies on struct-tag
  ordering; rejected for a hand-written encoder per M5's minimal-deps mandate.
- **Full `go-ethereum` for crypto + EIP-712 apitypes:** heavier dependency surface
  for the security-critical signer; kept only as a documented fallback for the
  `v`/recovery-id detail. Hand-written EIP-712 + minimal secp256k1 is preferred.
- **Hardcoded golden constants in the Go test (no generator):** less reproducible /
  auditable; rejected in favor of a committed generator + `golden.json`.
- **Including user-signed / vault / expires now:** out of scope for the first
  provable slice; deferred.
