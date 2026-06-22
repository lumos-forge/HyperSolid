# HyperSolid Phase 3 — 交易核心加固 实施计划（continuous-agent-loop）

> **驱动方式：** 本计划由 `continuous-agent-loop`（sequential + quality gates）逐单元推进。
> 每轮只完整交付**一个**未打勾单元：TDD → 实现 → 质量门 → 自检 → 打勾 → 停。
> **可重入**：每轮先读本文件，选第一个未打勾单元，不假设从零开始。
> 子技能建议：superpowers:test-driven-development（资金敏感，建议配 worktree 隔离 + subagent-driven）。

**目标：** 把交易核心加固到 spec 的 Phase 3 前置硬规则——**精度校验 · asset-id 解析 · 状态码映射（三件套）+ cloid 幂等 + builder 字段**，并支持下单(市价IOC/限价/ALO/reduce-only)、TP/SL、撤改单。Phase 3 是「App 真能下单」的核心。全程 tsc 零错 + jest 全绿（基线 193）。

---

## 设计唯一事实源（严格对齐，禁止自由发挥）

- 权威 spec：`docs/superpowers/specs/2026-06-17-hypersolid-design.md`，重点：
  - **§4.2 价格/数量精度**：size 按资产 `szDecimals` 取整；price 同时满足「≤5 有效数字（整数价例外）」且「小数位 ≤ (perp 6 / spot 8 − szDecimals)」；签名前去尾零。
  - **§4.3 订单编码**：order `{a,b,p,s,r,t,c,builder?}`；`t`=limit{tif:Gtc/Ioc/Alo} 或 trigger{triggerPx,isMarket,tpsl}；grouping=na/normalTpsl/positionTpsl；reduce-only/TP-SL/市价IOC/cloid。
  - **§4.3 HL gotchas**：`cancelByCloid` 字段名是 `"asset"`（非 `"a"`）；**布尔标志缺省时省略而非置 false**（否则 hash 不匹配）。
  - **§4.4 拒绝码**：tickRejected / minTradeNtlRejected / perpMarginRejected / badAloPxRejected / badTriggerPxRejected / oracleRejected … → 归一化为可读中文。
  - **§6.2 幂等**：先生成并持久化 cloid 再签名，重试用同一 cloid，按 cloid 对账(open/filled/rejected)；不确定回执用 cloid 去重。
  - **§7 Builder Codes**：order 带 `builder:{b,f}`；主钱包签 `approveBuilderFee(maxFeeRate)`；上限 perps 0.1%/spot 1%。
- 既有代码（本阶段是**加固/扩展**，非重写）：
  - `src/lib/hyperliquid/order.ts`（roundSize / stripTrailingZeros / formatPrice / validateOrder / REJECTION_MESSAGES / rejectionMessage）
  - `src/lib/hyperliquid/buildOrder.ts`（OrderSide / TimeInForce Gtc/Ioc/Alo / buildOrder）
  - `src/lib/hyperliquid/assetId.ts`（buildAssetIndex / resolveAssetId）
  - `src/lib/hyperliquid/cloid.ts`（generateCloid / isValidCloid）
  - `src/services/exchange.ts`（ExchangeService.placeOrder / cancelOrder）
  - `src/screens/TradeScreen.tsx`（已对齐设计稿，待接加固层）
- HL 官方 API 文档：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api —— **编码细节以官方为准**；拿不准用 `.md` 后缀或 `?ask=` 查询，杜绝臆测字段名/顺序。
- 写任何 Expo/RN 代码前先读 `mobile/AGENTS.md` 与 https://docs.expo.dev/versions/v56.0.0/。

## 不可触碰 / 范围边界

- **绝不下真单**：所有测试注入式 mock；CI/测试默认 testnet；禁止对主网或真实资金下单、禁止需充值/真机签名的人工步骤。
- **不改 Phase 2 钱包/鉴权安全层**（`biometricGate` / `sessionController` / `authStore` / `deviceIntegrity` / `secureKeyStore`）；交易须在会话解锁后（`walletStore.wallet` 存在）才可签。
- 签名仍用 `LocalWalletService`(viem) + `@nktkas/hyperliquid` ExchangeClient；本阶段只加固编码/校验/状态码/cloid/builder，不重写签名机制。
- 基线：当前 193 单测通过、tsc 零错。任何一轮结束都不得让其下降。

---

## 每轮固定流程（严格按序）

1. 读本文件，选第一个未打勾单元；全打勾 → 跳到「完成判定」。
2. 标记该单元进行中。
3. **TDD**：先写/扩展 `*.test.ts`，断言精度边界、asset-id（perp/spot）、状态码中文、cloid 幂等、布尔省略、builder 字段；先看它失败。
4. **实现**：加固/扩展对应文件，严格对齐设计事实源；优先复用既有函数，DRY。
5. **质量门**（全过否则不许打勾）：
   - `cd mobile && npx tsc --noEmit` → 零错误
   - `cd mobile && npx jest` → 全绿，且 ≥ 193 + 本单元新增
   - grep 确认改动文件无 emoji、无硬编码十六进制色（UI 文件）
6. **自检**：对照 spec 对应小节逐项核对（编码字段、精度规则、拒绝码、cloid 对账、gotchas）。
7. plan 打勾 + 底部「Progress」追加一行：日期 + 单元 + 测试数 + 一句话结论。
8. **停止本轮**（一轮一个单元）。

---

## 单元清单（按顺序执行）

### - [x] 单元 1：精度校验加固（`order.ts`）

- [x] `roundSize`：size 按资产 `szDecimals` 取整（核对既有实现/补边界）。
- [x] `formatPrice`：price 同时满足「≤5 有效数字（整数价例外）」且「小数位 ≤ (perp 6 / spot 8 − szDecimals)」；签名前 `stripTrailingZeros`。
- [x] `validateOrder`：精度/最小名义/价带等前置校验，违规返回 `OrderRejection`。
- [x] 补全边界测试（5 有效数字临界、整数价、szDecimals 不同档、perp vs spot 小数上限、去尾零）。
**实现说明：** 主缺口是 spot 支持——`formatPrice` 原硬编码 perp 6 位小数；新增 `MarketKind = "perp"|"spot"` 参数 + `maxPriceDecimals()`（spot 用 8，clamp 至 0），默认 perp 保持向后兼容。validateOrder 既有逻辑（正性/最小名义$10/取整后为零）正确，未改。

### - [x] 单元 2：asset-id 解析（`assetId.ts`）

- [x] perp 索引解析 + **spot 偏移 10000**；`resolveAssetId` 覆盖 perp/spot。
- [x] 未知 coin 返回 `null`；大小写/symbol 归一。
- [x] 测试覆盖 perp、spot（+10000）、未知。

### - [ ] 单元 3：状态码映射（`order.ts`）

- [ ] 补全全套拒绝码常量（tickRejected/minTradeNtlRejected/perpMarginRejected/badAloPxRejected/badTriggerPxRejected/oracleRejected…）→ 中文。
- [ ] 新增纯函数：从 HL response `status`（含 resting/filled/error 形态）解析归一化为 `{ kind, message }`。
- [ ] 测试覆盖各拒绝码 → 中文、未知码兜底、成功态。

### - [ ] 单元 4：cloid 幂等 + 意图账本

- [ ] 注入式 `IntentLedger`（put/get/updateStatus，内存实现 + 可换持久化）。
- [ ] 流程：先生成并持久化 cloid（pending）再签名；重试用同一 cloid；按 cloid 对账(open/filled/rejected)。
- [ ] HTTP/WS 不确定回执用 cloid 去重，杜绝重复/孤儿单。
- [ ] 测试覆盖：重试复用同 cloid、对账状态迁移、去重。

### - [ ] 单元 5：订单构建扩展（`buildOrder.ts`）

- [ ] `reduce-only` `r`；市价(IOC)；TP/SL trigger{triggerPx,isMarket,tpsl} + sibling 配对 + grouping(na/normalTpsl/positionTpsl)。
- [ ] **布尔标志缺省时省略而非置 false**（hash 一致性）。
- [ ] 测试覆盖：limit Gtc/Ioc/Alo、市价 IOC、reduce-only、TP/SL 配对、布尔省略断言。

### - [ ] 单元 6：builder 字段 + approveBuilderFee

- [ ] order 带 `builder:{b,f}`（费率 ≤ 上限 perps 0.1%/spot 1%）。
- [ ] 新增 `approveBuilderFee(maxFeeRate)` action 构建（端上主钱包 user-signed payload）。
- [ ] 测试覆盖：builder 字段编码、费率上限校验、approveBuilderFee payload 结构。

### - [ ] 单元 7：撤改单 gotchas

- [ ] `cancelByCloid`（字段名 `"asset"`，非 `"a"`）+ `modify`。
- [ ] 与 cloid 账本对账（撤/改后更新状态）。
- [ ] 测试覆盖：cancelByCloid 字段名断言、modify、账本联动。

### - [ ] 单元 8：ExchangeService 编排加固

- [ ] `placeOrder` 串起：精度校验 → cloid 账本(pending) → buildOrder(+builder) → 签名提交 → 状态码归一化 → 账本对账。
- [ ] 可注入（client/ledger/index），**绝不触真网/真单**。
- [ ] 测试覆盖：成功路径、拒绝码归一化、重试同 cloid、注入 mock 不触网。

### - [ ] 单元 9：TradeScreen 接入加固层

- [ ] 消费校验/状态码/cloid；下单前要求会话已解锁（`walletStore.wallet` 存在，Phase 2）。
- [ ] 错误用归一化中文提示；精度/名义违规即时反馈。
- [ ] 测试：未解锁不可提交、拒绝码中文展示、成功提示。

### - [ ] 单元 10：全局收尾验证

- [ ] 全量 `tsc --noEmit` + `jest` 收口。
- [ ] 全仓 grep：改动源无 emoji、无硬编码十六进制色（UI 文件）。
- [ ] 对照 spec §4.2-4.4/§6.2/§7 逐项自检（编码字段、精度、拒绝码、cloid 对账、gotchas、builder）。

---

## 完成判定（Definition of Done）

- 单元 1–10 全部打勾；`tsc` 零错、`jest` 全绿（≥ 193 + 新增）；
- 三件套 + cloid 幂等 + builder 均落地并测试；撤改单 gotchas 正确；TradeScreen 走加固层且下单前要求已解锁。
- 满足后输出最终总结并停止。

## 护栏与恢复（防失控）

- 单元粒度：一轮 = 一个单元；过大就在其下用子复选框拆分再做。
- 同一根因连续失败 2 次 → **冻结**：在「偏差记录」写根因，缩到最小失败单元，附明确验收标准后重试。
- 不删既有通过测试来过门；不为通过而 mock 掉真实断言。
- 编码细节以 HL 官方文档为准；拿不准先 `?ask=` 查询再写。

---

## 偏差记录（Deviations）

> 记录任何对「不可触碰范围」的必要改动及理由，或冻结/缩范围决策。

- （暂无）

---

## Progress

> 每完成一个单元追加一行：`YYYY-MM-DD · 单元 N · 测试数 · 一句话结论`

- 2026-06-22 · 单元 0（计划创建）· — · 建立可重入计划与 10 单元拆分，下一轮从「单元 1：精度校验加固」开始。
- 2026-06-22 · 单元 1（精度校验加固）· +3（193→196）· formatPrice 新增 MarketKind(perp/spot) 支持 spot 8 位小数上限 + clamp，补边界测试；tsc 零错、jest 全绿、order.ts 无 emoji/硬编码色。下一轮从「单元 2：asset-id 解析」开始。
- 2026-06-22 · 单元 2（asset-id 解析）· +7（196→203）· 新增 buildSpotAssetIndex（spot 资产 id = 10000 + spotInfo.index，按官方文档用显式 index 字段而非数组下标）+ SPOT_ASSET_ID_OFFSET 常量；perp/spot 解析均 case-insensitive、未知 coin 返回 null；DRY 抽出 makeAssetIndex/normalizeCoin 复用。tsc 零错、jest 全绿、改动文件无 emoji/硬编码色。下一轮从「单元 3：状态码映射」开始。
