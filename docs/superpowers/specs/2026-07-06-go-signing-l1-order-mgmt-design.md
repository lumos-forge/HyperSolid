# Go 签名核第四片：L1 订单管理动作（cancelByCloid / modify / updateLeverage）

日期：2026-07-06
状态：已批准，待实现

## 背景

Go 签名核（`backend/internal/hl`）已覆盖：

- L1 动作：`order` / `cancel` / `twapOrder` / `twapCancel`（`action.go` 构造器 + `SignL1Action`）。
- User-signed 动作：`approveAgent` / `withdraw3` / `usdSend` / `approveBuilderFee`（`usersigned.go`）。

对照 App（`mobile/`）实际调用的 HyperLiquid ExchangeClient 方法，**user-signed 动作已全部覆盖**；真正的缺口是 App 已在用、但 Go 尚未覆盖的三个 **L1 动作**：

- `cancelByCloid` —— gridLimit resting 网格按 cloid 撤单（App 中调用 2 处）。
- `updateLeverage` —— 交易页调整杠杆。
- `modify` —— 改单。

三者均为 L1 动作，走 `Agent` 域 EIP-712 摘要，可**完全复用**现有 `L1ActionHash` + `AgentDigest` + `Signer.SignL1Action` 管线，无需新增签名路径。

## 精确 wire 形状（byte-critical，来源：`@nktkas/hyperliquid` 方法源码）

字段顺序即 msgpack 编码顺序，必须逐字节匹配 oracle。

1. `cancelByCloid`：
   ```
   { type: "cancelByCloid", cancels: [ { asset: <uint>, cloid: "0x…(34 chars)" } ] }
   ```
   顶层顺序 `type, cancels`；每个 cancel 内顺序 `asset, cloid`（注意是全名 `asset`/`cloid`，非 `a`/`o`）。

2. `modify`：
   ```
   { type: "modify", oid: <uint | cloid-string>, order: { a,b,p,s,r,t,(c?) } }
   ```
   顶层顺序 `type, oid, order`；`order` 与单笔下单元组完全一致（`a,b,p,s,r,t`，可选 `c`）。
   `oid` 为 union：数字 oid 或 34 字符 cloid 字符串——两者都需支持（数字→msgpack uint，cloid→msgpack string）。

3. `updateLeverage`：
   ```
   { type: "updateLeverage", asset: <uint>, isCross: <bool>, leverage: <uint> }
   ```
   顶层顺序 `type, asset, isCross, leverage`；`leverage` 为整数（msgpack uint，非 decimal 字符串）。

## 架构

纯增量。无新增签名路径、无新增摘要域。所有新动作构造成有序 `Map` 后交由既有 `Signer.SignL1Action(action, nonce, isTestnet)` 处理。

### 代码单元（`backend/internal/hl/action.go`）

1. **`orderTuple(o OrderInput) Map`（新辅助函数）**：抽出当前内联在 `BuildOrderAction` 里的单笔订单元组构造逻辑（`{a,b,p,s,r,t,(c)}`），供下单与改单复用，消除重复。`BuildOrderAction` 改为调用 `orderTuple`。

2. **`CancelByCloidInput{ Asset int64; Cloid string }`** + **`BuildCancelByCloidAction(cancels []CancelByCloidInput) Map`**：
   `{ {"type","cancelByCloid"}, {"cancels", [ {"asset",Asset}, {"cloid",Cloid} ] } }`。

3. **`ModifyInput{ Oid int64; Cloid string; Order OrderInput }`** + **`BuildModifyAction(in ModifyInput) Map`**：
   - `oid` 值：当 `in.Cloid != ""` 时用 `in.Cloid`（字符串），否则用 `in.Oid`（int64）。
   - `{ {"type","modify"}, {"oid", oidVal}, {"order", orderTuple(in.Order)} }`。

4. **`BuildUpdateLeverageAction(asset int64, isCross bool, leverage int64) Map`**：
   `{ {"type","updateLeverage"}, {"asset",asset}, {"isCross",isCross}, {"leverage",leverage} }`。

### Golden 向量（oracle = `@nktkas/hyperliquid/signing`）

在 `mobile/scripts/gen-golden-vectors.mjs`：

- `buildAction(kind, p)` 增加三个分支，构造与上文 wire 形状一致的原始 action 对象。
- `cases` 数组增加向量：
  - `cancelByCloid-mainnet`（asset 0, cloid `0x…0001`）。
  - `modify-oid-mainnet`（数字 oid 123, order = limit Gtc）。
  - `modify-cloid-testnet`（cloid-oid `0x…0002`, order = limit Ioc reduceOnly）。
  - `updateLeverage-cross-mainnet`（asset 0, isCross true, leverage 5）。
  - `updateLeverage-isolated-testnet`（asset 1, isCross false, leverage 3）。
- 重跑 `node scripts/gen-golden-vectors.mjs`（在 `mobile/`）刷新 `backend/internal/hl/testdata/golden.json`。

Go 侧 `backend/internal/hl/golden_test.go` 的 `actionForVector` switch 增加 `cancelByCloid` / `modify` / `updateLeverage` 三个 `case`，从 `params` 反序列化并调用对应 `Build*Action`。既有断言（`actionHash` / `agentDigest` / `sig` 逐字节相等）自动覆盖新向量。

## 测试

- `cd backend && go test ./...`：全部通过（新 golden 向量断言 byte-exact 一致；所有既有向量保持绿）。
- `msgpack_test.go`：如有必要，为 `updateLeverage`（bool + 多整数）与 cloid-oid 元组补 1 条编码单测，确认字段顺序与类型。
- 无需改动 `Signer`（`SignL1Action` 已通用）；无 mobile/server 代码改动（仅生成脚本 + testdata）。

## 范围外（YAGNI）

`batchModify`、`updateIsolatedMargin`、`scheduleCancel`、`spotSend`、`usdClassTransfer` 等本片不做——App 当前未使用或非关键路径，留待后续按需扩展（现有通用管线可低成本追加）。

## 验证门槛

- `cd backend && go test ./...` 全绿。
- `cd backend && go vet ./...` 干净。
- 重新生成的 `golden.json` 与 Go 实现逐字节一致（若不一致，说明字段顺序/类型有误，fail-closed）。
