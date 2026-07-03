# Go Signing Core — More User-Signed Actions (withdraw3 / usdSend / approveBuilderFee)

Date: 2026-07-03
Status: Approved (brainstorming)
Depends on: `docs/superpowers/specs/2026-07-03-go-signer-usersigned-design.md` (approveAgent slice, merged in PR #11) — reuses `UserSignedDigest`, `parseHexChainID`, `signDigest`, `Signer`; the TS reference `@nktkas/hyperliquid/signing` (`signUserSignedAction`) + `Withdraw3Types` / `UsdSendTypes` / `ApproveBuilderFeeTypes`

## 1. Goal

Third slice of the Go signing core: extend the **already-merged generic
`UserSignedDigest`** to three more user-signed actions — `withdraw3`, `usdSend`,
`approveBuilderFee` — with typed digest wrappers + `Signer` methods, proven
byte-for-byte against `@nktkas/hyperliquid` via golden vectors. A low-cost,
mechanical extension: **no new EIP-712 field types, no new crypto** — all three
use only the `string`/`address`/`uint64` types the generic helper already
supports. No server/mobile changes; the merged L1 + approveAgent paths are
untouched.

### Non-goals (YAGNI)
- Multi-sig payloads; `uint256`/`bytes`/`bool` field types (add when a concrete
  action needs them — none of these three do).
- Any other user-signed action; tier ②/③ custody; nonce lease/fencing; policy;
  deployment.

## 2. The three actions (EIP-712 types, from the SDK)

Same `HyperliquidSignTransaction` domain as approveAgent (chainId from
`signatureChainId`, verifyingContract 0x0). Only the primaryType + field table
differ. `hyperliquidChain` is a signed field (replay protection). **Note:**
`destination` is a `string` field (the 0x address is signed as its UTF-8 hex
string via `keccak(string)`, NOT as a 20-byte address word) — the field *type* in
the table drives the encoding, so this is handled correctly by the generic helper.

- **withdraw3** — primaryType `HyperliquidTransaction:Withdraw`:
  `string hyperliquidChain, string destination, string amount, uint64 time`.
- **usdSend** — primaryType `HyperliquidTransaction:UsdSend`:
  `string hyperliquidChain, string destination, string amount, uint64 time`
  (identical field shape to withdraw3, different primaryType → different type
  hash → different digest; no cross-action replay).
- **approveBuilderFee** — primaryType `HyperliquidTransaction:ApproveBuilderFee`:
  `string hyperliquidChain, string maxFeeRate, address builder, uint64 nonce`.

`amount` and `maxFeeRate` are HL-formatted **strings** (e.g. `"100.5"`,
`"0.001%"`), not numeric fields.

## 3. Components (`backend/internal/hl/usersigned.go`)

Mirror the merged approveAgent pattern — one Input struct + ordered field table +
digest wrapper per action, each delegating to `UserSignedDigest(primaryType,
fields, chainID, message)` + `parseHexChainID` (both already exist).

```go
type Withdraw3Input struct {
	SignatureChainID string
	HyperliquidChain string
	Destination      string
	Amount           string
	Time             uint64
}
func Withdraw3Digest(in Withdraw3Input) ([32]byte, error) // primaryType "HyperliquidTransaction:Withdraw"

type UsdSendInput struct {
	SignatureChainID string
	HyperliquidChain string
	Destination      string
	Amount           string
	Time             uint64
}
func UsdSendDigest(in UsdSendInput) ([32]byte, error)      // primaryType "HyperliquidTransaction:UsdSend"

type ApproveBuilderFeeInput struct {
	SignatureChainID string
	HyperliquidChain string
	MaxFeeRate       string
	Builder          string
	Nonce            uint64
}
func ApproveBuilderFeeDigest(in ApproveBuilderFeeInput) ([32]byte, error) // "HyperliquidTransaction:ApproveBuilderFee"
```
- Field tables use the exact §2 order and types. `withdraw3`/`usdSend` message
  keys: `hyperliquidChain`/`destination`/`amount`/`time`. `approveBuilderFee`:
  `hyperliquidChain`/`maxFeeRate`/`builder`/`nonce`.

## 4. Signer methods (`signer.go`)

`SignWithdraw3(in)`, `SignUsdSend(in)`, `SignApproveBuilderFee(in)` — each mirrors
the merged `SignApproveAgent` (RLock + `closed || key == nil` guard → the
corresponding Digest → `signDigest(s.key, digest)`). To DRY the four copies of the
guard boilerplate, introduce a small internal helper:
```go
func (s *Signer) signGuarded(digestFn func() ([32]byte, error)) (Sig, error)
```
and have all four user-signed sign methods (incl. a refactored `SignApproveAgent`)
delegate to it. `SignL1Action` may also adopt it (optional, same behavior).

## 5. Golden vectors (TS oracle → Go assertion)

- Extend `mobile/scripts/gen-golden-vectors.mjs`: also write
  `backend/internal/hl/testdata/golden_usersigned_more.json`, using
  `signUserSignedAction({ wallet, action, types })` + viem `hashTypedData` with
  the per-action `Withdraw3Types`/`UsdSendTypes`/`ApproveBuilderFeeTypes`. Reuse
  the fixed PK. Each vector carries an `action` tag identifying which digest to
  build. Cases (mainnet + testnet coverage):
  1. `withdraw3-mainnet` — dest 0x…, amount `"100.5"`, time NONCE, `0xa4b1`/Mainnet.
  2. `usdSend-testnet` — dest 0x…, amount `"25"`, time NONCE, `0x66eee`/Testnet.
  3. `approveBuilderFee-mainnet` — maxFeeRate `"0.001%"`, builder 0x…, nonce NONCE, `0xa4b1`/Mainnet.
  Each: `{ name, action, signatureChainId, hyperliquidChain, destination?, amount?, maxFeeRate?, builder?, time?, nonce?, privKey, digest, sig{r,s,v} }`.
- Go `golden_usersigned_more_test.go`: table-dispatch on `action` to build the
  right `*Input`, assert `<Action>Digest(in)` == `digest` and
  `signer.Sign<Action>(in)` == `sig{r,s,v}`, byte-for-byte.

## 6. Testing / gate
- `usersigned_test.go` (add): each new digest wrapper's field table is correct
  (right primaryType/order/types), and fails closed on a malformed
  `signatureChainId`/`builder` address.
- Gate: `cd backend && go test ./... && go vet ./... && go test -race ./internal/hl/`
  — L1 (18) + approveAgent (6) + the new goldens; vet clean; no data race.
  server/ and mobile/ untouched except the generator.

## 7. Rejected alternatives
- **A single generic `SignUserSigned(primaryType, fields, chainID, message)`
  public method instead of typed wrappers:** less type-safety at call sites and
  leaks the field-table detail to callers; the typed wrappers (matching
  approveAgent) are clearer. The generic `UserSignedDigest` already provides the
  shared core.
- **Encoding `destination`/`builder` as `address` words:** wrong — the SDK type
  tables mark `destination` as `string` and only `approveBuilderFee.builder` as
  `address`; follow the tables exactly (the golden vectors enforce this).
