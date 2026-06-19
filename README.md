# HyperSolid

在手机上直接、流畅、安全地使用 **Hyperliquid** 交易永续合约的**非托管**移动 App，并提供"离线也能跑策略"的 **agentic 钱包**。

> 状态：实施中（spec 定稿 v2.1；**Phase 1 行情列表切片完成**——市场列表 MVP 跑通，35 单测通过、tsc 零错误、Metro 打包通过；详情/持仓与 Phase 2 钱包为后续切片）。

---

## 一句话定位

面向公众、应用商店上架的非托管 Hyperliquid 交易客户端。非功能优先级：**丝滑、稳定、高可用**。安全红线：**主资金明文私钥/签名永不离开设备（云备份仅零知识密文，见 ADR-012），后端绝不托管，提现只能主钱包签**。

## 技术栈

- 客户端：React Native + Expo + TypeScript；状态 Zustand + TanStack Query；列表 FlashList；动效 Reanimated 3。
- Hyperliquid SDK：`@nktkas/hyperliquid`（InfoClient 只读 / SubscriptionClient WS / ExchangeClient 签名）。
- 钱包：**Passkey 本地钱包**（设备生成私钥 + 生物识别 + 助记词/iCloud 备份，**主推**，ADR-011）+ **Privy 嵌入式**（便利性备选）+ view-only（**不接入 WalletConnect/外部钱包**，ADR-008）。
- 后端（渐进式 BFF，高可用）：Node/TS + Redis + NATS/Redis Streams + Postgres；服务端 agent 签名器 **自托管 KMS/TEE（Turnkey 备选，ADR-010）**。
- 收入：Hyperliquid **Builder Codes**（链上可追溯返佣）。

## 路线图（详见 spec §2）

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 脚手架（Expo+TS、CI、geo-block、Sentry） | **进行中**（Expo+TS+Jest ✅；CI/geo-block/Sentry 待办） |
| 1 | 只读行情（市场列表/详情/view-only 持仓） | **行情列表 ✅**（Task 0–12 完成，35 测试通过，Metro 打包通过；详情/持仓为后续切片） |
| 2 | 钱包与鉴权（Passkey 本地/Privy onboarding、approveAgent、approveBuilderFee、入金引导） | 待规划 |
| 3 | 交易核心（下单/撤改/TP-SL/杠杆；精度·asset-id·状态码三件套） | 待规划 |
| 4 | 持仓与历史 | 待规划 |
| 5 | Agentic 执行引擎（L1 规则自动化 + 护栏 + 签名器） | 待规划 |
| 6 | 后端 HA 化 + 上架 | 待规划 |

> ⚠️ **合规硬闸门**：perps/agentic 公开发布需法律意见先行（Apple §3.1.5(iv) 视永续为 futures 是存在性风险），否则公开发布只到 Phase 1 只读或现货优先（ADR-006）。

## 文档索引

| 文档 | 说明 |
|---|---|
| [设计方案 v2.1（权威 · 单一事实来源）](docs/superpowers/specs/2026-06-17-hypersolid-design.md) | 架构/安全/agentic/收入/合规/主题/路线图 + ADR 索引 + 评审日志 |
| [Hyperliquid 官方文档缺口分析](docs/HYPERLIQUID-GAP-ANALYSIS.md) | 对照官方文档的遗漏清单（带 gitbook 引用），按严重度分级 |
| **[中国大陆访问全面分析](docs/CHINA-ACCESS-ANALYSIS.md)** | **完整端点清单、GFW 屏蔽机制、各流量类型成功率、IP 限频应对、监控/法律策略** |
| **[钱包方案对比与选型](docs/WALLET-SOLUTION-COMPARISON.md)** | **私钥方案四维度对比（安全/体验/技术/合规）+ 最终选型论证（Passkey 本地主推 + Privy 备选 + 自托管签名器）** |
| **[产品功能方案（商用上线标准）](docs/PRODUCT-FEATURE-SPEC.md)** | **5 大板块逐一细化（功能/屏/状态/边界/HL API）+ 跨切面（通知/i18n/合规/客服/埋点/无障碍）+ 上线就绪清单 + P0/P1/P2 优先级** |
| [Phase 1 实施计划：只读行情列表](docs/superpowers/plans/2026-06-17-hypersolid-markets-list.md) | 首个切片的 TDD 任务拆解（脚手架 + 实时市场列表） |
| [视觉方向](docs/design/VISUAL-DIRECTION.md) | frontend-design 方法论产出的设计语言（默认主题 A） |
| [视觉方向对比](docs/design/VISUAL-DIRECTION-COMPARISON.md) | A/B/C 三方向对比 |
| [渲染图 A/B/C](docs/design/renders/) | 三套主题的高保真截图（Markets/Detail/Agent 三屏） |

## 设计主题

- **A · Electrum Terminal（默认）**：深海墨蓝 `#0A1217` + 银金 `#E8C98F`。
- **B · Daylight Ledger（浅色主题）**：冷纸白 `#EEF1F3` + 墨蓝 `#0E5A6B`。
- **C · Oscilloscope（可选仪器主题）**：暖墨黑 `#0C0A07` + 琥珀荧光 `#FFB454`。
- 纪律：品牌色与涨跌语义色（Jade/Ember）分离；token 实现、运行时可切换。

## 关键决策（ADR 摘要，详见 spec §15）

- **ADR-001/008/011**：钱包 = **Passkey 本地主推 + Privy 嵌入式备选 + view-only**（移除 WalletConnect/外部钱包）。
- **ADR-002**：两层授权（主钱包自主权 / agent trade-only）；agent 无文档化有效期 → 运行时重授权、绝不复用旧 key。
- **ADR-003**：主题 A 默认 / B 浅色 / C 可选。
- **ADR-004**：Builder Codes 作为收入模型。
- **ADR-005**：入金以 Arbitrum 原生 USDC 跨桥为主路径。
- **ADR-006**：合规作为公开发布硬闸门。
- **ADR-007**：服务端签名器 = 拒绝优先策略引擎（policy 绑定签名边界 + 按用户隔离）。
- **ADR-009**：双层架构为最终决策；Privy 与 Turnkey 一钥一家，不合并为 Turnkey 单家。
- **ADR-010**：避免每用户双付费；agent 签名器默认自托管 KMS/TEE，仅服务离线自动化用户。
- **ADR-011**：Passkey 本地钱包为最优主推方案（硬件级安全 + 真非托管 + 零厂商依赖），Privy 降为便利性备选。
- **ADR-012（拟定/可选）**：云端备份可行，但仅限零知识客户端加密（Argon2id + AES-GCM，密文上云、明文与口令绝不上服务器），补齐 Android 跨设备恢复缺口。

## 仓库结构（规划）

```
HyperSolid/
├── README.md            # 本文件（项目概览 + 文档索引）
├── docs/                # 设计文档、缺口分析、视觉方向与渲染图
├── mobile/              # Expo RN 客户端（✅ 已脚手架，Phase 0 起）
└── backend/             # Node/TS BFF + agentic 执行引擎（规划中，Phase 5/6 起）
```
