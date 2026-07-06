# Go 签名核第六片：user-signed 划转动作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Go 签名核新增两个 user-signed 划转动作——`usdClassTransfer`（spot↔perp）与 `spotSend`——并为通用 EIP-712 哈希器新增 `bool` 字段类型，用 `@nktkas` 作 oracle 的 byte-exact golden 向量断言 digest + 签名。

**Architecture:** 纯增量，复用既有 `UserSignedDigest` 通用哈希器（`HyperliquidSignTransaction` 域）+ `Signer.signGuarded`；`encodeField` 加 `bool` 分支（EIP-712 bool→32 字节 0/1 word）；扩展既有 user-signed golden `moreCases` 桶。无新签名路径、无 mobile/server 运行时代码改动。

**Tech Stack:** Go（`backend/internal/hl`，`go test`）；golden 生成脚本 `mobile/scripts/gen-golden-vectors.mjs`（Node ESM，oracle=`@nktkas/hyperliquid/signing` + `viem`）。

---

## File Structure

- `backend/internal/hl/usersigned.go` —— `encodeField` 加 `bool`；两张字段表 + 两个 Input + 两个 `*Digest`。
- `backend/internal/hl/signer.go` —— 两个 `Sign*` 方法。
- `backend/internal/hl/usersigned_test.go` —— `encodeField("bool")` + 两个 digest 单测。
- `mobile/scripts/gen-golden-vectors.mjs` —— import + `moreCases` 增加 3 条向量。
- `backend/internal/hl/testdata/golden_usersigned_more.json` —— 由脚本重新生成。
- `backend/internal/hl/golden_usersigned_more_test.go` —— `moreVector` 加字段 + `moreDigest`/`moreSign` switch。

## 现有约定（供无上下文的实现者参考）

- user-signed 通用哈希器：`UserSignedDigest(primaryType string, fields []Field, chainID uint64, message map[string]any) ([32]byte, error)`（`usersigned.go`）。`Field{Name, Type string}`；`encodeField(f, val)` 现支持 `"string"`/`"address"`/`"uint64"`，用 `word(*big.Int) []byte`（32 字节大端）与 `keccak`。`parseHexChainID(s string) (uint64, error)` 解析如 `"0xa4b1"`。
- 既有 user-signed：`ApproveAgentDigest` / `Withdraw3Digest` / `UsdSendDigest` / `ApproveBuilderFeeDigest`；`usdTransferFields` 用 `{"destination","string"}`（destination 按字符串哈希）。
- `Signer.signGuarded(func() ([32]byte, error)) (Sig, error)`（`signer.go`）在读锁 + closed 守卫下算 digest 再签名。既有 `SignWithdraw3` 等即用它。
- Golden（user-signed 扩展桶）：`golden_usersigned_more_test.go` 有 `moreVector` 结构、`moreDigest(t,v)` switch、`moreSign(t,s,v)` switch，`TestMoreDigestGolden`/`TestMoreSignGolden` 循环断言 digest + 签名逐字节相等；向量在 `testdata/golden_usersigned_more.json`，由 `gen-golden-vectors.mjs` 的 `moreCases` 循环生成（`message[k] = (k==="time"||k==="nonce") ? BigInt(v) : v`，且 `message` 先含 `hyperliquidChain`）。
- 基线：`cd backend && go test ./...` 全绿；`go vet ./...` 干净。
- 提交用 `--no-verify` 并附 `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: `encodeField` bool + `usdClassTransfer` digest + signer

**Files:**
- Modify: `backend/internal/hl/usersigned.go`
- Modify: `backend/internal/hl/signer.go`
- Test: `backend/internal/hl/usersigned_test.go`

- [ ] **Step 1: Write the failing tests**

在 `backend/internal/hl/usersigned_test.go` 末尾追加：

```go
func TestEncodeFieldBool(t *testing.T) {
	tr, err := encodeField(Field{"toPerp", "bool"}, true)
	if err != nil {
		t.Fatalf("bool true: %v", err)
	}
	wantTrue := make([]byte, 32)
	wantTrue[31] = 1
	if !bytes.Equal(tr, wantTrue) {
		t.Fatalf("bool(true) word = %x, want %x", tr, wantTrue)
	}
	fa, err := encodeField(Field{"toPerp", "bool"}, false)
	if err != nil {
		t.Fatalf("bool false: %v", err)
	}
	wantFalse := make([]byte, 32)
	if !bytes.Equal(fa, wantFalse) {
		t.Fatalf("bool(false) word = %x, want all-zero", fa)
	}
	if _, err := encodeField(Field{"toPerp", "bool"}, "nope"); err == nil {
		t.Fatal("expected type error for non-bool value")
	}
}

func TestUsdClassTransferDigestTogglesOnToPerp(t *testing.T) {
	base := UsdClassTransferInput{SignatureChainID: "0xa4b1", HyperliquidChain: "Mainnet", Amount: "100", ToPerp: true, Nonce: 1700000000000}
	toPerp, err := UsdClassTransferDigest(base)
	if err != nil {
		t.Fatalf("toPerp: %v", err)
	}
	off := base
	off.ToPerp = false
	toSpot, err := UsdClassTransferDigest(off)
	if err != nil {
		t.Fatalf("toSpot: %v", err)
	}
	if toPerp == toSpot {
		t.Fatal("digest must differ when toPerp flips")
	}
	if _, err := UsdClassTransferDigest(UsdClassTransferInput{SignatureChainID: "0x", HyperliquidChain: "Mainnet", Amount: "1", Nonce: 1}); err == nil {
		t.Fatal("expected error on empty signatureChainId")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/hl/ -run 'TestEncodeFieldBool|TestUsdClassTransferDigest'`
Expected: FAIL —— `undefined: UsdClassTransferInput` / `UsdClassTransferDigest`，且 `encodeField` 尚不支持 `"bool"`（编译错误 + 逻辑错误）。

- [ ] **Step 3: Add the bool encoder + usdClassTransfer digest**

在 `backend/internal/hl/usersigned.go` 的 `encodeField` 函数 `switch f.Type` 中，`case "uint64":` 之后、`default:` 之前，插入：

```go
	case "bool":
		bv, ok := val.(bool)
		if !ok {
			return nil, fmt.Errorf("field %q: expected bool, got %T", f.Name, val)
		}
		n := uint64(0)
		if bv {
			n = 1
		}
		return word(new(big.Int).SetUint64(n)), nil
```

然后在 `usersigned.go` 末尾追加：

```go
// --- usdClassTransfer (spot<->perp USDC transfer; toPerp is an EIP-712 bool) ---

var usdClassTransferFields = []Field{
	{"hyperliquidChain", "string"},
	{"amount", "string"},
	{"toPerp", "bool"},
	{"nonce", "uint64"},
}

type UsdClassTransferInput struct {
	SignatureChainID string
	HyperliquidChain string
	Amount           string
	ToPerp           bool
	Nonce            uint64
}

func UsdClassTransferDigest(in UsdClassTransferInput) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:UsdClassTransfer", usdClassTransferFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "amount": in.Amount, "toPerp": in.ToPerp, "nonce": in.Nonce,
	})
}
```

在 `backend/internal/hl/signer.go` 中，`SignApproveBuilderFee` 方法之后追加：

```go
// SignUsdClassTransfer signs a usdClassTransfer user-signed action.
func (s *Signer) SignUsdClassTransfer(in UsdClassTransferInput) (Sig, error) {
	return s.signGuarded(func() ([32]byte, error) { return UsdClassTransferDigest(in) })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/hl/ -run 'TestEncodeField|TestUsdClassTransferDigest'`
Expected: PASS（既有 `TestEncodeField`/`TestEncodeFieldErrors` 保持绿；新 bool + usdClassTransfer 测试通过）。
再跑整包：`cd backend && go test ./internal/hl/` → PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/internal/hl/usersigned.go backend/internal/hl/signer.go backend/internal/hl/usersigned_test.go
git commit --no-verify -m "feat(backend): EIP-712 bool field + usdClassTransfer digest/signer

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `spotSend` digest + signer

**Files:**
- Modify: `backend/internal/hl/usersigned.go`
- Modify: `backend/internal/hl/signer.go`
- Test: `backend/internal/hl/usersigned_test.go`

- [ ] **Step 1: Write the failing test**

在 `backend/internal/hl/usersigned_test.go` 末尾追加：

```go
func TestSpotSendDigest(t *testing.T) {
	base := SpotSendInput{
		SignatureChainID: "0xa4b1", HyperliquidChain: "Mainnet",
		Destination: "0x000000000000000000000000000000000000dEaD",
		Token:       "USDC:0xeb62eee3685fc4c43992febcd9e75443",
		Amount:      "1", Time: 1700000000000,
	}
	d1, err := SpotSendDigest(base)
	if err != nil {
		t.Fatalf("spotSend: %v", err)
	}
	other := base
	other.Token = "PURR:0x0000000000000000000000000000000000000000"
	d2, err := SpotSendDigest(other)
	if err != nil {
		t.Fatalf("spotSend other token: %v", err)
	}
	if d1 == d2 {
		t.Fatal("digest must differ when token differs")
	}
	if _, err := SpotSendDigest(SpotSendInput{SignatureChainID: "0x"}); err == nil {
		t.Fatal("expected error on empty signatureChainId")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/hl/ -run TestSpotSendDigest`
Expected: FAIL —— `undefined: SpotSendInput` / `SpotSendDigest`（编译错误）。

- [ ] **Step 3: Implement spotSend digest + signer**

在 `backend/internal/hl/usersigned.go` 末尾追加：

```go
// --- spotSend (spot token transfer; destination hashed as a string, matching HL) ---

var spotSendFields = []Field{
	{"hyperliquidChain", "string"},
	{"destination", "string"},
	{"token", "string"},
	{"amount", "string"},
	{"time", "uint64"},
}

type SpotSendInput struct {
	SignatureChainID string
	HyperliquidChain string
	Destination      string
	Token            string
	Amount           string
	Time             uint64
}

func SpotSendDigest(in SpotSendInput) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:SpotSend", spotSendFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "destination": in.Destination, "token": in.Token, "amount": in.Amount, "time": in.Time,
	})
}
```

在 `backend/internal/hl/signer.go` 中，`SignUsdClassTransfer` 方法之后追加：

```go
// SignSpotSend signs a spotSend user-signed action.
func (s *Signer) SignSpotSend(in SpotSendInput) (Sig, error) {
	return s.signGuarded(func() ([32]byte, error) { return SpotSendDigest(in) })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/hl/ -run TestSpotSendDigest`
Expected: PASS。
再跑整包：`cd backend && go test ./internal/hl/` → PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/internal/hl/usersigned.go backend/internal/hl/signer.go backend/internal/hl/usersigned_test.go
git commit --no-verify -m "feat(backend): spotSend digest/signer

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: 跨语言 golden 向量（usdClassTransfer / spotSend）

**Files:**
- Modify: `mobile/scripts/gen-golden-vectors.mjs`
- Regenerate: `backend/internal/hl/testdata/golden_usersigned_more.json`
- Modify: `backend/internal/hl/golden_usersigned_more_test.go`

- [ ] **Step 1: 扩展生成脚本的 import 与 moreCases**

在 `mobile/scripts/gen-golden-vectors.mjs` 顶部，把从 `@nktkas/hyperliquid/api/exchange` 的具名导入扩展为包含 `UsdClassTransferTypes, SpotSendTypes`。当前该行为：

```js
import { ApproveAgentTypes, Withdraw3Types, UsdSendTypes, ApproveBuilderFeeTypes } from "@nktkas/hyperliquid/api/exchange";
```

改为：

```js
import { ApproveAgentTypes, Withdraw3Types, UsdSendTypes, ApproveBuilderFeeTypes, UsdClassTransferTypes, SpotSendTypes } from "@nktkas/hyperliquid/api/exchange";
```

在 `moreCases` 数组末尾（`approveBuilderFee-mainnet` 条目之后）追加：

```js
  { name: "usdClassTransfer-toPerp-mainnet", action: "usdClassTransfer", types: UsdClassTransferTypes, primaryType: "HyperliquidTransaction:UsdClassTransfer", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", fields: { amount: "100", toPerp: true, nonce: NONCE } },
  { name: "usdClassTransfer-toSpot-testnet", action: "usdClassTransfer", types: UsdClassTransferTypes, primaryType: "HyperliquidTransaction:UsdClassTransfer", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", fields: { amount: "50.5", toPerp: false, nonce: NONCE } },
  { name: "spotSend-mainnet", action: "spotSend", types: SpotSendTypes, primaryType: "HyperliquidTransaction:SpotSend", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", fields: { destination: "0x000000000000000000000000000000000000dEaD", token: "USDC:0xeb62eee3685fc4c43992febcd9e75443", amount: "1", time: NONCE } },
```

- [ ] **Step 2: 重新生成 golden_usersigned_more.json**

Run: `cd mobile && node scripts/gen-golden-vectors.mjs`
Expected: 打印 `wrote 6 more user-signed vectors to …/golden_usersigned_more.json`（原 3 条 + 新 3 条）。运行 `git -C /Users/bill/Documents/GitHub/HyperSolid --no-pager diff --stat`，应仅 `mobile/scripts/gen-golden-vectors.mjs` 与 `backend/internal/hl/testdata/golden_usersigned_more.json` 变化；若 `golden.json` 或 `golden_usersigned.json` 意外变化则 STOP 报告。

- [ ] **Step 3: Run golden test to verify it fails (unknown action)**

Run: `cd backend && go test ./internal/hl/ -run TestMore`
Expected: FAIL —— `moreDigest` / `moreSign` 对新 action 触发 `t.Fatalf("unknown action %q")`（switch 尚未扩展；`ToPerp`/`Token` 也未在 `moreVector` 结构中）。

- [ ] **Step 4: 扩展 moreVector 结构 + 两个 switch**

在 `backend/internal/hl/golden_usersigned_more_test.go` 的 `moreVector` 结构体中，`Nonce uint64 \`json:"nonce"\`` 字段之后追加两行：

```go
	ToPerp           bool      `json:"toPerp"`
	Token            string    `json:"token"`
```

在 `moreDigest` 函数的 `switch v.Action` 中，`case "approveBuilderFee":` 分支之后、`default:` 之前，插入：

```go
	case "usdClassTransfer":
		d, err = UsdClassTransferDigest(UsdClassTransferInput{v.SignatureChainID, v.HyperliquidChain, v.Amount, v.ToPerp, v.Nonce})
	case "spotSend":
		d, err = SpotSendDigest(SpotSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Token, v.Amount, v.Time})
```

在 `moreSign` 函数的 `switch v.Action` 中，`case "approveBuilderFee":` 分支之后、结尾 `t.Fatalf("unknown action %q", v.Action)` 之前，插入：

```go
	case "usdClassTransfer":
		return s.SignUsdClassTransfer(UsdClassTransferInput{v.SignatureChainID, v.HyperliquidChain, v.Amount, v.ToPerp, v.Nonce})
	case "spotSend":
		return s.SignSpotSend(SpotSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Token, v.Amount, v.Time})
```

- [ ] **Step 5: Run golden tests to verify byte-exact pass**

Run: `cd backend && go test ./internal/hl/ -run TestMore`
Expected: PASS —— 新 3 条向量的 `digest` 与签名 `{r,s,v}` 与 `@nktkas` oracle 逐字节相等（含 toPerp true/false 的 bool 编码、spotSend 的 string destination/token）。若 FAIL，说明字段顺序/类型/bool 编码与 wire 形状不符（fail-closed），回查 Task 1/2 的字段表与 Step 1 的 moreCases。

- [ ] **Step 6: Full suite + vet + commit**

Run: `cd backend && go test ./... && go vet ./...`
Expected: 全部 `ok`；vet 无输出。

```bash
git add mobile/scripts/gen-golden-vectors.mjs backend/internal/hl/testdata/golden_usersigned_more.json backend/internal/hl/golden_usersigned_more_test.go
git commit --no-verify -m "test(backend): golden vectors for usdClassTransfer/spotSend

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd backend && go test ./...` —— 全绿。
- `cd backend && go vet ./...` —— 干净。
- `git diff --stat main...HEAD` —— 仅触及：`usersigned.go`、`signer.go`、`usersigned_test.go`、`golden_usersigned_more_test.go`、`testdata/golden_usersigned_more.json`、`gen-golden-vectors.mjs`、以及两份 docs（spec + 本 plan）。无 mobile/server 运行时代码改动。
