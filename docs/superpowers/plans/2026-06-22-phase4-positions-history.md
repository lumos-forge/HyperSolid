# HyperSolid Phase 4 — 持仓与历史 实施计划（continuous-agent-loop）

> **驱动方式：** 本计划由 `continuous-agent-loop`（sequential + quality gates）逐单元推进。
> 每轮只完整交付**一个**未打勾单元：TDD → 实现 → 质量门 → 自检 → 打勾 → 停。
> **可重入**：每轮先读本文件，选第一个未打勾单元，不假设从零开始。
> 子技能建议：superpowers:test-driven-development（实时/资金敏感单元 4/7 建议配 worktree + PR 评审）。

**目标：** 把「持仓 Positions」从 Phase 1 的 view-only 一次性快照，加固为**实时**：实时持仓盈亏(mark 价) · 资金费(oracle 价) · 成交/订单历史。**只读消费链路，不签名、不下单。** Phase 4 让用户「能实时看清自己的钱」。全程 tsc 零错 + jest 全绿（基线 283）。

---

## 设计唯一事实源（严格对齐，禁止自由发挥）

- 权威 spec：`docs/superpowers/specs/2026-06-17-hypersolid-design.md`，重点：
  - **§3.1 信息架构**：持仓 Tab = 实时盈亏(mark)/资金费(oracle)/成交·订单历史；**view-only 零私钥预览**；连接钱包后用本人地址。
  - **§4.5 价格语义**：**mark 价**算未实现盈亏/保证金/清算/TP-SL 触发（≈3s 更新，**禁用 last trade 算 PnL**）；**oracle 价**算 funding（每小时 1/8 的 8h 费率）。
  - **§4.6 WS feeds（用户级）**：`webData3`(旧名 webData2) / `clearinghouseState` / `openOrders` / `orderUpdates` / `userFills` / `userFundings` / `userEvents`(channel 名 `"user"`)；纪律：**60s 无消息必 ping**；重连 `isSnapshot:true` 是正常恢复**不可重复计**。
  - **§4.7 限频**；**§4.8 用户私有数据**：客户端直连本人地址订阅（每设备 1 用户，天然在限内）。
- 既有代码（本阶段是**加固/扩展**，非重写）：
  - `src/lib/hyperliquid/positions.ts`（normalizePortfolio）
  - `src/lib/hyperliquid/types.ts`（Position / AccountSummary / PortfolioSnapshot / RawClearinghouseState / RawPosition / PositionsInfoLike / Subscription / SubsLike / Mids）
  - `src/services/positionsData.ts`（PositionsService.loadPortfolio 一次性）
  - `src/hooks/useViewOnlyPortfolio.ts`（view-only 地址加载 + isValidAddress）
  - `src/screens/PositionsScreen.tsx`、`src/screens/AccountScreen.tsx`、`src/components/PositionRow.tsx`
  - `src/lib/hyperliquid/client.ts`（createPositionsInfoClient + 订阅客户端）、`src/lib/hyperliquid/format.ts`（formatCompact）、`src/lib/hyperliquid/normalize.ts`（applyMids 合并 markPx 的范式）
- HL 官方 API 文档：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api —— **编码字段以官方/本地 @nktkas SDK schema 为准**；拿不准用 `.md` 后缀或 `?ask=` 查询，杜绝臆测字段名/顺序。
- 写任何 Expo/RN 代码前先读 `mobile/AGENTS.md` 与 https://docs.expo.dev/versions/v56.0.0/。

## 不可触碰 / 范围边界

- **只读阶段**：Phase 4 不签名、不下单、不触发 exchange action；全部测试注入式 mock，**绝不触真网**。
- **不改 Phase 2 钱包/鉴权安全层**（`biometricGate` / `sessionController` / `authStore` / `deviceIntegrity` / `secureKeyStore`）。
- **不改 Phase 3 交易核心**（`order` / `buildOrder` / `exchange` / `cancel` / `intentLedger` / `builderFee`）——只读消费 cloid 账本，不改其写入路径。
- 价格语义铁律：**mark 价**算 PnL/保证金/清算（禁用 last trade）；**oracle 价**算 funding。
- 用户私有数据按 §4.8 客户端直连本人地址；不擅自引入后端扇出。
- 基线：当前 283 单测通过、tsc 零错。任何一轮结束都不得让其下降。

---

## 每轮固定流程（严格按序）

1. 读本文件，选第一个未打勾单元；全打勾 → 跳到「完成判定」。
2. 标记该单元进行中。
3. **TDD**：先写/扩展 `*.test.ts`，断言归一化字段、tid/oid 去重、mark 价 PnL、funding 聚合、isSnapshot 不重复计、view-only 预览；先看它失败。
4. **实现**：加固/扩展对应文件，严格对齐设计事实源；优先复用既有函数（applyMids / normalizePortfolio / formatCompact），DRY。
5. **质量门**（全过否则不许打勾）：
   - `cd mobile && npx tsc --noEmit` → 零错误
   - `cd mobile && npx jest` → 全绿，且 ≥ 283 + 本单元新增
   - grep 确认改动文件无 emoji、无硬编码十六进制色（UI 文件全走 theme）
6. **自检**：对照 spec 对应小节逐项核对（价格语义 mark/oracle、WS 纪律、user feed 字段、去重）。
7. plan 打勾 + 底部「Progress」追加一行：日期 + 单元 + 测试数 + 一句话结论。
8. **停止本轮**（一轮一个单元）。

---

## 单元清单（按顺序执行）

### - [x] 单元 1：用户级原始类型 + 归一化器（`types.ts` + 新归一化模块）

- [x] 新增 Raw 类型：RawUserFill / RawFunding / RawOpenOrder（字段对照 @nktkas SDK schema）。
- [x] 归一化纯函数：→ `Fill[]` / `FundingEvent[]` / `OpenOrder[]`；fill 按 `tid` 去重、order 按 `oid` 去重。
- [x] 测试覆盖：字段映射、去重、空输入、方向(B/A)与符号。

### - [x] 单元 2：mark 价 PnL 语义（`positions.ts`，§4.5）

- [x] 用 `markPx`（allMids）重算 `unrealizedPnl` / 保证金率 / 距清算%；**禁用 last-trade**。
- [x] 纯函数 + 注入 mids；边界：空仓 / 多头 / 空头 / 零价 / 缺 mark。
- [x] 测试覆盖：long/short PnL 正负、保证金率、距清算、缺价回退既有值。

### - [x] 单元 3：资金费（oracle 价）

- [x] 归一化 `userFundings`；按 coin 聚合累计已付/应计；**不混用 mark 价**。
- [x] 纯函数；时间窗聚合（如近 24h / 累计）。
- [x] 测试覆盖：聚合求和、正负费、按 coin 分组、空输入。

### - [x] 单元 4：实时持仓服务加固（`positionsData.ts`）

- [x] 注入式 WS 订阅（clearinghouseState/webData3）+ allMids `markPx` 合并；保留 one-shot，新增 live。
- [x] **重连 `isSnapshot:true` 正常恢复不重复计**；60s 无消息 ping 纪律（可注入计时器）。
- [x] 订阅句柄可注入可测，**绝不触真网**。
- [x] 测试覆盖：live 推送更新、snapshot 不重复累计、unsubscribe、mark 合并。

### - [ ] 单元 5：成交历史服务（`userFills`）

- [ ] `userFills` 归一化 + 分页/去重(tid) + `builderFee` 字段；注入式。
- [ ] 测试覆盖：分页拼接、tid 去重、builderFee 解析、按时间排序。

### - [ ] 单元 6：挂单 + 订单历史（`openOrders` / `orderUpdates`）

- [ ] 归一化 openOrders / orderUpdates；**只读消费** Phase 3 cloid 账本对账（不改账本写入路径）。
- [ ] 测试覆盖：归一化字段、状态映射复用 normalizeOrderStatus、与 cloid 关联（只读）。

### - [ ] 单元 7：PositionsScreen 接入实时层

- [ ] 实时 PnL(mark) / 资金费 / 成交·订单 tab；保留 view-only 零私钥预览。
- [ ] 连接钱包后默认本人地址（只读，不需签名）；错误归一化中文。
- [ ] 测试：view-only 预览仍可用、实时数据渲染、tab 切换、本人地址自动填充。

### - [ ] 单元 8：AccountScreen 账户摘要 + 资金费历史

- [ ] 账户摘要（accountValue / withdrawable / 保证金率）+ 资金费历史入口；归一化中文。
- [ ] 测试：摘要渲染、保证金率显示、资金费入口、view-only/local 分支。

### - [ ] 单元 9：全局收尾验证

- [ ] 全量 `tsc --noEmit` + `jest` 收口。
- [ ] 全仓 grep：改动源无 emoji、无硬编码十六进制色（UI 文件）。
- [ ] 对照 spec §3.1 / §4.5 / §4.6 / §4.7 逐项自检（价格语义、WS 纪律、user feed 字段、去重、view-only）。

---

## 完成判定（Definition of Done）

- 单元 1–9 全部打勾；`tsc` 零错、`jest` 全绿（≥ 283 + 新增）；
- 实时持仓(mark PnL) + 资金费(oracle) + 成交/订单历史均落地并测试；view-only 零私钥预览保留；PositionsScreen/AccountScreen 走实时层。
- 满足后输出最终总结并停止。

## 护栏与恢复（防失控）

- 单元粒度：一轮 = 一个单元；过大就在其下用子复选框拆分再做。
- 同一根因连续失败 2 次 → **冻结**：在「偏差记录」写根因，缩到最小失败单元，附明确验收标准后重试。
- 不删既有通过测试来过门；不为通过而 mock 掉真实断言。
- 编码字段以 HL 官方文档/本地 @nktkas SDK schema 为准；拿不准先 `?ask=` 查询再写。

---

## 偏差记录（Deviations）

> 记录任何对「不可触碰范围」的必要改动及理由，或冻结/缩范围决策。

- （暂无）

---

## Progress

> 每完成一个单元追加一行：`YYYY-MM-DD · 单元 N · 测试数 · 一句话结论`

- 2026-06-22 · 单元 0（计划创建）· — · 建立可重入计划与 9 单元拆分（只读消费链路），下一轮从「单元 1：用户级原始类型 + 归一化器」开始。
- 2026-06-22 · 单元 1（用户级原始类型 + 归一化器）· +8（283→291）· types.ts 新增 RawUserFill/RawFunding/RawOpenOrder + 归一化 Fill/FundingEvent/OpenOrder（字段对照本地 @nktkas commonSchemas：UserFillSchema/UserFundingResponse/OpenOrderSchema）；新增 history.ts（normalizeFills 按 tid 去重+newest first+side B/A→buy/sell+builderFee 缺省 0；normalizeFundings 展开 delta+signed usdc；normalizeOpenOrders 按 oid 去重+cloid null/reduceOnly false 缺省）。tsc 零错、jest 全绿、改动文件无 emoji/硬编码色。RawOrderUpdate/orderUpdates 归入单元 6。下一轮从「单元 2：mark 价 PnL 语义」开始。
- 2026-06-22 · 单元 2（mark 价 PnL 语义）· +10（291→301）· 新增 markPnl.ts 纯函数：unrealizedPnlFromMark（long (mark-entry)*size / short (entry-mark)*size，**用 mark 非 last-trade**）、distanceToLiqPct、roePct（DRY 替代 PositionRow 内联 ROE）、marginRatioPct（账户级）、applyMarks（按 marks 重算每仓 uPnl+positionValue 与账户 totalUnrealizedPnl/totalNtlPos，缺/非法 mark 回退快照值，接受 string|number marks）。tsc 零错、jest 全绿、改动文件无 emoji/硬编码色。下一轮从「单元 3：资金费（oracle 价）」开始。
- 2026-06-22 · 单元 3（资金费 oracle 价）· +6（301→307）· 新增 funding.ts 纯函数：aggregateFundingByCoin（按 coin 聚合 net/paid/received/count，按 |net| 降序）、totalFunding（净额）、fundingSince（时间窗净额）；usdc 为 oracle 结算签名值，**不混用 mark 价**。tsc 零错、jest 全绿、改动文件无 emoji/硬编码色。下一轮从「单元 4：实时持仓服务加固」开始。
- 2026-06-22 · 单元 4（实时持仓服务加固）· +5（307→312）· types.ts 加 PositionsSubsLike/ClearinghouseStateEvent；positionsData.ts 新增 subscribeLive（注入式订阅 clearinghouseState + allMids，经 applyMarks mark 合并；保留 one-shot loadPortfolio）。clearinghouseState 为 replace-state，**重连快照重放不重复计**（已测）；订阅句柄可注入、全 fake 测试、绝不触真网；60s ping/keepalive 由 @nktkas WebSocketTransport 负责（非本服务）。tsc 零错、jest 全绿、改动文件无 emoji/硬编码色。下一轮从「单元 5：成交历史服务」开始。
