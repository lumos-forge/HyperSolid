# Go 签名核第六片：user-signed 划转动作（usdClassTransfer + spotSend）

日期：2026-07-06
状态：已批准，待实现

## 背景

Go 签名核（`backend/internal/hl`）的 user-signed 动作（`HyperliquidSignTransaction` 域）现覆盖：`approveAgent` / `withdraw3` / `usdSend` / `approveBuilderFee`。通用哈希器 `UserSignedDigest(primaryType, []Field, chainID, message)` 支持字段类型 `string` / `address` / `uint64`。

本片前瞻性补全两个划转类 user-signed 动作（App 目前未调用；`usdClassTransfer` 为 spot↔perp 资金划转，与出入金/资金管理相关）：

- `usdClassTransfer` —— USDC 在现货/合约账户间划转（`toPerp` 决定方向）。
- `spotSend` —— 现货代币转账。

## 唯一新能力：EIP-712 `bool` 字段编码

`usdClassTransfer` 的类型表含 `{ name: "toPerp", type: "bool" }`。现有 `encodeField` 只支持 `string`/`address`/`uint64`，需新增 **`bool`** 分支：EIP-712 将 `bool` 编码为 uint256（32 字节左填充，`true`→1，`false`→0）。这是对通用哈希器的一次性扩展，后续其它含 bool 的 user-signed 动作可直接复用。

`spotSend.destination` 在类型表里是 `string`（非 `address`）——与既有 `withdraw3`/`usdSend` 的 `usdTransferFields` 一致（`destination` 按字符串 keccak，而非 20 字节地址 word），无新能力。

## 精确 EIP-712 类型表（byte-critical，来源：`@nktkas/hyperliquid` `UsdClassTransferTypes` / `SpotSendTypes`）

字段顺序即 EIP-712 encodeType/encodeData 顺序，须逐字节匹配 oracle。

1. `HyperliquidTransaction:UsdClassTransfer`：
   ```
   { hyperliquidChain, string }
   { amount,           string }
   { toPerp,           bool }
   { nonce,            uint64 }
   ```

2. `HyperliquidTransaction:SpotSend`：
   ```
   { hyperliquidChain, string }
   { destination,      string }
   { token,            string }
   { amount,           string }
   { time,             uint64 }
   ```

（域为 `HyperliquidSignTransaction`，`verifyingContract = address(0)`，`chainId` 来自 `signatureChainId` 的十六进制解析——与既有 user-signed 一致。）

## 架构

纯增量。复用既有 `UserSignedDigest` 通用哈希器（加一个 `bool` 字段编码分支）与 `Signer.signGuarded`。无新签名路径、无 mobile/server 运行时代码改动。

### 代码单元（`backend/internal/hl/usersigned.go`）

1. **`encodeField` 增加 `case "bool"`**：
   ```go
   case "bool":
       b, ok := val.(bool)
       if !ok { return nil, fmt.Errorf("field %q: expected bool, got %T", f.Name, val) }
       n := uint64(0)
       if b { n = 1 }
       return word(new(big.Int).SetUint64(n)), nil
   ```

2. **`usdClassTransferFields = []Field{{"hyperliquidChain","string"},{"amount","string"},{"toPerp","bool"},{"nonce","uint64"}}`** + **`UsdClassTransferInput{ SignatureChainID, HyperliquidChain, Amount string; ToPerp bool; Nonce uint64 }`** + **`UsdClassTransferDigest(in) ([32]byte, error)`**（解析 chainID → `UserSignedDigest("HyperliquidTransaction:UsdClassTransfer", usdClassTransferFields, chainID, {hyperliquidChain, amount, toPerp, nonce})`）。

3. **`spotSendFields = []Field{{"hyperliquidChain","string"},{"destination","string"},{"token","string"},{"amount","string"},{"time","uint64"}}`** + **`SpotSendInput{ SignatureChainID, HyperliquidChain, Destination, Token, Amount string; Time uint64 }`** + **`SpotSendDigest(in) ([32]byte, error)`**。

### Signer（`backend/internal/hl/signer.go`）

- `SignUsdClassTransfer(in UsdClassTransferInput) (Sig, error)` → `signGuarded(func() { return UsdClassTransferDigest(in) })`。
- `SignSpotSend(in SpotSendInput) (Sig, error)` → 同理。

### Golden 向量（oracle = `@nktkas/hyperliquid/signing`，扩展现有 user-signed `moreCases` 桶）

在 `mobile/scripts/gen-golden-vectors.mjs`：

- import 增加 `UsdClassTransferTypes, SpotSendTypes`（来自 `@nktkas/hyperliquid/api/exchange`）。
- `moreCases` 增加：
  - `usdClassTransfer-toPerp-mainnet`：`{ amount: "100", toPerp: true, nonce: NONCE }`（signatureChainId `0xa4b1`, Mainnet）。
  - `usdClassTransfer-toSpot-testnet`：`{ amount: "50.5", toPerp: false, nonce: NONCE }`（`0x66eee`, Testnet）——覆盖 bool=false。
  - `spotSend-mainnet`：`{ destination: "0x000000000000000000000000000000000000dEaD", token: "USDC:0xeb62eee3685fc4c43992febcd9e75443", amount: "1", time: NONCE }`（`0xa4b1`, Mainnet）。
- 现有 message 构建循环 `message[k] = (k==="time"||k==="nonce") ? BigInt(v) : v` 天然处理：`nonce`/`time` → BigInt，`toPerp`(bool)/`token`/`destination`/`amount` 原样。
- 重跑 `node scripts/gen-golden-vectors.mjs`（在 `mobile/`）刷新 `backend/internal/hl/testdata/golden_usersigned_more.json`。

Go 侧 `backend/internal/hl/golden_usersigned_more_test.go`：

- `moreVector` 结构增加 `ToPerp bool \`json:"toPerp"\`` 与 `Token string \`json:"token"\``。
- `moreDigest` switch 增加 `usdClassTransfer` / `spotSend` case（用上述 Input 构造并调 `*Digest`）。
- `moreSign` switch 增加 `usdClassTransfer` / `spotSend` case（调 `SignUsdClassTransfer` / `SignSpotSend`）。
- 既有 `TestMoreDigestGolden` 与 `TestMoreSignGolden` 循环自动逐字节校验 digest + 签名 `{r,s,v}`。

## 测试

- `cd backend && go test ./...`：全部通过（新 golden 向量断言 byte-exact；既有向量保持绿）。
- `cd backend && go vet ./...`：干净。
- `usersigned_test.go`：新增两个 digest 单测（usdClassTransfer toPerp true/false 各一条断言 + spotSend 一条），并（可选）加一条 `encodeField("bool", true/false)` 直测确认 0/1 word。
- 无需其它 `Signer` 改动；无 mobile/server 运行时代码改动（仅生成脚本 + testdata）。

## 范围外（YAGNI）

`cDeposit` / `cWithdraw`（质押）、`tokenDelegate`、`convertToMultiSigUser`、`perpDexClassTransfer` 等——本片不做，通用哈希器（现含 bool）可后续低成本追加。

## 验证门槛

- `cd backend && go test ./...` 全绿。
- `cd backend && go vet ./...` 干净。
- 重新生成的 `golden_usersigned_more.json` 与 Go 实现逐字节一致（不一致=字段顺序/类型/bool 编码有误，fail-closed）。
