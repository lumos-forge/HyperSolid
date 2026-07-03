# Go Signing Core — More User-Signed Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the merged generic `UserSignedDigest` to `withdraw3`/`usdSend`/`approveBuilderFee` with typed digest wrappers + `Signer` methods, proven byte-for-byte against `@nktkas/hyperliquid`.

**Architecture:** A mechanical extension mirroring the merged approveAgent slice — three Input structs + ordered field tables + digest wrappers delegating to `UserSignedDigest`, and three `Signer` methods delegating to a new `signGuarded` helper. The golden generator emits `golden_usersigned_more.json` (TS oracle); Go tests assert digest + signature byte-for-byte. No new field types or crypto.

**Tech Stack:** Go 1.26; existing deps only (`golang.org/x/crypto/sha3`, `github.com/decred/dcrd/dcrec/secp256k1/v4`). Generator: Node ESM using `@nktkas/hyperliquid/signing` (`signUserSignedAction`) + `@nktkas/hyperliquid/api/exchange` (`Withdraw3Types`/`UsdSendTypes`/`ApproveBuilderFeeTypes`) + `viem`. Spec: `docs/superpowers/specs/2026-07-03-go-signer-usersigned-more-design.md`.

---

## Baselines (must stay green)

- **Backend:** `cd backend && go build ./... && go vet ./... && go test ./...` green (merged: L1 18 goldens + approveAgent 3 digest + 3 sig + unit tests). Final gate adds `go test -race ./internal/hl/`.
- `server/` and `mobile/` untouched (except the generator script).

## Context you can rely on (merged, in the repo)

- `backend/internal/hl/usersigned.go`: `type Field struct{ Name, Type string }`, `func UserSignedDigest(primaryType string, fields []Field, chainID uint64, message map[string]any) ([32]byte, error)`, `func parseHexChainID(s string) (uint64, error)`, and the `ApproveAgentInput`/`ApproveAgentDigest` pattern. Top import block has `encoding/hex`, `fmt`, `math/big`, `strconv`, `strings`.
- `backend/internal/hl/signer.go`: `type Sig struct{ R,S [32]byte; V byte }`, `Signer{ mu sync.RWMutex; key *secp.PrivateKey; keyBuf []byte; closed bool }`, `func signDigest(key *secp.PrivateKey, digest [32]byte) (Sig, error)`, and `SignApproveAgent` (`s.mu.RLock(); defer s.mu.RUnlock(); if s.closed || s.key == nil { return Sig{}, errors.New("signer: closed") }; digest, err := ApproveAgentDigest(in); …; return signDigest(s.key, digest)`). `errors` is imported.
- `backend/internal/hl/golden_test.go`: `type goldenSig struct{ R,S string; V int }` (package `hl`).
- `mobile/scripts/gen-golden-vectors.mjs`: builds L1 + user-signed (approveAgent) vectors; already imports `signUserSignedAction`, `hashTypedData`, defines `PK`/`account`/`NONCE`/`ZERO`/`normSig`.

## Conventions (apply to every task)

- **TDD:** failing test first → watch fail → implement → watch pass → commit.
- **Commit:** `git commit --no-verify -m "<msg>"` with trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Push only when the user says so.
- **Golden vectors are the source of truth** — never edit them to fit code; only regenerate from the TS oracle.

## File Structure

- `mobile/scripts/gen-golden-vectors.mjs` — extend to write `golden_usersigned_more.json`.
- `backend/internal/hl/testdata/golden_usersigned_more.json` *(new, committed)*.
- `backend/internal/hl/usersigned.go` — 3 Input structs + field tables + digest wrappers.
- `backend/internal/hl/usersigned_test.go` — unit tests (field tables + fail-closed).
- `backend/internal/hl/golden_usersigned_more_test.go` *(new)* — golden digest + signature asserts.
- `backend/internal/hl/signer.go` — `signGuarded` + 3 sign methods (+ refactor `SignApproveAgent`).

---

## Task 1: Extend the generator → `golden_usersigned_more.json`

**Files:**
- Modify: `mobile/scripts/gen-golden-vectors.mjs`
- Create (generated, committed): `backend/internal/hl/testdata/golden_usersigned_more.json`

- [ ] **Step 1: Edit `mobile/scripts/gen-golden-vectors.mjs`**

Add the types import near the existing `ApproveAgentTypes` import:
```js
import { Withdraw3Types, UsdSendTypes, ApproveBuilderFeeTypes } from "@nktkas/hyperliquid/api/exchange";
```
(`signUserSignedAction`, `hashTypedData`, `PK`, `account`, `NONCE`, `ZERO`, `normSig`, `writeFileSync`, `resolve`, `dirname`, `fileURLToPath` are already present from the earlier slices.)

Append this block at the END of the file:
```js
// --- More user-signed actions: withdraw3 / usdSend / approveBuilderFee ---
const moreCases = [
  { name: "withdraw3-mainnet", action: "withdraw3", types: Withdraw3Types, primaryType: "HyperliquidTransaction:Withdraw", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", fields: { destination: "0x000000000000000000000000000000000000dEaD", amount: "100.5", time: NONCE } },
  { name: "usdSend-testnet", action: "usdSend", types: UsdSendTypes, primaryType: "HyperliquidTransaction:UsdSend", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", fields: { destination: "0x00000000000000000000000000000000cafe0001", amount: "25", time: NONCE } },
  { name: "approveBuilderFee-mainnet", action: "approveBuilderFee", types: ApproveBuilderFeeTypes, primaryType: "HyperliquidTransaction:ApproveBuilderFee", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", fields: { maxFeeRate: "0.001%", builder: "0x1111111111111111111111111111111111111111", nonce: NONCE } },
];

const moreOut = [];
for (const c of moreCases) {
  const chainId = parseInt(c.signatureChainId);
  const message = { hyperliquidChain: c.hyperliquidChain };
  for (const [k, v] of Object.entries(c.fields)) {
    message[k] = (k === "time" || k === "nonce") ? BigInt(v) : v;
  }
  const digest = hashTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId, verifyingContract: ZERO },
    types: c.types,
    primaryType: c.primaryType,
    message,
  });
  const action = { type: c.action, signatureChainId: c.signatureChainId, hyperliquidChain: c.hyperliquidChain, ...c.fields };
  const sig = normSig(await signUserSignedAction({ wallet: account, action, types: c.types }));
  moreOut.push({ name: c.name, action: c.action, signatureChainId: c.signatureChainId, hyperliquidChain: c.hyperliquidChain, ...c.fields, privKey: PK, digest, sig });
}
const moreDest = resolve(dirname(fileURLToPath(import.meta.url)), "../../backend/internal/hl/testdata/golden_usersigned_more.json");
writeFileSync(moreDest, JSON.stringify(moreOut, null, 2) + "\n");
console.log(`wrote ${moreOut.length} more user-signed vectors to ${moreDest}`);
```

- [ ] **Step 2: Regenerate**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid/mobile && node scripts/gen-golden-vectors.mjs`
Expected: prints the three earlier lines plus `wrote 3 more user-signed vectors to …/golden_usersigned_more.json`.

The pre-existing `golden.json` and `golden_usersigned.json` must be UNCHANGED. Verify:
`cd /Users/bill/Documents/GitHub/HyperSolid && git status --short backend/internal/hl/testdata/`
Expected: only `golden_usersigned_more.json` is new/untracked; `golden.json` and `golden_usersigned.json` show NO modification. If either shows modified, you altered an earlier section — revert it.

- [ ] **Step 3: Sanity-check**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid && node -e "const g=require('./backend/internal/hl/testdata/golden_usersigned_more.json'); console.log(g.length, g.every(v=>['withdraw3','usdSend','approveBuilderFee'].includes(v.action) && /^0x[0-9a-f]{64}$/.test(v.digest) && /^0x[0-9a-f]{64}$/.test(v.sig.r) && [27,28].includes(v.sig.v)))"`
Expected: `3 true`.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/scripts/gen-golden-vectors.mjs backend/internal/hl/testdata/golden_usersigned_more.json && git commit --no-verify -m "test(backend): golden vectors for withdraw3/usdSend/approveBuilderFee

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Digest wrappers + golden digest assertion

**Files:**
- Modify: `backend/internal/hl/usersigned.go`
- Test: `backend/internal/hl/usersigned_test.go`, `backend/internal/hl/golden_usersigned_more_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/hl/usersigned_test.go`:
```go
func TestMoreUserSignedFieldTables(t *testing.T) {
	if got := userSignedTypeString("HyperliquidTransaction:Withdraw", usdTransferFields); got != "HyperliquidTransaction:Withdraw(string hyperliquidChain,string destination,string amount,uint64 time)" {
		t.Fatalf("withdraw type string = %q", got)
	}
	if got := userSignedTypeString("HyperliquidTransaction:ApproveBuilderFee", approveBuilderFeeFields); got != "HyperliquidTransaction:ApproveBuilderFee(string hyperliquidChain,string maxFeeRate,address builder,uint64 nonce)" {
		t.Fatalf("builderFee type string = %q", got)
	}
}

func TestMoreDigestsFailClosed(t *testing.T) {
	if _, err := Withdraw3Digest(Withdraw3Input{SignatureChainID: "0xzz", HyperliquidChain: "Mainnet", Destination: "0xdead", Amount: "1", Time: 1}); err == nil {
		t.Fatal("withdraw3: expected chainId error")
	}
	if _, err := UsdSendDigest(UsdSendInput{SignatureChainID: "", HyperliquidChain: "Mainnet", Destination: "0xdead", Amount: "1", Time: 1}); err == nil {
		t.Fatal("usdSend: expected empty-chainId error")
	}
	if _, err := ApproveBuilderFeeDigest(ApproveBuilderFeeInput{SignatureChainID: "0xa4b1", HyperliquidChain: "Mainnet", MaxFeeRate: "0.1%", Builder: "0x1234", Nonce: 1}); err == nil {
		t.Fatal("approveBuilderFee: expected bad-builder-address error")
	}
}
```

Create `backend/internal/hl/golden_usersigned_more_test.go`:
```go
package hl

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type moreVector struct {
	Name             string    `json:"name"`
	Action           string    `json:"action"`
	SignatureChainID string    `json:"signatureChainId"`
	HyperliquidChain string    `json:"hyperliquidChain"`
	Destination      string    `json:"destination"`
	Amount           string    `json:"amount"`
	Time             uint64    `json:"time"`
	MaxFeeRate       string    `json:"maxFeeRate"`
	Builder          string    `json:"builder"`
	Nonce            uint64    `json:"nonce"`
	PrivKey          string    `json:"privKey"`
	Digest           string    `json:"digest"`
	Sig              goldenSig `json:"sig"`
}

func loadMoreGolden(t *testing.T) []moreVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden_usersigned_more.json")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var vs []moreVector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(vs) == 0 {
		t.Fatal("empty golden_usersigned_more.json")
	}
	return vs
}

func moreDigest(t *testing.T, v moreVector) [32]byte {
	t.Helper()
	var d [32]byte
	var err error
	switch v.Action {
	case "withdraw3":
		d, err = Withdraw3Digest(Withdraw3Input{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "usdSend":
		d, err = UsdSendDigest(UsdSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "approveBuilderFee":
		d, err = ApproveBuilderFeeDigest(ApproveBuilderFeeInput{v.SignatureChainID, v.HyperliquidChain, v.MaxFeeRate, v.Builder, v.Nonce})
	default:
		t.Fatalf("unknown action %q", v.Action)
	}
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	return d
}

func TestMoreDigestGolden(t *testing.T) {
	for _, v := range loadMoreGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			got := moreDigest(t, v)
			if hex.EncodeToString(got[:]) != v.Digest[2:] {
				t.Fatalf("digest = 0x%s, want %s", hex.EncodeToString(got[:]), v.Digest)
			}
		})
	}
}
```

- [ ] **Step 2: Run them, expect fail**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid/backend && go test ./internal/hl/ -run "TestMore"`
Expected: FAIL (compile error — `usdTransferFields`/`Withdraw3Digest`/`Withdraw3Input`/… undefined).

- [ ] **Step 3: Implement** — append to `backend/internal/hl/usersigned.go` (no new imports needed):

```go
// --- withdraw3 / usdSend (identical field table, different primaryType) ---

// usdTransferFields is the shared EIP-712 field table for withdraw3 and usdSend.
var usdTransferFields = []Field{
	{"hyperliquidChain", "string"},
	{"destination", "string"},
	{"amount", "string"},
	{"time", "uint64"},
}

type Withdraw3Input struct {
	SignatureChainID string
	HyperliquidChain string
	Destination      string
	Amount           string
	Time             uint64
}

func Withdraw3Digest(in Withdraw3Input) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:Withdraw", usdTransferFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "destination": in.Destination, "amount": in.Amount, "time": in.Time,
	})
}

type UsdSendInput struct {
	SignatureChainID string
	HyperliquidChain string
	Destination      string
	Amount           string
	Time             uint64
}

func UsdSendDigest(in UsdSendInput) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:UsdSend", usdTransferFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "destination": in.Destination, "amount": in.Amount, "time": in.Time,
	})
}

// --- approveBuilderFee ---

var approveBuilderFeeFields = []Field{
	{"hyperliquidChain", "string"},
	{"maxFeeRate", "string"},
	{"builder", "address"},
	{"nonce", "uint64"},
}

type ApproveBuilderFeeInput struct {
	SignatureChainID string
	HyperliquidChain string
	MaxFeeRate       string
	Builder          string
	Nonce            uint64
}

func ApproveBuilderFeeDigest(in ApproveBuilderFeeInput) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:ApproveBuilderFee", approveBuilderFeeFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "maxFeeRate": in.MaxFeeRate, "builder": in.Builder, "nonce": in.Nonce,
	})
}
```

- [ ] **Step 4: Run them, expect pass**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid/backend && go test ./internal/hl/ -run "TestMore" -v`
Expected: PASS — `TestMoreUserSignedFieldTables`, `TestMoreDigestsFailClosed`, and `TestMoreDigestGolden` (3 vectors: withdraw3/usdSend/approveBuilderFee digests match viem byte-for-byte). Then `go test ./... && go vet ./...` → all green.

If a golden digest mismatches, report got-vs-want and STOP (do NOT edit the golden file) — check the field table order/types (esp. `destination` must be `string`, `builder` must be `address`) and the primaryType.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/hl/usersigned.go backend/internal/hl/usersigned_test.go backend/internal/hl/golden_usersigned_more_test.go && git commit --no-verify -m "feat(backend): withdraw3/usdSend/approveBuilderFee digests + golden digest assertion

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `signGuarded` + Signer methods + golden signature assertion

**Files:**
- Modify: `backend/internal/hl/signer.go`
- Test: `backend/internal/hl/golden_usersigned_more_test.go`

- [ ] **Step 1: Write the failing test** — append to `backend/internal/hl/golden_usersigned_more_test.go`:

```go
func moreSign(t *testing.T, s *Signer, v moreVector) (Sig, error) {
	t.Helper()
	switch v.Action {
	case "withdraw3":
		return s.SignWithdraw3(Withdraw3Input{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "usdSend":
		return s.SignUsdSend(UsdSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "approveBuilderFee":
		return s.SignApproveBuilderFee(ApproveBuilderFeeInput{v.SignatureChainID, v.HyperliquidChain, v.MaxFeeRate, v.Builder, v.Nonce})
	}
	t.Fatalf("unknown action %q", v.Action)
	return Sig{}, nil
}

func TestMoreSignGolden(t *testing.T) {
	for _, v := range loadMoreGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			key, err := hex.DecodeString(v.PrivKey[2:])
			if err != nil {
				t.Fatalf("decode key: %v", err)
			}
			s, err := NewSigner(key)
			if err != nil {
				t.Fatalf("NewSigner: %v", err)
			}
			defer s.Close()
			sig, err := moreSign(t, s, v)
			if err != nil {
				t.Fatalf("sign: %v", err)
			}
			gotR := "0x" + hex.EncodeToString(sig.R[:])
			gotS := "0x" + hex.EncodeToString(sig.S[:])
			if gotR != v.Sig.R || gotS != v.Sig.S || int(sig.V) != v.Sig.V {
				t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", gotR, gotS, sig.V, v.Sig.R, v.Sig.S, v.Sig.V)
			}
		})
	}
}
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid/backend && go test ./internal/hl/ -run "TestMoreSignGolden"`
Expected: FAIL (compile error — `SignWithdraw3`/`SignUsdSend`/`SignApproveBuilderFee` undefined).

- [ ] **Step 3: Implement** — edit `backend/internal/hl/signer.go`.

Add a shared guarded-sign helper and the three methods, and refactor `SignApproveAgent` to use the helper. Add:
```go
// signGuarded runs digestFn under the read lock + closed/nil guard, then signs the digest.
func (s *Signer) signGuarded(digestFn func() ([32]byte, error)) (Sig, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed || s.key == nil {
		return Sig{}, errors.New("signer: closed")
	}
	digest, err := digestFn()
	if err != nil {
		return Sig{}, err
	}
	return signDigest(s.key, digest)
}

// SignWithdraw3 signs a withdraw3 user-signed action.
func (s *Signer) SignWithdraw3(in Withdraw3Input) (Sig, error) {
	return s.signGuarded(func() ([32]byte, error) { return Withdraw3Digest(in) })
}

// SignUsdSend signs a usdSend user-signed action.
func (s *Signer) SignUsdSend(in UsdSendInput) (Sig, error) {
	return s.signGuarded(func() ([32]byte, error) { return UsdSendDigest(in) })
}

// SignApproveBuilderFee signs an approveBuilderFee user-signed action.
func (s *Signer) SignApproveBuilderFee(in ApproveBuilderFeeInput) (Sig, error) {
	return s.signGuarded(func() ([32]byte, error) { return ApproveBuilderFeeDigest(in) })
}
```
Then REPLACE the existing `SignApproveAgent` body with the delegating form (behavior-preserving):
```go
// SignApproveAgent signs an approveAgent user-signed action (HyperliquidSignTransaction domain).
func (s *Signer) SignApproveAgent(in ApproveAgentInput) (Sig, error) {
	return s.signGuarded(func() ([32]byte, error) { return ApproveAgentDigest(in) })
}
```

- [ ] **Step 4: Run it + full gate**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid/backend && go test ./internal/hl/ -run "TestMoreSignGolden" -v`
Expected: PASS for the 3 vectors (r/s/v byte-for-byte vs the TS `signUserSignedAction`).

Then the full gate:
`cd /Users/bill/Documents/GitHub/HyperSolid/backend && go test ./... && go vet ./... && go test -race ./internal/hl/`
Expected: all green — L1 (18) + approveAgent (6) + the new digest/sig goldens + unit tests + the refactored `SignApproveAgent` golden (unchanged); vet clean; no data race.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/hl/signer.go backend/internal/hl/golden_usersigned_more_test.go && git commit --no-verify -m "feat(backend): Signer methods for withdraw3/usdSend/approveBuilderFee + signGuarded

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final verification

- [ ] `cd backend && go build ./... && go vet ./... && go test ./... && go test -race ./internal/hl/` — all green. New goldens (3 digest + 3 signature) pass byte-for-byte vs `@nktkas/hyperliquid`, covering withdraw3/usdSend/approveBuilderFee across Mainnet/Testnet; the merged L1 + approveAgent goldens still pass.
- [ ] `git status --short backend/internal/hl/testdata/` shows only `golden_usersigned_more.json` new; `golden.json`/`golden_usersigned.json` byte-unchanged; `go.mod`/`go.sum` unchanged (no new deps).
- [ ] Report the new vector count (3) + that digest + signature match the oracle. Await the user's explicit "push".

## Self-review notes (spec coverage)

- 3 digest wrappers reusing `UserSignedDigest` (string/address/uint64; `destination` as string, `builder` as address) → Task 2. ✓
- `withdraw3`/`usdSend` share a field table, distinct primaryType → Task 2 (`usdTransferFields`). ✓
- 3 `Signer` methods + `signGuarded` helper (refactor `SignApproveAgent`) → Task 3. ✓
- Golden vectors (extended generator + `golden_usersigned_more.json` + Go digest/sig asserts) → Tasks 1–3. ✓
- Fail-closed on malformed chainId/address → Task 2 (`TestMoreDigestsFailClosed`). ✓
- No new field types/crypto/deps; L1 + approveAgent goldens untouched → Task 1 checks + final. ✓
- Non-goals (multi-sig, uint256/bytes, other actions, KMS, …) → not implemented. ✓
