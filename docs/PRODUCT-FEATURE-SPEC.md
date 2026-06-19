# HyperSolid 产品功能方案（商用上线标准）

> 目标读者：产品/设计/工程/合规。本文把 [设计 spec v2.1](superpowers/specs/2026-06-17-hypersolid-design.md) 的工程架构，落到**面向用户的完整功能清单**，标准为「可上线商用」。
> 关系：spec = 架构/安全/ADR 权威源；本文 = 用户侧功能完整性与上线就绪度。两者一致（5-Tab IA 见 spec §3.1，钱包见 ADR-011，合规闸门见 ADR-006）。
> 竞品基线：对标 Dexari（Hyperliquid 头部非托管移动 App）。**差异化护城河 = 离线 agentic 策略引擎（竞品无）**。

---

## 0. 验收标准（什么叫"功能方案达到商用标准"）

1. **5 大板块**每个都细化到：功能清单 · 关键屏 · 状态(加载/空/错误/离线) · 核心交互 · 边界与异常 · 映射 HL API。
2. **跨切面商业能力**齐备：通知告警、国际化(中国可用)、合规与风险揭示、客服反馈、埋点分析、无障碍、全局状态机。
3. **商业化闭环**：收入(Builder Codes)、增长(邀请)、留存(通知/agent)。
4. **上线就绪清单**逐项可勾（功能/质量/合规/法务/性能/安全/运营/应用商店）。
5. **优先级分层** P0(MVP 必须)/P1(上线后快速跟进)/P2(增值)，给出可发布的最小商用集。

---

## 1. 🏠 板块一 · 行情 Markets

### 1.1 功能清单
| 功能 | 说明 | 优先级 | HL 来源 |
|---|---|---|---|
| 永续列表 | 全市场列表，列：标的/标记价/24h 涨跌/资金费/成交量 | **P0** | `metaAndAssetCtxs` + `allMids` ✅已实现 |
| 排序 | 按成交量/涨跌幅/资金费/字母 | P0 | 客户端 |
| 搜索 | 按 coin 名即时过滤 | P0 | 客户端 |
| 自选/收藏 | 收藏标的置顶分组，本地持久化(MMKV) | P1 | 客户端 |
| 分类 Tab | 全部/自选/热门/新上线/涨幅榜 | P1 | 客户端聚合 |
| 现货列表 | spot 市场（架构已为 spot/HIP-3 预留 asset-id） | P2 | `spotMeta` |
| Market Detail | 见 §1.2 | **P0** | 多接口 |

### 1.2 Market Detail（行情详情）
| 模块 | 说明 | 优先级 | HL 来源 |
|---|---|---|---|
| K线图 | 多周期(1m/5m/15m/1h/4h/1d)，蜡烛/分时；TradingView 级体验为目标 | **P0** | `candleSnapshot` + `candle` 订阅 |
| 盘口 | 买卖档位深度、价差 | **P0** | `l2Book` 订阅 |
| 最近成交 | 实时成交流 | P0 | `trades` 订阅 |
| 市场统计 | 标记价/指数价/资金费(及倒计时)/持仓量(OI)/24h 量/最大杠杆 | **P0** | `activeAssetCtx`/`fastAssetCtxs` |
| 资金费历史 | 历史费率曲线 | P1 | `fundingHistory` |
| 价格告警 | 设置到价提醒（接通知系统） | P1 | 客户端 + 后端推送 |
| 快捷下单入口 | 跳转/预填到 Trade Tab（Trade 为独立 Tab，spec §3.1） | **P0** | — |

### 1.3 状态与边界
- 加载：骨架屏（行情列表/详情）。空：无搜索结果空态。错误：网络失败可重试 + 自动回退直连(spec §3 降级)。
- 离线/降级：显示"数据延迟"标记；WS 断连 60s 自动 ping、重连用快照恢复(`isSnapshot` 不重复计)。
- 中国大陆：行情(公共 WS)成功率最低(10-30%)，**必经智能路由/IP 池**（见 CHINA-ACCESS-ANALYSIS.md）。

---

## 2. ⚡ 板块二 · 交易 Trade（独立 Tab，用户决策 2026-06-19）

### 2.1 下单功能
| 功能 | 说明 | 优先级 | HL 约束 |
|---|---|---|---|
| 市价单 | 即时成交 | **P0** | IOC |
| 限价单 | GTC/IOC/**ALO(post-only)** | **P0** | tif；ALO 立即成交会 `badAloPxRejected` |
| 止盈止损 TP/SL | 触发单，可 isMarket，grouping(normalTpsl/positionTpsl) | **P0** | trigger px 方向校验 `badTriggerPxRejected` |
| reduce-only | 只减仓 | P0 | `reduceOnlyRejected` |
| 杠杆调整 | 滑块/输入，受 maxLeverage 限 | **P0** | `updateLeverage` |
| 保证金模式 | 逐仓/全仓切换 | P0 | cross/isolated |
| Scale 单 | 区间批量限价 | P2 | 前端拆单 |
| TWAP | 时间加权拆单 | P2 | `twapOrder`/`twapCancel` |

### 2.2 下单体验（商用关键）
- **下单面板**：方向(多/空)、数量(币/USDC/百分比滑块)、价格、杠杆、预估强平价、预估保证金、预估手续费(含 builder fee)、滑点提示。
- **三件套校验（spec §4，下单前必过）**：① 价格/数量精度(tick/lot, `szDecimals`)；② asset-id 解析(启动从 meta 解析，**绝不硬编码**)；③ 最小名义 $10(`minTradeNtlRejected`)。
- **cloid 幂等**：先生成持久化 cloid 再签名，重试同 cloid，杜绝重复下单(spec §6.2)。
- **二次确认**：高杠杆/大额/接近强平时强确认；首单风险揭示。
- **订单状态机**：open/filled/canceled/triggered/rejected/marginCanceled/...全枚举映射成中文可读提示(spec §4/缺口分析 B4)。

### 2.3 订单管理
- 当前委托：挂单列表、撤单/改单(撤改用 cloid)、一键全撤。
- scheduleCancel 死手开关入口（手动可设）。
- 状态：无挂单空态；下单中 loading；拒单错误归一化提示。

### 2.4 合规边界
- 闸门(ADR-006)前：Trade **仅测试网**或灰度；公开版隐藏/置灰，附"为何不可用"说明。

---

## 3. 💼 板块三 · 持仓 Positions

### 3.1 功能清单
| 功能 | 说明 | 优先级 | HL 来源 |
|---|---|---|---|
| 账户总览 | 账户权益、可用保证金、维持保证金、保证金率、总未实现盈亏 | **P0** | `clearinghouseState` |
| 持仓列表 | 每仓：标的/方向/数量/开仓均价/标记价/未实现盈亏/强平价/杠杆/保证金 | **P0** | `clearinghouseState` |
| 盈亏计算 | 未实现用 **mark 价**；不可用 last trade(缺口分析 B6) | **P0** | mark price |
| 平仓/减仓 | 市价/限价平仓，部分减仓 | **P0** | order(reduce-only) |
| 持仓 TP/SL | 对持仓挂止盈止损 | **P0** | trigger + positionTpsl |
| 资金费 | 已付/已收资金费，用 **oracle 价** | P1 | `userFunding` |
| 成交历史 | 历史成交明细 | **P0** | `userFills`/`userFillsByTime` |
| 订单历史 | 历史委托 | P0 | `historicalOrders` |
| 账本流水 | 充提/转账 | P1 | `userNonFundingLedgerUpdates` |
| **view-only 模式** | 输入地址零私钥预览持仓/盈亏（最低门槛入口/演示） | **P0** | 同上(只读) |
| 数据导出 | 成交/账本 CSV 导出 | P2 | 客户端 |

### 3.2 实时性
- 私有数据(持仓/订单)：**客户端自身直连 HL 订阅**(每设备 1 地址，天然在 ≤10 用户/IP 限内，spec §4.8)。
- 强平预警：接近强平价推送告警（接通知系统）。
- 状态：未连钱包→引导 onboarding/view-only；无持仓空态；加载骨架屏。

---

## 4. 🤖 板块四 · 策略 Agent（差异化护城河）

### 4.1 策略类型（L1 规则先行）
| 策略 | 说明 | 优先级 |
|---|---|---|
| 止盈止损/移动止损 | 持仓自动 TP/SL、追踪止损 | **P0(agent)** |
| 条件单 | 到价/突破触发 | P0 |
| 定时单 | 计划时间下单 | P1 |
| DCA 定投 | 周期分批建仓 | P1 |
| 网格 | 区间高抛低吸 | P1 |
| 组合/AI 辅助(L2/L3) | 架构预留，默认关、显式 opt-in、小额沙盒 | P2 |

### 4.2 策略生命周期与安全（spec §5.1a/§6）
- **策略创建**：选模板 → 配参数 → **主钱包签 policy**(最大名义/市场白名单/最大杠杆/价格带/单日亏损上限/有效期/可交易子账户)。
- **拒绝优先签名边界**：服务端签名器只放行满足 policy 的意图，非裸签名预言机(ADR-007)。
- **kill-switch**：一键停所有策略（全局可达）。
- **scheduleCancel 死手**：心跳刷新；**只撤单不平仓**——须如实揭示"后端故障期持仓仍暴露"(spec §6.1)。
- **预置 reduce-only 止损**：驻留 HL 侧，不依赖我们在线。
- **策略健康**：运行中/已布防/已挂起/失效；授权健康探测 + 临近失效告警 + 不确定即自动挂起(spec §5.3)。
- **离线敞口 TTL**：最大离线持仓时长上限。

### 4.3 状态/通知/揭示
- 状态机：草稿/已布防/运行中/已触发/已挂起/已停止/失效。
- 通知：策略触发、成交、失效需重授权、接近单日亏损上限、kill-switch 已执行。
- **强制风险揭示**：agent 为 trade-only 不能提现；"尽力而为的服务端自动化"非"手机离线即安全"。
- 合规：agentic 公开发布受闸门(ADR-006)，需法律意见先行。

---

## 5. 👤 板块五 · 钱包 / 我的 Account

### 5.1 Onboarding（三选一，spec ADR-011）
- 🌟 **Passkey 本地钱包(主推)**：设备生成 + 生物识别 + 助记词备份(强制抄写/验证 3 词/禁截图) + 可选 iCloud 同步。
- 🔐 **Privy 云钱包(备选)**：社交/邮箱登录，须开 `exportWallet`。
- 👁️ **view-only**：仅地址，零私钥。
- 首启流程：选钱包 → (可选)approveAgent → approveBuilderFee → 入金引导。

### 5.2 资金
| 功能 | 说明 | 优先级 | HL 约束 |
|---|---|---|---|
| 入金引导 | Arbitrum 原生 USDC 跨桥；**强警示**：最低 5 USDC(低于永久丢失)、仅原生 USDC、新账户 1 USDC 激活费、需 ETH gas | **P0** | bridge2；`batchedDepositWithPermit` 可赞助 gas |
| 多链/法币入金 | 第三方外链(Unit/Swapped/onramp)，不自建(避免 money transmitter) | P1 | 外链 |
| 提现 | withdraw3 **仅主钱包签**，费 1 USDC | **P0** | agent 无权提现 |
| 内部转账 | usdSend/spotSend、perp↔spot(usdClassTransfer) | P1 | user-signed |
| 余额展示 | 永续/现货余额 | P0 | `clearinghouseState`/`spotClearinghouseState` |

### 5.3 安全
- 生物识别开关、私钥/助记词导出、(可选)零知识云备份(ADR-012)、自动锁定、会话管理、撤销 agent 授权。

### 5.4 设置
- 主题 A/B/C 运行时切换 + 持久化、主网/测试网开关、语言(中/英)、通知偏好、默认杠杆/确认偏好、货币显示。

### 5.5 增长/收入/帮助
- 邀请/推荐、Builder fee 透明展示(费率/返佣)、费率档位、帮助中心/FAQ、ToS/隐私政策、风险揭示、客服反馈、关于/版本、(P2)质押/竞赛/积分。

---

## 6. 跨切面能力（商用必备）

### 6.1 通知与告警
- 类型：到价提醒、强平预警、订单成交、资金费、agent 事件(触发/失效/挂起/kill-switch)、授权临近失效。
- 通道：APNs/FCM 推送 + 应用内消息中心；偏好可分类开关；中国大陆 FCM 受限→需备选推送通道评估。

### 6.2 国际化与中国大陆
- i18n 中/英(可扩)；数字/货币/时间本地化。
- **中国可用性**：智能路由 + IP 池 + 流量分离 + 自动降级(CHINA-ACCESS-ANALYSIS.md)；DNS/SNI/DPI 规避；上架策略：不上中国区，港澳台+国际区(ADR/合规)。

### 6.3 合规与风险
- geo-block：US/Ontario/古巴/伊朗/缅甸/朝鲜/叙利亚/俄占乌克兰，App 内硬拦截 + VPN 检测。
- 强制风险揭示：永续高风险、agentic 离线语义、非托管(丢助记词=丢币)、提现 agent 不可动。
- ToS/隐私政策/免责；Apple §3.1.5(iv) 闸门(ADR-006)：闸门前公开版仅 Markets + view-only Positions。
- 无 KYC(非托管定位)，但保留合规演进位。

### 6.4 客服 / 反馈 / 运营
- 应用内反馈、帮助中心、状态页(故障公告)、应用内公告(维护/降级)、评分引导。

### 6.5 可观测与埋点
- 崩溃(Sentry)、性能、关键漏斗埋点(onboarding/入金/首单/建策略)、限频告警、agentic SLO；隐私合规(匿名化，尊重非托管隐私定位)。

### 6.6 无障碍与体验
- 动态字体、对比度(深浅主题已分离品牌/语义色)、VoiceOver/TalkBack、可点区域、减少动效选项、触觉反馈。

### 6.7 全局状态机
- 加载(骨架)/空/错误(可重试)/离线/后端降级(回退直连)/geo-block 拦截/未连钱包/维护中——每屏统一处理。

---

## 7. 商业化闭环
- **收入**：Builder Codes(链上返佣)——onboarding 集成 approveBuilderFee，下单带 builder 字段；显式同意 + 零费率回退 + 遥测(spec §7.1)。
- **可选**：离线 agentic 付费档(覆盖服务端签名器成本，ADR-010)；法币 onramp 分成。
- **增长**：邀请返佣、竞赛/积分(P2)、新上线标的首发。
- **留存**：通知召回、agent 自动化粘性、自选/告警。

---

## 8. 上线就绪清单（Commercial Readiness Checklist）

**功能**
- [ ] 5 板块 P0 功能全通；三件套(精度/asset-id/状态码) + cloid + builder 落地
- [ ] view-only + Passkey onboarding + 入金引导 + 提现 闭环
- [ ] 全局状态机各屏覆盖；中国大陆智能路由实测达标

**质量**
- [ ] 单元/集成(测试网)/组件/E2E(Detox) 绿；崩溃率 < 阈值；关键路径性能(60fps、冷启)
- [ ] 真机 iOS/Android 双端验收；弱网/断网/降级演练

**安全**
- [ ] 私钥明文不出设备；提现仅主钱包签；agent trade-only 策略边界；nonce 单写者；密钥存储渗透检查
- [ ] 第三方依赖审计(Privy/RPC/onramp)

**合规/法务**
- [ ] 法律意见(perps/agentic 上架，主体/牌照/地区)；ToS/隐私/风险揭示终审
- [ ] geo-block + VPN 检测；受限辖区清单；Apple §3.1.5(iv) 应对材料("即便被攻破也无法盗资金")

**应用商店**
- [ ] App Store/Play 元数据、隐私清单(数据收集声明)、年龄分级、截图、审核合规材料；地区提交排除美/加/受制裁国

**运营**
- [ ] 推送通道、状态页、客服、监控告警(Sentry/限频/SLO)、灰度与回滚预案、builder 地址余额与领取流程

---

## 9. 优先级与 MVP 商用最小集

| 层级 | 范围 | 目标 |
|---|---|---|
| **P0 · MVP 商用** | Markets(列表+详情) · Trade(市价/限价/TP-SL/杠杆/reduce-only) · Positions(总览/持仓/平仓/历史/view-only) · Account(Passkey onboarding/入金/提现/安全/设置) · 跨切面(通知核心/合规/中国路由/状态机) · Builder fee | 可上线、可交易、可盈利、合规可控 |
| **P1 · 快速跟进** | 自选/告警 · 资金费历史 · 内部转账 · agent(TP-SL/条件/DCA/网格) · i18n · 多链/法币入金 | 完整体验 + 差异化 agent 上线 |
| **P2 · 增值** | 现货/HIP-3 · TWAP/Scale · L2/L3 自主 · 竞赛/积分 · 数据导出 | 生态扩展 |

> **合规现实**：受 ADR-006 闸门约束，首发公开版可能只放 **P0 中的 Markets + view-only Positions**，Trade/Agent 待法律意见后开放或仅测试网。商业最小集的"可发布形态"取决于闸门结果。

---

## 10. 当前实现差距（截至 2026-06-19）
- ✅ 已实现：Markets 列表(Phase 1 Task 0–12，35 测试绿)
- ⬜ 待建：Market Detail · Trade 全板块 · Positions · Agent · Account · 5-Tab 导航骨架 · 全部跨切面
- **完成度**：约为商用功能集的 ~8%（Markets 列表部分）。本文即"从 8% 到 100% 的功能蓝图"。

*权威架构以 spec v2.1 为准；本文为商用功能完整性蓝图与上线就绪标准。*
