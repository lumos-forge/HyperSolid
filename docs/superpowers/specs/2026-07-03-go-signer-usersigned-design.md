# Go Signing Core — User-Signed Actions (approveAgent)

Date: 2026-07-03
Status: Approved (brainstorming)
Depends on: `docs/superpowers/specs/2026-07-03-go-signer-core-design.md` (first slice: L1 signing, merged in PR #10); `docs/BACKEND-ARCHITECTURE.md` §5.2 (two signing domains); the TS reference `@nktkas/hyperliquid/signing` (`signUserSignedAction`) + `ApproveAgentTypes`

## 1. Goal

Second slice of the Go signing core: add the **user-signed EIP-712 path**
(`HyperliquidSignTransaction` domain) on top of the merged first slice, with
**approveAgent** as the first concrete action, proven byte-for-byte against
`@nktkas/hyperliquid`'s `signUserSignedAction` via cross-language golden vectors.
Built as a small **generic** user-signed digest helper (ordered typed-field
table driven, supporting the `string`/`address`/`uint64` field types HL uses) so
later user-signed actions are cheap to add. No server/mobile changes; the merged
L1 path is untouched.

### Non-goals (YAGNI — later slices)
- Other user-signed actions (`withdraw3`, `usdSend`, `approveBuilderFee`,
  `usdClassTransfer`, …). This slice ships the generic helper + approveAgent only.
- Multi-sig payloads (`payloadMultiSigUser`/`outerSigner`).
- Tier ②/③ custody, nonce lease/fencing, policy engine, deployment, the other
  M1–M11 modules.
- Additional field types beyond `string`/`address`/`uint64` (add when a future
  action needs them, e.g. `uint256` for amounts).

## 2. The user-signed scheme (what Go replicates, byte-exact)

Reference: `@nktkas/hyperliquid/esm/signing/mod.js` (`signUserSignedAction`) +
`ApproveAgentTypes`. Reproduced here so the Go core is byte-accurate.

Unlike the L1 path (msgpack → keccak `connectionId` → `Exchange`/1337
phantom-agent), user-signed actions are signed as **plain EIP-712 typed data** —
the action fields ARE the message:

- **Domain:** `{ name: "HyperliquidSignTransaction", version: "1", chainId: parseInt(signatureChainId), verifyingContract: 0x0000…0000 }`.
  `signatureChainId` is a hex string (e.g. `"0xa4b1"` = Arbitrum One 42161); it
  drives the domain `chainId` and is **not** a signed message field. This is the
  real chain id, not 1337.
- **approveAgent types:** primaryType `HyperliquidTransaction:ApproveAgent` with
  fields **in this exact order**:
  `string hyperliquidChain, address agentAddress, string agentName, uint64 nonce`.
- **Message:** `{ hyperliquidChain, agentAddress, agentName, nonce }`.
- **Replay protection:** `hyperliquidChain` ∈ `"Mainnet"|"Testnet"` is a *signed*
  field, so a mainnet signature can't be replayed on testnet (and vice-versa).
- **agentName special case:** if `agentName` is null/undefined, it is signed as the
  empty string `""` (`keccak256("")`).
- **Digest:** standard EIP-712 —
  `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(primaryType))`; sign with
  secp256k1 → `{ r, s, v }` (v ∈ {27,28}, low-S).

### 2.1 EIP-712 field encoding (32-byte words)
- `string`  → `keccak256(utf8Bytes(value))`.
- `address` → 20 raw bytes, left-padded to 32 (12 zero bytes + address). Hex is
  decoded case-insensitively (EIP-55 checksum casing is display-only).
- `uint64`  → big-endian value right-aligned in a 32-byte word.

## 3. Components (Go, `backend/internal/hl/`)

### 3.1 `usersigned.go` *(new)* — generic user-signed digest
```go
type Field struct { Name, Type string } // Type ∈ "string" | "address" | "uint64"

// UserSignedDigest builds the EIP-712 digest for a HyperliquidSignTransaction-domain action.
// message maps each field name to its value (string, a 0x-address string, or uint64).
func UserSignedDigest(primaryType string, fields []Field, chainID uint64, message map[string]any) ([32]byte, error)
```
- `encodeType` = `primaryType(type1 name1,type2 name2,…)` → `typeHash`.
- Encode each field (in `fields` order) to a 32-byte word per §2.1; missing/typed
  wrong → error (fail closed, never sign a malformed digest).
- `structHash = keccak256(typeHash ‖ word1 ‖ … ‖ wordN)`.
- `domainSeparator = keccak256(EIP712Domain-typeHash ‖ keccak256("HyperliquidSignTransaction") ‖ keccak256("1") ‖ word(chainID) ‖ word(0x0))`.
- `digest = keccak256(0x19 0x01 ‖ domainSeparator ‖ structHash)`.
- Reuses the existing `keccak(...)` and `word(...)` helpers from `eip712.go`.

### 3.2 `usersigned.go` — approveAgent wrapper
```go
type ApproveAgentInput struct {
	SignatureChainID string // hex, e.g. "0xa4b1"
	HyperliquidChain string // "Mainnet" | "Testnet"
	AgentAddress     string // 0x… 20-byte
	AgentName        string // "" when none (the null→"" case)
	Nonce            uint64
}

func ApproveAgentDigest(in ApproveAgentInput) ([32]byte, error)
```
- Parses `SignatureChainID` (hex) → `chainID uint64` (error on malformed).
- Calls `UserSignedDigest("HyperliquidTransaction:ApproveAgent", approveAgentFields, chainID, message)`
  where `approveAgentFields` is the §2 ordered field table and `message` carries
  `hyperliquidChain`/`agentAddress`/`agentName`/`nonce`.

### 3.3 `signer.go` — signing method
```go
func (s *Signer) SignApproveAgent(in ApproveAgentInput) (Sig, error)
```
- `ApproveAgentDigest(in)` → `signDigest(s.key, digest)` (reuses the merged
  secp256k1 path + RWMutex/closed guards). A generic
  `SignUserSigned(primaryType, fields, chainID, message)` may back it.

## 4. Golden vectors (TS oracle → Go assertion)

### 4.1 Generator (extend `mobile/scripts/gen-golden-vectors.mjs`)
- Additionally write `backend/internal/hl/testdata/golden_usersigned.json` using
  `signUserSignedAction({ wallet, action, types: ApproveAgentTypes })` for the
  signature and viem `hashTypedData(...)` for the digest (independent cross-check).
- Fixed private key (reuse the L1 slice's PK). Cases:
  1. `approve-mainnet-named` — agentName `"myAgent"`, signatureChainId `"0xa4b1"` (42161), hyperliquidChain `"Mainnet"`.
  2. `approve-testnet-empty` — agentName `""` (the null→"" case), signatureChainId `"0x66eee"` (421614, Arbitrum Sepolia), hyperliquidChain `"Testnet"`.
  3. `approve-mainnet-named-2` — a different agentAddress + nonce, mainnet.
- Each vector:
  ```json
  { "name": "…", "signatureChainId": "0xa4b1", "hyperliquidChain": "Mainnet",
    "agentAddress": "0x…", "agentName": "myAgent", "nonce": 1700000000000,
    "privKey": "0x…", "digest": "0x…", "sig": { "r": "0x…", "s": "0x…", "v": 27 } }
  ```

### 4.2 Go assertion `golden_usersigned_test.go`
- Load `golden_usersigned.json`; for each vector: build `ApproveAgentInput`,
  assert `ApproveAgentDigest(in)` == `digest` and `signer.SignApproveAgent(in)`
  == `sig{r,s,v}`, byte-for-byte. Any mismatch fails the build (zero-drift proof).

## 5. Testing / gate

- `usersigned_test.go` (unit): `UserSignedDigest` type-hash string; `string`,
  `address` (left-pad), `uint64` word encodings; the empty-string `agentName`
  (keccak256("") word); malformed inputs (bad address hex, unknown field type,
  bad signatureChainId) return errors without signing.
- `golden_usersigned_test.go`: digest + signature byte-parity across the vectors,
  covering agentName present/empty and Mainnet/Testnet + both chain ids.
- Gate: `cd backend && go test ./... && go vet ./...` (now covers L1 + user-signed
  goldens); `go test -race ./internal/hl/`. server/ and mobile/ untouched.

## 6. Rejected alternatives
- **Focused hardcoded `ApproveAgentDigest` (no generic helper):** slightly less
  code now but every future user-signed action re-implements the domain/struct
  hashing; rejected in favor of the small generic helper (the shared seam).
- **New EIP-712 field types (uint256, bytes, bool) now:** speculative; add when a
  concrete action needs them.
- **Reusing the L1 `golden.json`:** user-signed vectors have a different shape (no
  msgpack/nonce-8/connectionId); a separate `golden_usersigned.json` keeps both
  loaders clean.
