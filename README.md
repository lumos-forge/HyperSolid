# HyperSolid

在手机上直接、流畅、安全地使用 **Hyperliquid** 交易永续合约的**非托管**移动 App，并提供"离线也能跑策略"的 **agentic 钱包**。

> 状态：实施中（spec 定稿 v2.1；**S1 导航 + S2 行情板块 + S3 合规/CI + S4 钱包(密钥核心+onboarding UI) + S5 交易(执行/签名层+下单UI)** 已完成；**UI 重构：单线示波器图标系统 + 7 屏对齐设计稿（行情/详情/交易/持仓/策略/钱包）已完成**、795 单测通过（mobile）、tsc 零错、模拟器实时渲染无运行时错误；**server/ 策略引擎 + Go M5 签名核 + M6 跨主机单写者（#28–#33）已落地**；最终真机部署(需 Apple 签名)与真实 testnet 下单(需充值钱包+生物识别确认)为人工交互步骤）。

---

## 一句话定位

面向公众、应用商店上架的非托管 Hyperliquid 交易客户端。非功能优先级：**丝滑、稳定、高可用**。安全红线：**主资金明文私钥/签名永不离开设备（云备份仅零知识密文，见 ADR-012），后端绝不托管，提现只能主钱包签**。

## 技术栈

- 客户端：React Native + Expo + TypeScript；状态 Zustand + TanStack Query；列表 FlashList；动效 Reanimated 3。
- Hyperliquid SDK：`@nktkas/hyperliquid`（InfoClient 只读 / SubscriptionClient WS / ExchangeClient 签名）。
- 钱包：**Passkey 本地钱包**（设备生成私钥 + 生物识别 + 助记词/iCloud 备份，**主推**，ADR-011）+ **Privy 嵌入式**（便利性备选）+ view-only（**不接入 WalletConnect/外部钱包**，ADR-008）。
- 后端（渐进式 BFF，高可用）：**Go**（HTTP: chi/gin · 编排: Temporal Go SDK · 扇出: NATS · 缓存: Redis · 存储: Postgres）；服务端 agent 签名器 **自托管 KMS/TEE（Nitro Enclave，Turnkey 备选，ADR-010）**。Hyperliquid action 编码/EIP-712 签名在 Go 侧重做，并与 TS 客户端用跨语言黄金向量对拍（ADR-013）。
- 收入：Hyperliquid **Builder Codes**（链上可追溯返佣）。

## 路线图（详见 spec §2）

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 脚手架（Expo+TS、CI、geo-block、Sentry） | **✅**（Expo+TS+Jest、GitHub Actions CI、geo-block 门禁屏、Sentry+日志脱敏 均已实现） |
| 1 | 只读行情（市场列表/详情/view-only 持仓） | **✅**（Markets/Detail/Positions 屏对齐设计稿；mobile 795 单测通过） |
| 2 | 钱包与鉴权（Passkey 本地/Privy onboarding、approveAgent、approveBuilderFee、入金引导） | **✅**（本地密钥核心 + 生物识别 onboarding + approveAgent + Arbitrum 入金桥；Passkey 作解锁门禁、真签名 secp256k1，ADR-011） |
| 3 | 交易核心（下单/撤改/TP-SL/杠杆；精度·asset-id·状态码三件套） | **✅**（Trade 屏 6 种订单类型 + TIF + 杠杆 + 提交预览 + 精度/asset-id/状态码校验） |
| 4 | 持仓与历史 | **✅**（Positions 屏 + fills/funding/TWAP 历史；TWAP slice fills 时间窗分页） |
| 5 | Agentic 执行引擎（L1 规则自动化 + 护栏 + 签名器） | **大部分完成**（server/ 策略引擎 DCA/TWAP/TPSL/grid/gridLimit + scheduler + SQLite 持久化；Go **M5 签名核** policy/keystore/nonce/digest+sign + TS 影子校验。生产密钥托管/下发待做） |
| 6 | 后端 HA 化 + 上架 | **进行中**（**M6 跨主机单写者**已落地：core / pg-writer / lease / leader / endpoint / main 接线，#28–#33；意图账本 cloid 对账、多 AZ/指标、公开上架 待做） |

> ⚠️ **合规硬闸门**：perps/agentic **公开发布**需法律意见先行（Apple §3.1.5(iv) 视永续为 futures 是存在性风险），否则公开发布只到 Phase 1 只读或现货优先（ADR-006）。**近期评估走 TestFlight**（非公开发布，不触发该闸门，ADR-014）；公开上架前仍须回到 ADR-006 流程。

## 文档索引

| 文档 | 说明 |
|---|---|
| [设计方案 v2.1（权威 · 单一事实来源）](docs/superpowers/specs/2026-06-17-hypersolid-design.md) | 架构/安全/agentic/收入/合规/主题/路线图 + ADR 索引 + 评审日志 |
| [Hyperliquid 官方文档缺口分析](docs/HYPERLIQUID-GAP-ANALYSIS.md) | 对照官方文档的遗漏清单（带 gitbook 引用），按严重度分级 |
| **[中国大陆访问全面分析](docs/CHINA-ACCESS-ANALYSIS.md)** | **完整端点清单、GFW 屏蔽机制、各流量类型成功率、IP 限频应对、监控/法律策略** |
| **[钱包方案对比与选型](docs/WALLET-SOLUTION-COMPARISON.md)** | **私钥方案四维度对比（安全/体验/技术/合规）+ 最终选型论证（Passkey 本地主推 + Privy 备选 + 自托管签名器）** |
| **[产品功能方案（商用上线标准）](docs/PRODUCT-FEATURE-SPEC.md)** | **5 大板块逐一细化（功能/屏/状态/边界/HL API）+ 跨切面（通知/i18n/合规/客服/埋点/无障碍）+ 上线就绪清单 + P0/P1/P2 优先级** |
| **[后端架构（Go · 评审稿）](docs/BACKEND-ARCHITECTURE.md)** | **11 个后端模块拆分 + 信任/进程隔离边界 + polyglot 决策（Go 主体/JS 代理/签名核分档）+ M5 签名核三档（Go→KMS→Enclave）+ backend/ 目录骨架（ADR-013）** |
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
- **ADR-013（2026-06-21，用户决策）**：**后端语言 = Go**（替代原 Node/TS BFF 规划）。理由：goroutine 并发模型契合 connector 池/WS 扇出、Temporal/NATS 一等公民、静态二进制 + 小依赖面利于签名核与供应链安全。**代价（需缓解）**：失去与 TS 客户端的 SDK/类型复用 → HL action msgpack 哈希 + EIP-712 签名须在 Go 重做（go-ethereum crypto），并与 `@nktkas/hyperliquid`(TS) 客户端用**跨语言黄金测试向量逐字节对拍**（守住「精度/asset-id/cloid 三件套」零漂移）；Go 为 GC 语言，签名核密钥须 `defer` 显式清零并优先配 KMS/Nitro Enclave。**先决**：Hyperliquid **官方仅维护 Python SDK**（Rust/TS 均社区，**无官方 Go SDK**；第三方如 quiknode-labs 需自行审计）。故签名优先**自写最小 Go 签名核**（go-ethereum crypto + msgpack，依赖面最小），以官方 Python SDK / 社区 Rust SDK(infinitefield/hypersdk) 为权威参照，并先做「Go 下单 testnet 成功」spike 验证编码正确。客户端（Expo RN + TS）与整体架构（降级直连、§4.7 路由、§5.1a 签名边界、§6.2 HA）不变；中国边缘代理仍可保留 Cloudflare Workers(JS)。
- **ADR-014（2026-06-21，用户决策）**：近期经 **TestFlight 评估**（非 App Store 公开发布），ADR-006 合规硬闸门暂缓至公开上架前。TestFlight Beta 不触发 §3.1.5(iv) 公开上架审查，可在受限范围放开 perps/agentic 做评估；但外部测试员仍需 Apple Beta App Review，构建 90 天过期且仅供测试。**ADR-006 不撤销**——公开上架（Phase 6）前仍须法律意见先行 + 地区策略。

## 仓库结构（规划）

```
HyperSolid/
├── README.md            # 本文件（项目概览 + 文档索引）
├── docs/                # 设计文档、缺口分析、视觉方向与渲染图
├── mobile/              # Expo RN 客户端（✅ 已脚手架，Phase 0 起）
└── backend/             # Go BFF + agentic 执行引擎 + 签名器（规划中，Phase 5/6 起；见 docs/BACKEND-ARCHITECTURE.md）
```
