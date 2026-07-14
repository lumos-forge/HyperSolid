# Hyperliquid 官方文档 × HyperSolid 方案 · 缺口分析

日期：2026-06-17
方法：并行抓取 Hyperliquid 官方文档（hyperliquid.gitbook.io/hyperliquid-docs）四大板块（行情/WS、交易机制、签名与钱包/限频、出入金与合规），逐项对照我们的 spec/plan（`session plan.md` + `docs/superpowers/plans/2026-06-17-hypersolid-markets-list.md`）。下方每条标注严重度与官方出处。

> 结论先说：方案大方向（非托管、agent trade-only、两层授权、后端不在下单关键路径、geo-block）都成立。原列的 **3 个商业/安全级遗漏**中，**builder code 收入（A1）已全路径落地**（手动+引擎本地+引擎委托，配置门控，PR #111/#112/#113）、**scheduleCancel 安全（A2）引擎侧已落地且预算持久化**（#52/#53/#110）；agent 有效期处理（A3）仍需运行时检测重授权。**一批正确性级遗漏**（下单精度规则、asset ID 解析、限频具体预算、最小下单额、订单状态机、cloid 幂等）已在交易链路落地（`mobile/src/lib/hyperliquid/*`），余 **出入金 onboarding** 这个"新用户无法起步"的硬缺口（C2）。

---

## A. 严重（商业模式 / 资金安全）

### A1. Builder Codes / builder fee —— 公开 App 的主要收入来源 ✅ **已落地（配置门控）**
- **状态**：收入闭环全路径落地（服务端配置门控，默认「暗发」直到 ops 填 `BUILDER_ADDRESS`/`BUILDER_PERP_FEE_TENTH_BPS`）：手动交易（mobile，PR #111：`/app-config` 下发 builder + 一次性 `approveBuilderFee` 授权门 + 单/bracket/scale 挂 builder，惰性 `maxBuilderFee` 检查、fail-open）；agentic 引擎·本地密钥路径（#112：`makeBuilderInjector` 按 owner 查 `maxBuilderFee` 门控 + 正/负向缓存 TTL + fail-open，`makeClientFor` 本地分支包装挂 builder）；agentic 引擎·委托/签名器路径（#113：Go `BuildOrderAction`/`ActionFromKind` 加可选 action 级 builder，golden 向量跨语言逐字节校验，`signerExchangeClient` + 委托分支复用同一 injector）。永续费率 0.02%（服务端可调至 0.1% 上限免重签）。**残留**：入金引导（见 C2）、builder 地址运营/领取流程仍属运维。
- 机制（两步）：① 用户**主钱包**签 `approveBuilderFee`（设 maxFeeRate，如 "0.1%"）；② 之后每笔 `order` 带顶层 `builder: { b: <你的地址>, f: <费率> }`。
- 单位坑：`f` 以**1/10 基点**计——`f=10` = 1bp = 0.01%。超过用户已授权的 maxFeeRate → 订单被拒。未授权时 `builder` 字段被**静默忽略=零收入**。
- 资格：builder 地址需 **≥100 USDC 在 perp 账户** + "standard" abstraction 模式。上限：perps 0.1%、spot 1%。
- 收益查询：info `maxBuilderFee` / `referral`；每笔 `userFills.builderFee`；日 CSV `stats-data.hyperliquid.xyz/Mainnet/builder_fills/{addr}/{YYYYMMDD}.csv.lz4`。
- 影响：必须在 onboarding 增加"approveBuilderFee"一步；下单链路加 builder 字段；运营要有 builder 地址余额与领取流程。
- 出处：trading/builder-codes；for-developers/api/exchange-endpoint。

### A2. scheduleCancel（Dead Man's Switch）—— 应升为通用安全原语 ✅ **引擎侧已落地（预算持久化）**
- **状态**：agentic 引擎侧落地——心跳每轮刷新 `time`、≤10/日触发预算、失败过渡式告警（#52/#53），且**预算已 SQLite 持久化（#110）**：`dead_man_budget(owner, day, count, armed_until)`，正/负缓存跨重启不丢，防崩溃循环/频繁部署重置计数而超 HL 真实 10/天限额致死手**静默失效**；AgentScreen 提供 per-策略死手开关。**残留**：手动交易端（在线用户）的通用 client-side 死手原语尚未做（属较低优先子缺口）。
- 机制：`{ type:"scheduleCancel", time }`，`time` ≥ now+5s；到点**撤销全部挂单**；省略 time = 清除。每日最多 **10 次触发**（00:00 UTC 重置），刷新 time 不计次。可由 agent（L1）签名。
- 关键风险：**只撤挂单，不平仓**——离线的大持仓仍暴露市场风险（需配合止损/减仓策略）。
- 影响：客户端与后端都应：心跳每轮刷新 `time=now+30~60s`；重连后立即重建；预算 10 次/日。
- 出处：for-developers/api/exchange-endpoint（Schedule cancel）。

### A3. Agent 有效期"未文档化" —— 修正我们 ADR-002 里"可设过期"的假设 🚨
- 事实：官方 `approveAgent` **没有 validUntil 字段**，也未公布默认/最大有效期；SDK 的 approve_agent 无过期参数。pruning 触发仅三种：注册同名/同未命名 agent、过期（机制未公开）、注册账户无资金。
- 必做：后端**运行时检测** `"User or API Wallet 0x... does not exist"` 错误 → 触发主钱包重新授权；**绝不复用过期/注销的 agent 私钥**（nonce set 被 pruning 后，旧的已签名动作可被重放）。每次重新授权都生成**全新私钥**。
- 命名/数量：未命名 agent 仅 1 个（新建即注销旧的）；命名 agent 主账户最多 3 个，每个子账户 +2。
- 出处：for-developers/api/nonces-and-api-wallets（API wallet pruning）。

---

## B. 高（下单正确性 —— 不做就会被拒单/数据错）

### B1. 价格/数量精度规则（tick/lot）—— 方案未提，下单必须先满足
- size：按该资产 `szDecimals` 取整（perp 来自 `meta.universe[n]`，spot 来自 `spotMeta.tokens[n]`）。
- price 须**同时**满足：① ≤ 5 有效数字（**整数价例外**，如 123456 合法）；② 小数位 ≤ `MAX_DECIMALS - szDecimals`（perp 6、spot 8）。
- 违反 → `tickRejected`。签名前还需**去掉尾零**。
- 影响：下单面板/服务层必须有 price/size 格式化+校验工具函数。
- 出处：for-developers/api/tick-and-lot-size；/notation；/signing。

### B2. Asset ID 解析 —— 方案未提，下单/部分接口需要整数 asset
- perp：`asset` = 该 coin 在 `meta.universe` 的索引（BTC=0）。
- spot：`asset` = 10000 + spotMeta 索引；API coin 字符串用 `"@{index}"`（PURR 例外用 "PURR/USDC"）。
- HIP-3 builder perp：`asset = 100000 + dexIndex*10000 + idx`，coin 名 `"{dex}:{COIN}"`。
- 坑：mainnet/testnet ID 不同（**绝不硬编码**，启动时用 meta/spotMeta 解析）；UI 名可能重映射（`BTC/USDC` ↔ 链上 `UBTC/USDC`）。
- 出处：for-developers/api/asset-ids；/info-endpoint。

### B3. 最小下单名义 $10 —— 方案未提
- 低于 $10 名义 → `minTradeNtlRejected`。下单 UI 必须校验并提示。
- 出处：for-developers/api/info-endpoint（rejection codes）。

### B4. 订单状态机 / 拒绝码 —— 方案只说"错误归一化"，需映射完整枚举
- 状态：open/filled/canceled/triggered/rejected/marginCanceled/reduceOnlyCanceled/**siblingFilledCanceled**(TP/SL 配对撤销)/**scheduledCancel**/openInterestCapCanceled/liquidatedCanceled…
- 拒绝码：tickRejected/minTradeNtlRejected/perpMarginRejected/reduceOnlyRejected/**badAloPxRejected**(post-only 会立即成交)/iocCancelRejected/**badTriggerPxRejected**(触发价在 mid 错误一侧)/oracleRejected/各种 OI cap 拒绝…
- 影响：错误归一化层要把这些映射成可读中文提示。
- 出处：for-developers/api/info-endpoint。

### B5. cloid（client order id）幂等 —— 方案说"幂等下单"但未指机制
- 下单带 `c`(cloid)；断线重连后可按 cloid 查询/撤销，避免重复下单——这正是 agentic 后端"幂等"的实现机制。
- 坑：`cancelByCloid` 用字段名 `"asset"`（不是 `cancel` 的 `"a"`），易写错。
- 出处：exchange-endpoint；critical-features 清单。

### B6. mark vs oracle 价用途 —— 方案未明确
- 未实现盈亏(PnL)/保证金/清算/TP-SL 触发：用 **mark price**（≈3s 更新），**不要用 last trade**。
- funding 结算：用 **oracle price**（不是 mark），每小时 1/8 的 8h 费率。
- 出处：trading/robust-price-indices；hypercore/oracle；trading/funding。

### B7. 限频具体预算 —— 方案只写"频率限制"，缺数值，影响后端扇出设计
- IP：1200 weight/min（l2Book/allMids/clearinghouseState/orderStatus=2，多数 info=20，exchange=1+⌊n/40⌋）。
- 地址级：每累计 **1 USDC 交易量 = 1 请求**，初始 buffer 1万，被限后 1 req/10s；撤单有增强额度；可用 `reserveRequestWeight` 预购（0.0005 USDC/请求）。
- WS：≤10 连接、≤1000 订阅、**≤10 个不同用户地址**、≤2000 msg/min、≤100 inflight post、**60s 无消息断连必须 ping**。
- ⚠️ "**≤10 个唯一用户地址**"对"后端共享 WS 扇出用户数据"是硬上限——多用户必须分 IP/分连接，或公共数据走 `allMids`/`fastAssetCtxs`、用户私有数据按需建连。
- 出处：for-developers/api/rate-limits-and-user-limits；websocket。

---

## C. 中（功能完整性）

### C1. 订单类型不全
- 方案有市价/限价/TP-SL。缺：tif=**ALO(post-only)**/IOC/GTC、**reduce-only**、trigger 的 tpsl+isMarket、grouping(na/normalTpsl/positionTpsl)、**TWAP**(twapOrder/twapCancel，高级用户期待)、scale(前端批量限价)。
- 出处：trading/order-types；exchange-endpoint。

### C2. 出入金 onboarding —— 新用户"没 USDC 无法起步"的硬缺口（方案把出入金后置到 Phase 5）
- 充值主路径：**Arbitrum 原生 USDC** 跨桥到 HyperCore。关键警示必须进 UI：
  - **最低 5 USDC，低于则永久丢失**；只收 Arbitrum 原生 USDC（USDT/ETH/其它=丢失）；
  - 新账户首笔 **1 USDC 激活费**；需 Arbitrum ETH 付 gas；`batchedDepositWithPermit` 可第三方赞助 gas。
- 多链/法币：经第三方 Unit Protocol（BTC/ETH/SOL…）/ Swapped.com（法币）——可外链，不自建（避免成为 money transmitter）。
- 建议：即便 MVP 不自建入金，也要有"如何入金"引导页 + 强警示，否则产品不可用。
- 出处：hypercore/bridge；api/bridge2；onboarding/how-to-start-trading；api/activation-gas-fee。

### C3. 提现安全 = 合规论据
- `withdraw3` **只能主钱包签**（agent 不能提现），提现费 1 USDC。这点应写入 Apple 审核材料："App 即使被攻破也无法盗取资金"。perp↔spot 划转用 `usdClassTransfer`。
- 出处：api/bridge2；exchange-endpoint；signing。

### C4. 两套签名方案 + 防重放字段 —— 方案只笼统说"EIP-712 + nonce"
- L1 action（order/cancel/…）：phantom-agent，domain `Exchange/chainId 1337`，msgpack 字段顺序敏感，签名前去尾零。
- user-signed（withdraw/approveAgent/approveBuilderFee/…）：domain `HyperliquidSignTransaction`，**`hyperliquidChain`(Mainnet/Testnet) 是防主网/测试网重放的关键字段**，`signatureChainId` 仅定 EIP-712 domain。
- nonce：ms 时间戳，窗口 (T-2d, T+1d)，每签名者保留最高 100 个、须严格递增不复用；**nonce 按私钥而非账户**——一把 agent key 给多进程/子账户签名会冲突。分布式后端：每进程一把 agent key + 原子计数器 + NTP 同步。`expiresAfter` 仅 L1 可用（过期动作罚 5× 限频）。
- 出处：api/signing；api/nonces-and-api-wallets。

### C5. WS 适配易错点
- 订阅名 `webData2` 现为 **`webData3`**；`userEvents` 的消息 channel 名是 **`"user"`**；`fastAssetCtxs` 是压缩 diff 流（base64+raw deflate，只发变动币种，要本地合并）；重连快照 `isSnapshot:true` 是正常恢复别重复计。
- 轻量价格流：`bbo`（仅 BBO 变化时推）/`fastAssetCtxs`（全市场 markPx/midPx 压缩）比 l2Book/allMids 更省带宽省电——契合"丝滑/省电"目标。
- 出处：websocket/subscriptions。

---

## D. 低（增值 / 生态，可后置但架构预留）

- 子账户（$10万量解锁）、**Vault**（可做产品角度：金库 leader/跟单）、多签账户、**质押 HYPE**（享交易费折扣）、HyperEVM、HIP-3 多 perp DEX、现货(HIP-1/2)。当前不做，但 **asset ID 解析要为 spot/HIP-3 预留**。
- 费率档位展示（maker/taker、质押折扣、推荐 4% 折扣首 $25M 量）。
- 注意：`setReferrer`/`createSubAccount` 似乎**无 API action**（UI-only）——别在计划里假设可编程。
- 受限辖区完整清单：美国、Ontario、古巴、伊朗、缅甸、朝鲜、叙利亚、俄占乌克兰——geo-block 至少覆盖这些（方案此前只写"如美国"）。
- 上架现实：Apple §3.1.5(iv) 把永续视为 futures，要求"established FCM/银行/受批准金融机构"出品——**高风险阻断点**。先例 Based.one、Dexari 已上架（非托管框架 + 自有合规层）。缓解：公司主体、按地区提交排除美/加/受制裁国、App 内硬 geo-block+VPN 检测、强风险揭示、强调 agent 不可提现、法律意见。

---

## 对路线图的修正建议（按优先级）

1. **新增 onboarding 步骤**：approveBuilderFee（收入）**✅ 已落地**（首单前惰性授权门 + 全路径挂 builder，PR #111–#113）；入金引导页（含 5 USDC/Arbitrum 原生 USDC 强警示）**仍待做**（C2）。
2. **交易阶段(Phase 3)必须前置三件套**：价格/数量精度校验工具、asset ID 解析表、订单状态/拒绝码映射；下单带 cloid + builder；最小 $10 校验。**✅ 已落地**（`mobile/src/lib/hyperliquid/{assetId,format,order,buildOrder,cloid}.ts`；builder 见 A1）。
3. **安全原语**：scheduleCancel 心跳（客户端+后端通用）—— **引擎侧✅ 已落地且预算持久化**（#52/#53/#110），手动端 client-side 通用原语待做；mark 价做 PnL/触发、oracle 价做 funding。
4. **agentic 后端**：每进程独立 agent key + 原子 nonce + NTP；运行时检测 agent 失效并走主钱包重授权；绝不复用旧 agent key；限频预算（含"≤10 唯一用户" WS 上限的分片设计）。
5. **合规**：受限辖区清单补全；提现"agent 不可提"写入审核材料；法律实体 + 牌照评估。
6. **WS 适配层**：webData3 / userEvents channel="user" / fastAssetCtxs diff / bbo 轻量流 / 60s ping。

> 注：当前首个实施计划（只读行情列表，perps-only）不受上述大部分影响；但其 SDK 适配层应预留 asset-id 解析与 webData3/bbo 订阅命名，交易相关缺口在 Phase 3 计划中落实。
