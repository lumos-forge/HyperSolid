# HyperSolid 设计方案 v2.1（修订版 · 单一事实来源）

日期：2026-06-17
版本：v2.1
状态：现行（整合全部已确认决策 + Hyperliquid 官方文档缺口分析 + 评审修订）
取代：session `plan.md` 中的散稿与早期 ADR；细节缺口见 `docs/HYPERLIQUID-GAP-ANALYSIS.md`；文档索引见根 `README.md`

变更记录：
- v2.0：整合架构/钱包/agentic/主题决策 + 官方文档缺口分析（新增 Builder Codes、入金 onboarding、HL 集成硬规则；修正 agent 生命周期）。
- v2.1：rubber-duck 评审 10 项修订（§17，含合规硬闸门 ADR-006、签名器=策略引擎 ADR-007）；修复 Phase 1 计划 markPx/midPx 语义。
- v2.1（2026-06-17）：**移除 WalletConnect/外部钱包**，钱包接入仅 Privy 嵌入式 + view-only（ADR-008）。
- v2.1（2026-06-17）：**新增 Passkey 本地钱包作为主推方案**（ADR-011），Privy 降为便利性备选；Turnkey 单家评估完成不采纳（ADR-009）；成本优化策略（ADR-010）。
- v2.1（2026-06-21）：**后端语言定为 Go**（ADR-013，取代原 Node/TS BFF 规划）；后端模块化落地视图见 `docs/BACKEND-ARCHITECTURE.md`。客户端与整体架构不变。
- v2.1（2026-06-21）：**近期经 TestFlight 评估**（非 App Store 公开发布）；ADR-006 合规硬闸门暂缓至公开上架前（ADR-014）。

---

## 1. 愿景与目标

在手机上直接、流畅、安全地用 Hyperliquid 交易永续合约，并提供"离线也能跑策略"的 agentic 钱包。

- **定位**：面向公众、应用商店上架的**非托管** Hyperliquid 交易客户端。
- **非功能优先级（用户明确）**：丝滑（60fps）、稳定（少崩溃可恢复）、高可用（核心交易不依赖单点）。
- **安全红线**：用户主资金的**明文**私钥/签名永不离开设备；后端绝不托管主钱包私钥；提现只能主钱包签。（云端备份若引入，**仅允许零知识**：只上传用户口令客户端加密后的密文，明文私钥与口令绝不上服务器——见 ADR-012。）
- **收入模型**：Hyperliquid Builder Codes（链上、可追溯的交易返佣）。

非目标（MVP，YAGNI）：自建撮合/做市（撮合由 Hyperliquid 负责，我们只做客户端）、复杂社交跟单、自建法币入金（改为外链第三方，如 Swapped.com）。

---

## 2. 范围与子项目分解

每个子项目独立成 spec→plan→实现闭环，各自可交付可测。

| Phase | 子项目 | 可交付物 | 私钥? |
|---|---|---|---|
| 0 | 脚手架 | Expo+TS 工程、导航、lint/CI、环境配置、Sentry、geo-block 框架、ToS/风险揭示 | 无 |
| 1 | 只读行情（**首个切片**） | 市场列表(live)、详情(盘口+成交+K线)、view-only 持仓 | 无 |
| 2 | 钱包与鉴权 | Passkey 本地钱包 onboarding（主推）/ Privy 嵌入式（备选）；approveAgent；**approveBuilderFee**；入金引导页 | 端上 |
| 3 | 交易核心 | 下单(市价/限价/ALO/IOC/reduce-only)、TP/SL、撤改单、杠杆/保证金；**前置：精度校验/asset-id 解析/状态码映射/cloid/builder 字段** | 端上签名 |
| 4 | 持仓与历史 | 实时持仓盈亏(mark 价)、资金费(oracle 价)、成交/订单历史 | 端上 |
| 5 | Agentic 执行引擎（L1 规则） | TP/SL、移动止损、DCA、网格、条件/定时单；护栏 + kill-switch + scheduleCancel；服务端签名器 | 服务端 agent(trade-only) |
| 6 | 后端 HA 化 + 上架 | WS 扇出、推送预警、可观测性、多区部署；合规审查、地区提交 | — |

**首个实施计划聚焦 Phase 1**（见 `docs/superpowers/plans/2026-06-17-hypersolid-markets-list.md`，需按本 v2 补充 SDK 适配层预留）。

**⚠️ 合规硬门（评审修订）**：Phase 2+（钱包/下单/agentic）面向公众上架前，**必须先通过合规闸门**（见 §9，Apple §3.1.5(iv) 视永续为 futures 是存在性风险）。在法律意见确认"出品主体/牌照/地区"路径前，公开发布只推进到 **Phase 1 只读** 或 **现货/自选优先**；perps 交易与 agentic 执行的公开发布需在闸门通过后。Phase 1/2 开发可与法律评估并行，但**发布**受闸门约束。

---

## 3. 系统架构

```
┌───────────────────────────── 移动客户端 (RN+Expo+TS) ─────────────────────────────┐
│ UI(主题 A/B/C) · 状态(Zustand+TanStack Query) · 服务层 · HL SDK 适配 · 安全层      │
│ 钱包: Passkey 本地(主推)/Privy 嵌入式(备选)/view-only   签名: viem (端上, 主资金)  │
└───────────────┬───────────────────────────────────────────────┬──────────────────┘
                │ 关键路径(可直连): 本地签名 → HL /exchange        │ 加速路径(可降级)
                ▼                                                 ▼
        Hyperliquid HyperCore                          HyperSolid 后端 (渐进式 BFF, HA)
        REST /info /exchange · WS /ws                  · HL connector 池(常驻 WS) → NATS/Redis 扇出
                ▲                                       · 快照缓存(Redis) · 推送(APNs/FCM)
                │ 服务端 agent 签名(trade-only)          · Agentic 执行引擎 + 风控护栏 + 签名器(Turnkey/TEE)
                └───────────────────────────────────────· 存储(Postgres, 绝不存私钥) · OTel
```

**高可用核心原则**：手动交易始终可"设备本地签名直连 HL"，后端只做数据加速/推送/agentic 执行，**不在手动下单关键路径上**；后端降级时 App 自动回退直连 HL。

### 3.1 信息架构（板块 / 底部导航）

App 顶层 = **5 个底部 Tab** + 2 个跨切面流程。每个板块映射到对应 Phase，避免"按 Phase 列功能但无整体结构"的缺口。各板块的完整商用功能清单见 [产品功能方案](../../PRODUCT-FEATURE-SPEC.md)。

| # | 板块（Tab） | 职责 | 关键屏/功能 | Phase | 私钥 |
|---|---|---|---|---|---|
| 1 | 🏠 **行情 Markets** | 浏览/搜索市场 + 看盘 | 永续列表(按量/涨跌/资金费排序)、搜索、Market Detail(K线+盘口 l2Book+成交 trades) | 1 | 无 |
| 2 | ⚡ **交易 Trade** | 下单与改仓 | 下单(市价/限价/ALO/IOC/reduce-only)、杠杆/保证金、TP/SL、撤改单 | 3 | 端上签名 |
| 3 | 💼 **持仓 Positions** | 资产与盈亏 | 实时持仓盈亏(mark 价)、资金费(oracle 价)、成交/订单历史；**view-only 模式可零私钥预览** | 1(只读)/4 | 端上 |
| 4 | 🤖 **策略 Agent** | 离线自动化(差异化卖点) | L1 规则(TP/SL/移动止损/DCA/网格/条件·定时单)、护栏、kill-switch、scheduleCancel、策略健康/授权健康 | 5 | 服务端 agent(trade-only) |
| 5 | 👤 **钱包/我的 Account** | 资金与设置 | onboarding(三选一)、入金引导、提现/转账、安全(生物识别/私钥导出/助记词备份)、主题 A/B/C、主网/测试网开关、ToS/风险揭示 | 2 | 端上 |

**跨切面流程（非 Tab）**：① **Onboarding 流**（首启动：Passkey 本地 / Privy / view-only 三选一 + approveAgent + approveBuilderFee + 入金引导）；② **全局态**（kill-switch、网络切换、合规 geo-block 拦截、Phase Pulse agent 心跳指示器贯穿各屏顶部）。

**设计取舍（已决策 2026-06-19）**：Trade **独立成 Tab**（用户决策），不并入 Market Detail 抽屉；Market Detail 仍可提供"快捷下单"入口跳转/预填到 Trade 板块，但交易主入口是独立 Tab。MVP 上架受合规闸门约束（§9/ADR-006）：闸门通过前**公开版**仅 Markets + view-only Positions，Trade/Agent 灰度或仅测试网。**近期评估走 TestFlight（非公开发布，ADR-014）**：TestFlight Beta 不触发公开上架合规闸门，可在受限范围放开 Trade/Agent 做评估；公开上架前仍须回到 ADR-006 流程。

---

## 4. Hyperliquid 集成规范（纳入官方文档缺口分析）

> 这是 v1 与 v2 最大的差异：把官方文档里"不做就拒单/算错/零收入"的硬规则固化为工程约束。完整出处见 `docs/HYPERLIQUID-GAP-ANALYSIS.md`。

### 4.1 后端可选性与核心路径降级
- **手动交易降级直连 HL**：设备始终能"本地签名 + 直发 Hyperliquid /exchange"；后端只做数据加速/推送/派生计算，不在下单关键路径上。后端降级时，App 自动回退直连 HL REST/WS → 核心交易持续可用。
- **中国大陆智能路由（含 IP 限频应对）**：**详细分析见 `docs/CHINA-ACCESS-ANALYSIS.md`**（完整 API 端点清单、GFW 屏蔽机制、各流量类型成功率、监控策略、法律合规性）。客户端启动时检测网络环境（IP geo API + 直连 HL 可达性测试 3 秒超时）→ 中国大陆用户自动路由至后端代理（香港/新加坡 Cloudflare Workers/AWS Lambda/Vercel Edge，成本 ~$0-20/月）→ 其他地区直连 HL。**IP 池策略**：部署 20 个代理实例（不同 Worker 获得不同出口 IP）避免触发 Hyperliquid 1200 weight/min 限频；用户按一致性哈希分配到特定代理；**流量分离策略（核心优化）**：① 只读查询(`/info`、公共 WS allMids/l2Book 等)→强制走代理（高频易封锁，直连成功率仅 20-40%）；② 签名交易(`/exchange` 下单/撤单/改单)→**优先直连**（HTTPS 加密 + 低频短连接，中国大陆直连成功率 70-90%），失败自动降级代理；③ 私有 WebSocket(userEvents/userFills 等)→**优先直连**（个人数据 + 单用户单连接，成功率 60-80%），失败降级代理；④ 公共 WebSocket → 走代理（长连接公共数据易被识别）。**直连成功率**受地区(一线城市更严)、运营商(移动<联通<电信)、时期(敏感期降至 30-50%)影响；**降级机制**：客户端检测 429 限频响应自动切换代理或回退直连；直连超时 3 秒自动降级代理。手动模式切换（自动智能路由/全部直连/全部代理）在设置中提供。

### 4.2 资产标识（启动时解析，禁硬编码）
- perp `asset` = `meta.universe` 索引；spot `asset` = 10000+index，coin 串用 `"@index"`；HIP-3 = 100000+dexIdx*10000+idx，名 `"{dex}:{COIN}"`。
- mainnet/testnet ID 不同；UI 名可能重映射（`BTC/USDC`↔`UBTC/USDC`）。适配层维护 `name↔assetId` 解析表，源自 `metaAndAssetCtxs`/`spotMetaAndAssetCtxs`/`perpDexs`。

### 4.2 价格/数量精度（下单前强制校验）
- size 按资产 `szDecimals` 取整。
- price 同时满足：≤5 有效数字（整数价例外）且小数位 ≤ `(perp 6 / spot 8) − szDecimals`；签名前去尾零。
- 提供 `formatPx/formatSz/validateOrder` 工具；最小下单 **$10 名义**校验。

### 4.3 订单类型与参数
- order: `{a,b,p,s,r,t,c,builder?}`；t = limit{tif: Gtc/Ioc/Alo} 或 trigger{triggerPx,isMarket,tpsl}；grouping = na/normalTpsl/positionTpsl。
- 必备：reduce-only、TP/SL（trigger+sibling 配对）、市价(IOC)、**cloid** 幂等；进阶：TWAP(twapOrder/twapCancel)。
- `cancelByCloid` 字段名是 `"asset"`（非 `"a"`）；布尔标志缺省时**省略而非置 false**（否则 hash 不匹配）。

### 4.4 订单状态机 / 拒绝码映射
- 状态：open/filled/canceled/triggered/rejected/marginCanceled/reduceOnlyCanceled/siblingFilledCanceled/scheduledCancel/openInterestCapCanceled/liquidatedCanceled…
- 拒绝码：tickRejected/minTradeNtlRejected/perpMarginRejected/badAloPxRejected/badTriggerPxRejected/oracleRejected… → 归一化为可读中文提示。

### 4.5 价格语义
- **mark 价**：未实现盈亏 / 保证金 / 清算 / TP-SL 触发（≈3s 更新，禁用 last trade 算 PnL）。
- **oracle 价**：funding 结算（每小时 1/8 的 8h 费率）。

### 4.6 WebSocket feeds（适配层）
- 公共：`allMids`、`bbo`(轻量, 仅变化推)、`fastAssetCtxs`(压缩 diff, 全市场 markPx/midPx, 省带宽省电)、`l2Book`(fast=5/默认20档)、`trades`、`candle`。
- 用户级：`webData3`(注意：旧名 webData2)、`clearinghouseState`、`openOrders`、`orderUpdates`、`userFills`、`userFundings`、`userEvents`(消息 channel 名为 `"user"`)、`activeAssetData`。
- 纪律：60s 无消息必须 `ping`；重连 `isSnapshot:true` 是正常恢复不可重复计；fastAssetCtxs 本地合并 diff。

### 4.7 限频预算（影响后端扇出设计）
- IP：1200 weight/min（l2Book/allMids/clearinghouseState=2，多数 info=20，exchange=1+⌊n/40⌋）。
- 地址级：每累计 1 USDC 交易量 = 1 请求，初始 buffer 1万，撤单有增强额度，可 `reserveRequestWeight` 预购。
- WS：≤10 连接、≤1000 订阅、**≤10 个唯一用户地址**、≤2000 msg/min、≤100 inflight post。
- ⚠️ "≤10 唯一用户"使"单连接共享扇出所有用户私有数据"不可行 → 公共数据走 allMids/fastAssetCtxs 单连接；用户私有数据按需建连 + 多 IP 分片。

### 4.8 多用户私有数据扇出（评审修订 —— 原设计不可规模化）
"后端 connector 池扇出**用户私有数据**"在 ≤10 唯一用户/IP 的硬限下无法直接扩展。修订设计：
- **公共行情**：后端集中订阅（allMids/fastAssetCtxs/l2Book/trades/candle），扇出给所有客户端——这部分可集中、可缓存。
- **用户私有数据**（clearinghouseState/openOrders/orderUpdates/userFills/userEvents）：**默认由客户端自身直连 HL 订阅**（每设备 1 个用户地址，天然在限内）；仅当 agentic 离线监控必须时，后端按"每 IP ≤10 用户"**显式分片**（IP 池 + 准入控制 + 容量测算 + 超限回退轮询 + 限频监控告警）。
- 即：后端不为"在线手动用户"代订阅私有流，只为"离线 agentic 用户"分片订阅——把后端私有订阅规模收敛到活跃策略用户数。

---

## 5. 钱包与签名安全模型

### 5.1 两层授权
- **Tier 1 主钱包（自主权）**：私钥留设备（**Passkey 本地钱包**主推 / Privy 嵌入式备选，见 §5.4/ADR-011）。仅用于：approveAgent、approveBuilderFee、**提现/划转**(withdraw3/usdSend/spotSend/usdClassTransfer，均 user-signed，agent 无权)。
- **Tier 2 Agent 钱包（受限委托, trade-only）**：签 L1 动作(order/cancel/modify/scheduleCancel/updateLeverage…)。**不能提现/外转**（agentSendAsset 仅限同地址）。
  - 手动交易：agent key 存设备 SecureStore + 生物识别。
  - 离线 agentic：agent key 托管服务端安全签名器（Turnkey/TEE/KMS）。

### 5.1a 服务端签名器 = 拒绝优先的策略引擎（评审修订 —— 关键安全修补）
trade-only 不等于无害：被攻破的服务端 agent key 仍可通过**对手盘恶意成交、对敲/洗、超杠杆强平、刷手续费**等方式**在不提现的情况下耗尽账户价值**。因此服务端签名器**不得是裸签名预言机**，必须是**拒绝优先(deny-by-default)的策略执行边界**：
- 用户须以**主钱包签署的策略授权(policy)**，把每个策略的硬约束（最大名义、市场白名单、最大杠杆、价格带/滑点、reduce-only 规则、单日亏损上限、有效期、可交易子账户/vault）**绑定进签名边界**；签名器只对满足 policy 的意图放行。
- **按用户 + 策略隔离**：独立密钥/策略/nonce 队列；杜绝跨用户串签。
- 护栏在**签名前于边界内强制**，而非仅在上游应用层"建议"。

### 5.2 签名细节（防错）
- 两套方案：L1 action（phantom-agent，domain `Exchange`/chainId 1337，msgpack 字段顺序敏感）；user-signed（domain `HyperliquidSignTransaction`，**`hyperliquidChain` 防主网/测试网重放**）。
- nonce：ms 时间戳，窗口 (T-2d, T+1d)，每签名者保留最高 100、严格递增不复用；**按私钥而非账户** → 每进程/子账户独立 agent key。`expiresAfter` 仅 L1（过期罚 5× 限频）。

### 5.3 Agent 生命周期（修正 v1 假设）
- 官方 **approveAgent 无 validUntil**、有效期机制未公开。因此：
  - 运行时检测 `"User or API Wallet ... does not exist"` → 触发主钱包重新授权流程。
  - **每次授权生成全新私钥；绝不复用过期/注销 agent key**（pruning 后旧 nonce 可被重放）。
  - 命名规则：未命名 agent 仅 1 个；命名 agent 主账户 3 个 + 每子账户 2 个。
- 分布式签名后端：每进程一把 agent key + 原子 nonce 计数器 + NTP 同步。
- **主动健康检查（评审修订）**：重授权需主钱包在线，而离线期恰是策略要覆盖的时段。故：① 启用长时运行自动化前，**强制预重授权**并提示用户；② 后台周期性探测授权健康并在临近失效时推送告警；③ 授权健康不确定时**自动挂起策略**而非静默失败。

### 5.4 钱包选型与信任边界（评审修订 —— 厘清"非托管"口径）
> 四维度（安全/体验/技术复杂度/合规）完整对比与论证见 [钱包方案对比与选型](../../WALLET-SOLUTION-COMPARISON.md)。
- **Passkey 本地钱包（主推，见 ADR-011）**：设备端生成 secp256k1 钱包，私钥存 `expo-secure-store(requireAuthentication)`，由 Secure Enclave/StrongBox 硬件门禁（Face ID/指纹）保护；助记词为终极备份，可选 iCloud Keychain 同步实现 Apple 设备间自动恢复。优势：硬件级安全 + Privy 级体验 + 真非托管 + 零厂商依赖 + 隐私最大化（无第三方知道地址）+ 无第三方 SDK 端点天然绕 GFW。
- **Privy 嵌入式（便利性备选）**：用户端 onboarding（社交/邮箱→嵌入式非托管钱包）。须明确并文档化：托管/恢复模型、可导出性、账户接管(ATO)假设——"非托管"成立与否取决于具体配置。**用户决策（2026-06-17）：不接入 WalletConnect/外部钱包**，钱包接入仅 Passkey 本地 + Privy 嵌入式 + view-only。
  - 取舍：社交 onboarding/跨平台云恢复更省心；代价是厂商依赖 + ATO 面 + 按 MAU 计费。为保留自主权，Privy 须开启**私钥可导出**，让用户随时把嵌入式钱包迁出到本地模式。
- **view-only**：仅地址，零私钥，最低门槛入口/演示。
- **Turnkey/TEE/KMS**（服务端 agent 签名）：三者的托管、恢复、远程证明、被攻破模型**各不相同**，须分别选定模式并文档化（TEE 须有远程证明；单纯 KMS 是否可接受需评估）。安全/合规声明绑定到具体配置，不可笼统并列。**成本默认（ADR-010）：默认自托管 KMS/TEE 以避免按用户/按签名的厂商费；Turnkey 仅作"托管省心"备选。该签名器只服务开启离线自动化的用户。**
- 能力封装在 `WalletService` 接口后可热插拔（未来若重新引入外部钱包，仅需新增适配器）。

### 5.5 平台差异（iOS / Android 安全原语 —— 单一 RN 代码库，仅密钥边界分叉）
**策略**：一套 React Native + Expo 代码库（非两套原生 App）；仅在"安全元件/密钥存储/生物识别/云同步"边界用 `Platform.select` + Expo config plugin 分叉。

| 层 | iOS | Android |
|---|---|---|
| 密钥存储 | Keychain Services（`expo-secure-store`）；`ThisDeviceOnly` 不同步 / `WhenUnlocked` 可 iCloud 同步 | Keystore 系统（`expo-secure-store`，加密 SharedPreferences） |
| 硬件根 | Secure Enclave (SEP) | **StrongBox**（Pixel 3+/部分旗舰）否则 TEE |
| 生物识别 | Face ID / Touch ID（`expo-local-authentication`，需 `NSFaceIDUsageDescription`） | BiometricPrompt（AndroidX Biometric）；**注意：多数人脸解锁是 Class 2/弱，不可绑密钥；指纹 Class 3/强才行** |
| 云备份(助记词) | **iCloud Keychain**（`WhenUnlocked` 同步 item） | **无 iCloud 等价**：Google Block Store（需自写原生模块）或**手动助记词导入**；Auto Backup 须排除密钥 |
| Passkey/WebAuthn 登录 | AuthenticationServices + Associated Domains（`apple-app-site-association`） | Credential Manager + Digital Asset Links（`assetlinks.json`） |
| 推送 | APNs | FCM |
| OAuth(Privy) | ASWebAuthenticationSession（`expo-web-browser`） | Chrome Custom Tabs（`expo-web-browser`） |
| 构建/分发 | Xcode + EAS(macOS) → App Store/TestFlight；**Apple §3.1.5(iv) perps 风险** | Gradle + EAS(Linux) → Google Play；非托管钱包豁免更清晰 |

**对产品的硬影响**：① **跨设备恢复 Android 弱于 iOS**（无 iCloud 自动同步）→ Android 必须强引导助记词备份；② Android **Keystore 密钥在生物识别重新录入时可能失效**（`setInvalidatedByBiometricEnrollment`）→ 需以助记词为恢复底座；③ 测试需真机（模拟器/emulator 的安全元件/生物识别不完整）。

---

## 6. Agentic 执行引擎（L1 先行）

- 自主度：**L1 规则自动化先行**（TP/SL、移动止损、DCA、网格、条件/定时单），架构预留 L2(AI 辅助)/L3(受限自主, 默认关、显式 opt-in、小额沙盒)。
- **强制风控护栏（签名前必过网关）**：仓位上限、市场白名单、最大杠杆、单日亏损熔断、滑点/价格带、频率、有效期、用户一键 **kill-switch**（护栏在签名器边界内强制，见 §5.1a）。
- **scheduleCancel 死手开关**：心跳每轮刷新 `time=now+30~60s`；每日 ≤10 次触发；**只撤单不平仓**；客户端与后端均用。
- **幂等**：每单**先生成并持久化 cloid 再签名**，重试用同一 cloid，按 cloid 对账/撤改，避免重复下单。

### 6.1 诚实的"离线"语义（评审修订 —— 不可过度承诺）
"离线也能跑策略"须如实表述为 **"尽力而为的服务端自动化"**，不可被理解为"手机离线即安全"：
- `scheduleCancel` **只撤挂单、不平仓**；后端宕机/签名器不可用/agent 失效期间，**未平仓持仓仍暴露市场风险**。
- 缓解：策略须**预置 reduce-only 止损/止盈**（驻留在 HL 侧的真实订单，不依赖我们在线）；设**最大离线敞口 TTL**；提供策略健康指示；**显式风险揭示**：后端故障不保证 risk-off。
- 不得把 scheduleCancel 宣传为完整的死手风控。

### 6.2 HA / 幂等 / nonce（评审修订 —— 强化分布式语义）
agentic 执行**完全是后端关键路径**，需明确：
- **持久意图账本/状态机**：意图 → 持久化(含 cloid) → 签名 → 提交 → 按 cloid 对账(open/filled/rejected)；HTTP/WS 不确定回执时用 cloid 去重，杜绝重复或孤儿单。
- **nonce 单写者**：每个 agent key 配**租约/fencing 的单写 nonce 分配器**（非多副本各自原子计数），避免脑裂/故障切换时 nonce 冲突。
- **签名器/厂商外部依赖**：定义 Turnkey/TEE 不可用时的降级行为与 **agentic SLO**；leader 选举 + 冗余 + 背压。

### 6.3 策略限频预算（评审修订）
网格/DCA/高频撤改会吃掉地址级请求额度、挂单上限(1000+)、scheduleCancel 10次/日：
- 每用户**速率预算 + 撤单合并(coalescing) + 挂单数上限 + scheduleCancel 触发计数**；临界进**降级模式**并告警。

- 每笔自动交易/触发/熔断推送用户。

---

## 7. 收入模型：Builder Codes（v2 新增）

- onboarding 让**主钱包**签 `approveBuilderFee`(maxFeeRate)；之后每单带 `builder:{b,f}`。
- `f` 单位 = 1/10 基点（f=10→1bp→0.01%）；超授权则拒单；未授权则**静默零收入**。
- builder 地址需 ≥100 USDC(perp) + "standard" abstraction 模式；上限 perps 0.1%/spot 1%。
- 收益对账：`userFills.builderFee`、info `referral`、日 CSV；经推荐奖励流程领取。

### 7.1 评审修订 —— 不把 builder fee 当作有保证的唯一收入
- 用户可不批准/可撤销/可不接受费率；配置错误则**静默零收入**。故：**显式费用同意 UI**（透明展示费率）、**零费率回退**（未授权也能正常交易，不阻断）、**授权遥测**（监控批准率/撤销率）、并规划**备选变现**（订阅/高级功能/L2-L3 自动化增值）。

---

## 8. 入金 Onboarding（v2 新增 —— "没 USDC 无法起步"）

- 主路径：**Arbitrum 原生 USDC** 跨桥到 HyperCore。UI 强警示：**最低 5 USDC（低于永久丢失）**、仅原生 USDC、新账户 1 USDC 激活费、需 Arbitrum ETH 付 gas；`batchedDepositWithPermit` 可赞助 gas。
- 多链/法币：经第三方 Unit Protocol / Swapped.com **外链**，不自建（避免成为 money transmitter）。
- 即便 MVP 不自建入金，也必须有引导页 + 强警示，否则产品不可用。

---

## 9. 合规与上架

- **存在性风险（评审修订，提级）**：Apple §3.1.5(iv) 把永续视为 futures，要求出品方为"established FCM/银行/受批准金融机构"。这可能**不论托管模型一律拒审**，是足以**重塑产品**的风险，而非普通"高风险"。决策：
  - 设**合规闸门**（§2）：法律意见确认"出品主体/牌照/地区"路径前，公开发布只到 **Phase 1 只读** 或 **现货/自选优先**；
  - **首发地区**排除美/加(Ontario)及受制裁国，优先监管较轻且允许非托管衍生品 UI 的辖区（需法律确认）；
  - 评估**持牌合作方**路径。
- **受限辖区 geo-block（至少）**：美国、Ontario(加)、古巴、伊朗、缅甸、朝鲜、叙利亚、俄占乌克兰；App 内 IP geo-block + VPN 检测 + 按地区提交。
- **中国大陆访问方案（技术 + IP 限频应对）**：Hyperliquid 不主动屏蔽中国大陆（仅屏蔽美国/Ontario/制裁国），但**防火墙可能屏蔽 API 访问**（加密货币审查）。解决方案：**智能路由 + IP 池 + 流量分离**。① 客户端启动时检测网络环境（IP geo 定位 + 直连可达性测试 3 秒超时）；② 中国大陆用户自动路由至后端代理（部署 20 个 Cloudflare Workers 实例获得不同出口 IP，按用户 ID 一致性哈希分配，避免触发 Hyperliquid IP 限频 1200 weight/min）；③ **流量分离**：只读查询(/info)与公共 WS 走代理（高频但可缓存），签名交易(/exchange)与私有 WS 客户端直连（低频且 HTTPS 加密难拦截，规避 WS ≤10 用户/IP 限制）；④ 客户端缓存减少 50% 请求、后端缓存减少 30% 上游请求；⑤ 429 限频响应时自动切换代理或降级直连；⑥ 其他地区直连 Hyperliquid（低延迟）；⑦ 设置界面提供手动切换（自动/直连/代理）。后端代理合法（企业服务器境外部署），成本低（Cloudflare Workers 免费额度或 20 个免费账号），用户无需翻墙。权衡：后端代理增加一跳延迟（~50-100ms 香港节点），但保证稳定性；需维护 IP 池与监控限频告警。**上架策略**：不上架中国区 App Store（避免 ICP 备份/加密货币审核），仅上架港澳台+国际区（中国用户可切换 Apple ID 下载）。
- **缓解论据**：非托管框架（钱包而非交易所）、公司实体出品（非个人账号）、强风险揭示、**强调 agent/后端不能提现（withdraw3 仅主钱包）**、法律意见。先例：Based.one、Dexari 已上 iOS/Android（官方文档列为入口，但各有自有合规层）。
- ToS/风险揭示、合规文档备审；代客自动交易(agentic)可能触及投顾/资管，上架前法律评估。

---

## 10. 设计系统（主题）

- **A · Electrum Terminal（默认）**：深海墨蓝 `#0A1217` + 银金 `#E8C98F`。
- **B · Daylight Ledger（浅色主题）**：冷纸白 `#EEF1F3` + 墨蓝 `#0E5A6B`。
- **C · Oscilloscope（可选仪器主题）**：暖墨黑 `#0C0A07` + 琥珀荧光 `#FFB454`。
- 共同纪律：品牌色与涨跌语义色（Jade/Ember）分离；以 token 实现、运行时可切换。渲染图见 `docs/design/renders/`，方法论与对比见 `docs/design/VISUAL-DIRECTION*.md`。

---

## 11. 性能 / 丝滑工程
Hermes + New Architecture；高频价格用 Reanimated 共享值在 UI 线程更新；WS 增量按帧合并 + 盘口分档节流；优先用 bbo/fastAssetCtxs 轻量流；FlashList 虚拟化；MMKV 本地优先冷启动秒开；K 线缓存先开后实时。

## 12. 稳定 / 高可用 / 可观测
后端无状态多 AZ；connector 池 + leader 选举 + 幂等 + 背压 + 熔断；OpenTelemetry 指标/追踪/日志 + SLO；Sentry 崩溃。手动交易降级直连 HL。

## 13. 测试策略
单元（精度/asset-id/签名/归一化/护栏）；集成对**测试网**跑只读与下单（不动真金，CI 默认指向 testnet）；组件 RTL；E2E(Detox) 后置。

---

## 14. 分阶段路线图（修订）
见 §2 表。修正要点：onboarding 增 approveBuilderFee + 入金引导；Phase 3 前置"精度/asset-id/状态码三件套 + cloid + builder"；agentic 后端每进程独立 agent key + 原子 nonce + NTP + 失效重授权 + scheduleCancel。

## 15. 决策记录（ADR 索引）
- ADR-001 钱包选型：**Passkey 本地钱包主推** + Privy 备选 + 自托管 KMS/TEE(服务端 agent，Turnkey 为备选)。**修订(2026-06-17)：移除 WalletConnect/外部钱包，钱包接入仅 Passkey 本地 + Privy 嵌入式 + view-only（见 ADR-008/ADR-011）；确认双层架构不合并为 Turnkey 单家（见 ADR-009）。**
- ADR-002 Agentic：两层授权；**修正**：agent 无文档化有效期→运行时重授权、绝不复用旧 key。
- ADR-003 主题：A 默认 / B 浅色 / C 可选。
- ADR-004（v2 新增）：Builder Codes 作为收入模型，onboarding 集成 approveBuilderFee。
- ADR-005（v2 新增）：入金以 Arbitrum 原生 USDC 跨桥为主路径，第三方多链/法币外链。

## 16. 开放问题
1. 上架地区首批清单（建议先非美/加 + 非受制裁国）。
2. builder fee 费率定价（如 1~5bp）。
3. 现货是否纳入（架构已为 spot/HIP-3 预留 asset-id）。
4. 图表实现（原生轻量 vs WebView lightweight-charts）。
5. L2/L3 自主度开放节奏与法律边界。

---

## 17. 评审修订日志（rubber-duck，2026-06-17）
独立评审发现 10 项,已逐条采纳（B=阻断已修, N=非阻断已修）：

| # | 问题 | 处置 | 章节 |
|---|---|---|---|
| 1 | 上架是存在性风险非"高风险" | B 设合规闸门；公开发布先只读/现货优先；首发排除美加 | §2 闸门, §9 |
| 2 | trade-only agent 仍可经恶意成交耗尽价值 | B 签名器=拒绝优先策略引擎，policy 绑定签名边界，按用户隔离 | §5.1a |
| 3 | 离线 agentic 过度承诺(scheduleCancel 不平仓) | B 改"尽力而为"；预置 reduce-only 止损 + 离线敞口 TTL + 显式揭示 | §6.1 |
| 4 | 分布式签名 HA/nonce 太笼统 | B 持久意图账本(cloid 先于签名)+租约 fencing 单写 nonce+SLO | §6.2 |
| 5 | 多用户私有 WS 扇出不可规模化 | B 公共集中/私有客户端直订或按 IP 分片+准入+回退轮询 | §4.8 |
| 6 | agent 失效处理被动(离线无法重授权) | N 主动健康检查+预重授权+不确定即挂起 | §5.3 |
| 7 | Privy/Turnkey/TEE/KMS 信任边界混为一谈 | N 分别选定模式并文档化，声明绑定具体配置 | §5.4 |
| 8 | Phase 1 计划 markPx/midPx 语义混用 | N 修复计划：分离 markPx(快照)与 midPx(live) | plans/markets-list |
| 9 | 策略限频预算不足 | N 每用户预算+撤单合并+挂单上限+触发计数+降级 | §6.3 |
| 10 | builder fee 作唯一收入太脆 | N 显式同意+零费率回退+遥测+备选变现 | §7.1 |

- ADR-006（v2.1）：合规作为公开发布的硬闸门；perps/agentic 公开发布需法律意见先行，否则只发只读/现货。
- ADR-007（v2.1）：服务端 agent 签名器必须为拒绝优先策略引擎（policy 绑定签名边界 + 按用户隔离），而非裸签名预言机。
- ADR-008（2026-06-17，用户决策）：**不接入 WalletConnect/外部钱包**；钱包接入仅 Privy 嵌入式 + view-only。理由：onboarding 更简、攻击面更小、维护更少。为保自主权，Privy 须开启私钥可导出；`WalletService` 接口保留未来重新引入外部钱包的扩展点。**（后经 ADR-011 修订：新增 Passkey 本地钱包为主推，Privy 降为便利性备选；"不接入外部钱包"决策不变。）**
- ADR-009（2026-06-17，已补充单家评估）：**Privy 与 Turnkey 不冲突、按角色分层互补**。Privy = Tier1 用户主钱包（端上 onboarding/授权/提现）；Turnkey = Tier2 服务端 agent 签名器（离线 trade-only 交易）。硬规则：**一钥一家——绝不让两家托管同一把钥匙**（Privy 只管主钱包钥匙，Turnkey 只管 agent 钥匙），二者唯一联系是链上 approveAgent 授权。承认功能重叠（Privy session signer 也能代签、Turnkey 也有嵌入式钱包），**已评估 Turnkey 单家覆盖两层方案，不采纳**：①成本 3-25 倍（$9,750 vs $2,500/月企业级谈判价，按 1 万 MAU + 2000 agent 用户场景）；②上线慢 2-3 个月（Turnkey embedded wallet 需自建社交/邮箱/passkey onboarding UI，vs Privy 1-click 原生集成）；③UX 劣势（用户期待 2025 年标准的无摩擦登录）；④单点风险（一家挂全挂，vs 双供应商可降级回退 Privy 手动交易）。**双层架构为最终决策**。Turnkey/TEE/KMS 仍为 Tier2 候选未选定（§5.4），ADR-010 主张默认自托管 KMS/TEE 避免按签名收费。
- ADR-010（2026-06-17，成本）：**避免"每用户双付费"**。① 计费现实：Privy 按 MAU、Turnkey 按钱包+每次签名。② 第二个签名器**只服务"开启离线自动化"的用户**——手动/端上 agent 用户（Phase 2-4）只用 Privy + 设备 SecureStore（零第二方费用）。③ **默认自托管 KMS/TEE 做 agent 签名器**（agent 为 trade-only、爆炸半径小，自托管成本随规模摊薄、非按人头），Turnkey 仅作"托管省心"备选。④ 离线自动化挂付费档/由 builder 返佣覆盖其签名成本——**产生第二份成本者正好为其付费/创收**。
- ADR-011（2026-06-17，钱包最优方案）：**Passkey 保护的本地私钥作为主推方案**。技术实现：设备端用 **viem**（`generateMnemonic`/`mnemonicToAccount`，与 §3 声明的签名库统一；ethers `Wallet.createRandom()` 等价、可互换）生成 secp256k1 钱包（含 BIP-39 助记词）→ 私钥存入 `expo-secure-store`（`requireAuthentication: true` 绑定 Face ID/指纹硬件保护）→ 交易时 `expo-local-authentication` 自动触发生物识别解锁签名。**备份/恢复**：助记词（BIP-39, 12 词）为终极备份，首次创建时**显示一次**要求用户纸质抄写/密码管理器存储（禁止截图，验证 3 个随机词）；设备丢失时输入助记词恢复钱包并重新绑定新设备 Passkey。**云同步选项（用户可选）**：助记词可选存 `expo-secure-store` 的 iCloud Keychain 模式（`keychainAccessible: WHEN_UNLOCKED` 启用 iCloud 同步）实现 Apple 设备间自动恢复——注意须与生物识别门禁的私钥 item **分开存储**（`requireAuthentication: true` 的 item 不随 iCloud 同步），权衡为依赖 Apple ID 安全（账号被盗风险）但仍是非托管（存用户 iCloud 而非第三方服务器）；默认推荐纸质+iCloud 双备份策略。**Passkey 角色**：访问控制层（利用 iOS Secure Enclave / Android StrongBox 硬件加密），而非加密密钥——真签名密钥是 secp256k1（HL EOA 用，非 WebAuthn P-256），Passkey/生物识别仅作解锁门禁。优势：①Privy 级别 UX（Face ID 秒登/签名 + 可选 iCloud 自动多设备同步）+ 真非托管（私钥不出设备/iCloud 在用户控制下）；②零成本、零第三方依赖（Privy 挂了不影响）；③隐私最大化（无第三方服务器知道地址）；④硬件级安全（Secure Enclave/StrongBox）。权衡：iCloud 同步依赖 Apple ID 安全；**Android 无 iCloud 等价物**，跨平台需手动导入助记词（iOS iCloud ≠ Android）；用户需理解助记词重要性（丢失=丢币）。Onboarding 提供三选一：🌟Passkey 本地钱包（主推，可选 iCloud）、🔐Privy 云钱包（便利性备选，社交恢复/Privy 云同步）、👁️仅查看。`WalletService` 接口支持多实现（`PasskeyLocalWalletService`、`PrivyWalletService`、`ViewOnlyWalletService`），允许 Privy 导出私钥迁移到本地模式。**实施优先级（明确）**：Phase 2 以 `PasskeyLocalWalletService` 为**默认实现**先行落地（含 onboarding/助记词备份/恢复 UX，Android 重点补云同步缺口）；`PrivyWalletService` 为**可选第二适配器**，须开启 `exportWallet` 支持导出迁移；`ViewOnlyWalletService` 作零门槛入口。唯一会令 Privy 先行的例外：抢 1–2 周上线窗口且早期 <500 MAU、暂不顾及中国大陆——此时仍须开 `exportWallet` 以保留迁回本地的退路。
- ADR-012（2026-06-18，云端备份 —— 拟定 / 可选 opt-in）：**可行，但仅限零知识（zero-knowledge）客户端加密备份**，以补齐 Android 无 iCloud 等价物的跨设备恢复缺口、并提供统一跨平台备份。**硬约束**：明文助记词/私钥与用户口令**绝不上服务器**，否则即沦为托管、击穿安全红线与非托管合规定位。推荐实现：① 用户设独立**备份口令/PIN**（与设备解锁分离）；② 强 KDF（**Argon2id**，高内存/迭代）派生密钥；③ **AES-256-GCM / XChaCha20-Poly1305** 客户端加密助记词；④ 仅密文 blob 存我方后端(Postgres/对象存储)，按用户 id 索引；⑤ 恢复=下载密文→本地输入口令解密。**加固（防弱口令离线爆破）**：采用 **OPAQUE/PAKE + 服务端 pepper + 限频取回**，使密文即便泄露也无法离线暴力破解；服务端被攻破也只得 pepper、仍缺用户口令。**进阶可选**：Shamir 秘密分享(SSS)社交恢复（N-of-M 分片分散到设备/我方云/亲友/邮箱，任一方含我方都无法单独重建）作高级档；或 WebAuthn passkey **PRF 扩展**派生封装密钥（passkey 本身已由 Apple/Google 云同步）。**取舍/限制**：① 忘记备份口令则无法找回（设计如此）——纸质助记词仍是终极兜底；② 恢复依赖我方服务在线（故障期走纸质/iCloud 路径）；③ 必须显式 UI 告知"零知识、忘口令即不可恢复"。**定位**：Passkey 本地(ADR-011)仍是主推；云端备份为其**可选增强**，尤其服务 Android 用户与"不想管纸质助记词"的人群。
- ADR-013（2026-06-21，后端语言 —— 用户决策）：**后端服务语言 = Go**，取代原 Node/TS BFF 规划。理由：goroutine 并发模型契合常驻 connector 池 / WS 扇出（§4.8）、Temporal-Go 与 NATS（Go 原生）一等公民、静态二进制 + 小依赖面利于签名器最小 TCB 与供应链安全。**代价（需缓解）**：失去与 TS 客户端的 SDK/类型复用 → Hyperliquid action msgpack 哈希 + EIP-712 签名须在 Go 重做（`go-ethereum` crypto + msgpack），两套 domain（L1 phantom-agent / user-signed，见 §5.2）分别实现；与客户端 `@nktkas/hyperliquid`(TS) 用**跨语言黄金测试向量逐字节对拍**，守住「精度/asset-id/cloid 三件套」零漂移。**Hyperliquid 官方无 Go SDK**（仅 Python 官方；Rust/TS 社区）→ 优先**自写最小 Go 签名核**，以官方 Python SDK / 社区 Rust SDK(`infinitefield/hypersdk`) 为权威参照，并先做「Go 下单 testnet 成功」spike 验证；Go 为 GC 语言，签名核密钥须 `defer` 显式清零并**优先配 KMS/Nitro Enclave**（密钥不进进程，抵消 GC 短板）。**例外**：中国边缘代理（§4.1）保留 Cloudflare Workers(JS)；M5 签名核在最高保证档可用 Rust 写 enclave 小核。**落地视图**：模块拆分 / 信任边界 / polyglot 决策 / 签名核三档见 `docs/BACKEND-ARCHITECTURE.md`。客户端（Expo RN + TS）与整体架构（§4.1 降级直连、§4.7/4.8 路由扇出、§5.1a 签名边界、§6.2 HA）不变。
- ADR-014（2026-06-21，发布评估策略 —— 用户决策）：**近期经 TestFlight 评估，ADR-006 合规硬闸门暂缓至公开上架前**。理由：TestFlight 是 Apple 的 Beta 分发（**非 App Store 公开发布**），故 §3.1.5(iv)「永续=futures」的公开上架审查闸门此刻不触发，可先在受限范围放开 perps/agentic 做产品评估与 dogfooding。**注意/边界**：① 外部测试员（≤10,000）仍需 Apple **Beta App Review**（较正式审查轻，但加密/永续仍可能被拒）；内部测试员（≤100 个 App Store Connect 用户）免 Beta Review；② TestFlight 构建 90 天过期、**仅供测试不得用于商业/公开分发**；③ **ADR-006 不撤销**——公开上架（Phase 6）前仍须法律意见先行 + 地区策略（仅港澳台/国际区、不上中国区）。即：合规为「公开发布」闸门，TestFlight 评估期不阻塞，但公开上架前必须回到 ADR-006 流程。
