# Go 签名核第五片：L1 批量/保证金/定时动作（batchModify / updateIsolatedMargin / scheduleCancel）

日期：2026-07-06
状态：已批准，待实现

## 背景

Go 签名核（`backend/internal/hl`）当前覆盖的 L1 动作：`order` / `cancel` / `cancelByCloid` / `modify` / `updateLeverage` / `twapOrder` / `twapCancel`；user-signed：`approveAgent` / `withdraw3` / `usdSend` / `approveBuilderFee`。

本片前瞻性补全三个 L1 动作（App 目前未调用，但属交易/风控完整面，通用管线可低成本追加）：

- `batchModify` —— 批量改单（多笔 modify 原子提交）。
- `updateIsolatedMargin` —— 逐仓保证金增减。
- `scheduleCancel` —— 死人开关（dead man's switch）：设定/清除全撤定时。

三者均为 L1 动作，走 `Agent` 域 EIP-712 摘要，**完全复用**现有 `L1ActionHash` + `AgentDigest` + `Signer.SignL1Action`，无新增签名路径。

## 精确 wire 形状（byte-critical，来源：`@nktkas/hyperliquid` 方法源码）

字段顺序即 msgpack 编码顺序，必须逐字节匹配 oracle。

1. `batchModify`：
   ```
   { type: "batchModify", modifies: [ { oid: <uint | cloid-string>, order: {a,b,p,s,r,t,(c?)} } ] }
   ```
   顶层顺序 `type, modifies`；每个 modify 项顺序 `oid, order`，与单个 `modify` 的内层完全一致。

2. `updateIsolatedMargin`：
   ```
   { type: "updateIsolatedMargin", asset: <uint>, isBuy: <bool>, ntli: <signed int> }
   ```
   顶层顺序 `type, asset, isBuy, ntli`。**注意 `ntli` 是有符号 Integer**（正=加保证金，负=减保证金），须用 int64（`encInt` 已支持负数）。

3. `scheduleCancel`：
   ```
   带 time：{ type: "scheduleCancel", time: <uint> }
   不带 time：{ type: "scheduleCancel" }
   ```
   `time` 为**可选** UnsignedInteger。清除死人开关时**整字段省略**（不能填 0）。顶层顺序 `type[, time]`。

## 架构

纯增量。无新增签名路径、无新增摘要域、无 mobile/server 运行时代码改动。所有新动作构造成有序 `Map` 后交由既有 `Signer.SignL1Action(action, nonce, isTestnet)`。

### 代码单元（`backend/internal/hl/action.go`）

1. **`modifyEntry(in ModifyInput) Map`（新辅助）**：抽出当前内联在 `BuildModifyAction` 里的 `{oid, order}` 构造（oid=cloid 字符串当 `Cloid != ""` 否则 int64 `Oid`；order=`orderTuple(in.Order)`），供 `modify` 与 `batchModify` 复用。`BuildModifyAction` 改为 `{type:"modify"}` 后接 `modifyEntry` 的两个字段。

2. **`BuildBatchModifyAction(mods []ModifyInput) Map`**：
   `{ {"type","batchModify"}, {"modifies", [ Map(modifyEntry) … ]} }`。

3. **`BuildUpdateIsolatedMarginAction(asset int64, isBuy bool, ntli int64) Map`**：
   `{ {"type","updateIsolatedMargin"}, {"asset",asset}, {"isBuy",isBuy}, {"ntli",ntli} }`。

4. **`BuildScheduleCancelAction(time *int64) Map`**：
   - `time == nil` → `{ {"type","scheduleCancel"} }`（清除）。
   - `time != nil` → `{ {"type","scheduleCancel"}, {"time", *time} }`（设定）。

### Golden 向量（oracle = `@nktkas/hyperliquid/signing`）

在 `mobile/scripts/gen-golden-vectors.mjs`：

- `buildAction(kind, p)` 增加三个分支，构造与上文 wire 形状一致的原始 action 对象：
  - `batchModify`：`modifies` 数组，每项 `{ oid: p.oidCloid ?? p.oidNum, order }`（order 与既有 modify 分支相同，含可选 `c`）。
  - `updateIsolatedMargin`：`{ type, asset, isBuy, ntli }`。
  - `scheduleCancel`：`const a = { type: "scheduleCancel" }; if (p.time !== undefined) a.time = p.time; return a;`。
- `cases` 数组增加向量：
  - `batchModify-mainnet`：两项 —— 项1 数字 oid（无 c），项2 cloid-oid + order 级 c。
  - `updateIsolatedMargin-add-mainnet`：`asset 0, isBuy true, ntli 1000000`（加）。
  - `updateIsolatedMargin-remove-testnet`：`asset 1, isBuy false, ntli -500000`（减，负整数交叉验证）。
  - `scheduleCancel-set-mainnet`：`{ time: 1700000000000 }`。
  - `scheduleCancel-clear-testnet`：`{}`（无 time）。
- 重跑 `node scripts/gen-golden-vectors.mjs`（在 `mobile/`）刷新 `backend/internal/hl/testdata/golden.json`。

Go 侧 `backend/internal/hl/golden_test.go` 的 `actionForVector` switch 增加三个 `case`：
- `batchModify`：解 `{ modifies: [{ oidNum, oidCloid, order:{...} }] }` → `[]ModifyInput` → `BuildBatchModifyAction`。
- `updateIsolatedMargin`：解 `{ asset, isBuy, ntli }` → `BuildUpdateIsolatedMarginAction`。
- `scheduleCancel`：解 `{ time *int64 }` → `BuildScheduleCancelAction(p.Time)`（JSON 缺字段 → nil → 清除形态）。

既有断言（`actionHash` / `agentDigest` / `sig` 逐字节相等）自动覆盖新向量。

## 测试

- `cd backend && go test ./...`：全部通过（新 golden 向量断言 byte-exact；所有既有向量保持绿）。
- `cd backend && go vet ./...`：干净。
- `modifyEntry` 重构后 `modify` 既有单测与 golden 保持不变（行为等价）。
- 无需改动 `Signer`；无 mobile/server 运行时代码改动（仅生成脚本 + testdata）。

## 范围外（YAGNI）

`spotSend`、`usdClassTransfer`、`cDeposit`/`cWithdraw`、`tokenDelegate`、`convertToMultiSigUser` 等——本片不做，留待后续按需扩展。

## 验证门槛

- `cd backend && go test ./...` 全绿。
- `cd backend && go vet ./...` 干净。
- 重新生成的 `golden.json` 与 Go 实现逐字节一致（不一致=字段顺序/类型有误，fail-closed）。
