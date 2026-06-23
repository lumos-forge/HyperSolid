# HyperSolid — v8 UI 设计落地实施计划（continuous-agent-loop）

> **驱动方式：** 本计划由 `continuous-agent-loop`（sequential + quality gates）逐单元推进。
> 每轮只完整交付**一个**未打勾单元：TDD → 实现 → 质量门 → 自检 → 打勾 → 提交 → 停。
> **可重入**：每轮先读本文件，选第一个未打勾单元，不假设从零开始。

**目标：** 把**定稿的 v8 设计**落进真实 App 代码：磷光终端视觉（Electrum）、JetBrains Mono 数字 / Space Mono 嗓音 / Inter Tight 正文、▲▼ 语义、英雄数字辉光、**非对称 testnet 警示**、surface 卡、真实交易元素。**信息架构与业务逻辑不动**，只换视觉/补 UI 控件；全程主题令牌驱动。全程 tsc 零错 + jest 全绿（基线 372）。

---

## 唯一设计事实源（严格对齐，禁止自由发挥）

- **`docs/design/renders/build-v8.js` + `docs/design/renders/v8.png`**：v8 的精确令牌（配色/字体/间距/圆角）、各屏布局、文案、组件。**只取手机内内容**——对比图外框、假 OS 状态栏不是 App 一部分（真机状态栏由 SafeAreaView/设备提供）。
- 写 Expo/RN 前先读 `mobile/AGENTS.md` 与 https://docs.expo.dev/versions/v56.0.0/。

## 已定技术选型（生产标准，禁止改动）

- **主题**：扩展 `src/theme/tokens.ts`（electrum/daylight/oscilloscope 三套都保留），**新增 `warn` 警示色（electrum=#FFA53D）+ 必要 tint**；electrum 对齐 v8 值（brand #E8C98F、up #37D69A、down #FF6168、warn #FFA53D、dim/faint/surface 等）。**所有 UI 颜色走 token，禁止硬编码十六进制**。
- **字体**：`expo-font` + `@expo-google-fonts/jetbrains-mono`、`@expo-google-fonts/space-mono`、`@expo-google-fonts/inter-tight`（OFL/Apache 可商用），App 启动加载；字体 token `fonts.mono/display/body`；加载前回退系统字体。
- **图表**：`react-native-svg`（已在依赖）画 K 线/收益曲线/sparkline/深度条。
- **辉光**：RN `textShadowColor/Radius/Offset`（非 CSS text-shadow），仅英雄数字一处。
- **非对称网络警示**：由 `envStore.network` 驱动——**testnet 高调**（Markets 橙色警示 chip + Trade/Detail 顶部警示条），**mainnet 静默**。斜纹底纹用 `expo-linear-gradient`（如需则装）或退化为 warn 实底 + 左侧 warn 描边 + ⚠ 图标。
- **▲▼** 用几何字符（同现有 `◷`，**非 emoji**，允许）；负值带符号。

## 既有代码（**重构样式/补控件，非重写**；IA/逻辑不动）

- 屏：`src/screens/{MarketsScreen,MarketDetailScreen,TradeScreen,PositionsScreen,AgentScreen,AccountScreen}.tsx`（Agent=策略 Tab，Account=钱包 Tab）。
- 主题：`src/theme/{tokens,color,useTheme}.ts` + `themeStore`；状态：`src/state/*`（envStore/walletStore/marketStore/ledgerStore/exchangeStore）。
- 组件：`src/components/{Sparkline,Trace,OrderbookView,MarketRow,Pill,ScreenScaffold,Icon,...}`。**v8 头部已去掉示波器 trace 装饰线**——非首页不要 Trace。
- 交易逻辑：`services/exchange.ts` + `lib/hyperliquid/{buildOrder,order,cancel}`（`OrderRequest` 已支持 cloid/reduceOnly/trigger(TP-SL) → Trade 新控件接它，**不改编码核心**）；未确认横幅（Phase 3.2）已存在，钱包页接它。

## 不可触碰 / 范围边界

- **不改信息架构与业务逻辑**；不改 Phase 2 安全层（biometricGate/sessionController/authStore/deviceIntegrity/secureKeyStore）、Phase 3 编码核心（order/buildOrder/cancel/cloid）、IntentLedger 同步内核；交易仅接既有服务。
- **绝不下真单**：测试注入 mock，CI/测试默认 testnet。
- 字体仅用开源可商用（OFL/Apache）；▲▼ 几何非 emoji；辉光仅英雄数字一处、克制。
- 颜色一律走 token；不得为过门删既有测试或硬编码色。
- 基线：当前 372 单测通过、tsc 零错。任何一轮结束都不得让其下降。

---

## 每轮固定流程（严格按序）

1. 读本文件，选第一个未打勾单元；全打勾 → 跳「完成判定」。
2. 标记该单元进行中。
3. **TDD**：先写/扩展 `*.test.tsx`，断言 token/字体/▲▼/警示按 network 显隐/卡片/各屏关键元素与文案；先看它失败。
4. **实现**：对齐 build-v8.js 事实源；复用既有组件/主题，DRY；**把 mock 里每个硬编码值映射到 theme token**；IA/逻辑/编码核心不改。
5. **质量门**（全过否则不许打勾）：
   - `cd mobile && npx tsc --noEmit` → 零错误
   - `cd mobile && npx jest` → 全绿，且 ≥ 372 + 本单元新增
   - grep 改动 UI 文件：无 pictographic emoji（▲▼/◷ 几何字符允许）、无硬编码十六进制色
6. **自检**：对照 v8.png 该屏 + 生产清单（主题驱动、非对称警示、字体、无逻辑改动）。
7. plan 打勾 + 底部「Progress」追加一行：日期 + 单元 + 测试数 + 一句话结论。
8. **停止本轮**（一轮一个单元）。

---

## 单元清单（按顺序执行）

### - [x] 单元 1：主题令牌（warn + electrum 对齐 v8）

- [x] `tokens.ts` 加 `warn` 警示色 + 扩展令牌（surfaceAlt/lineStrong/faint/glow）；electrum 对齐 v8（up #37D69A、down #FF6168、warn #FFA53D 等）。tint 走既有 `withAlpha`（color.ts）。
- [x] daylight / oscilloscope 也补 `warn` + 扩展令牌（各自协调色），三套主题 schema 一致。
- [x] `tokens.test` 断言 `warn` 存在、与 `brand`/up/down 可区分、三套都有 + electrum 对齐 v8。

### - [x] 单元 2：字体基座

- [x] 装 `expo-font` + `@expo-google-fonts/{jetbrains-mono,space-mono,inter-tight}`（config plugin 已注册）；App `useFonts(fontMap)` 启动加载，首帧前 gate；错误则系统字体回退、不阻塞。
- [x] 暴露字体 token `fonts.mono/display/body`（`src/theme/fonts.ts` 纯字符串家族名，jest 安全）；全局可用。
- [x] `fonts.test` 断言 token 形状/角色映射/家族名唯一；`.ttf` 映射在 `fontAssets.ts`（仅 App 导入，隔离不入 jest）。

### - [ ] 单元 3：共享原语

- [ ] `PriceText/ChangeText`（tabular 数字 + ▲▼ + up/down 色 + 可选英雄辉光）。
- [ ] `SurfaceCard`（surface 底 + 顶部细 brand 线，非品牌色铺底）。
- [ ] `NetworkWarning`（非对称 testnet chip + 警示条，按 `envStore.network`；mainnet 不渲染）。
- [ ] TDD 各组件（▲▼/颜色/辉光、卡片结构、警示按 network 显隐）。

### - [ ] 单元 4：Markets 屏

- [ ] 简洁列表（星标 / 代号 PERP / Fund·Vol / 价格 / ▲▼）+ 搜索 + All/Watchlist + 警示 chip（testnet）。
- [ ] 复用 MarketRow/Sparkline（如保留）；接真实 marketStore；TDD（行渲染、▲▼、警示按 network）。

### - [ ] 单元 5：Market Detail 屏

- [ ] 报价块 + 统计网格（含资金费倒计时）+ 周期选择 + K 线（轴 + 当前价虚线）+ 指标 Tab + 多周期涨跌 + 委托簿/最新成交 + 多空条 + 深度盘口 + CTA + testnet 警示条。
- [ ] K 线/深度用 react-native-svg；TDD 关键元素与文案。

### - [ ] 单元 6：Trade 屏

- [ ] 买/卖 + 类型 + 杠杆可调 + 价/量 + 百分比滑杆 + Reduce-only/Post-only + TP/SL（Optional）+ 摘要 + 动态 CTA（买绿卖红）+ testnet 条。
- [ ] 新控件接 `ExchangeService`/`OrderRequest`（reduceOnly/trigger 已支持），**绝不下真单**，注入 mock；TDD。

### - [ ] 单元 7：Positions 屏

- [ ] 权益 surface 卡 + 账户健康条 + 分段（持仓/挂单/历史）+ 持仓卡（Long/Short tag、▲▼ PnL/ROE、Size/Entry/Mark/ROE 网格）。
- [ ] TDD（卡片、▲▼、健康条）。

### - [ ] 单元 8：Strategy(Agent) 屏

- [ ] Hero（30D return + 收益曲线）+ 模板行（Grid/DCA/TWAP/TP-SL）+ 策略卡 + 新建按钮。
- [ ] 曲线用 react-native-svg；TDD。

### - [ ] 单元 9：Wallet(Account) 屏 + 底部 Tab

- [ ] 钱包卡（非托管/地址/余额）+ Deposit/Withdraw + 未确认横幅（接 Phase 3.2）+ 设置项 + 管理。
- [ ] 底部 Tab：Markets/Trade/Positions/Strategy/Wallet 图标 + 激活态（brand）；非首页去掉 Trace。
- [ ] TDD。

### - [ ] 单元 10：全局收尾验证

- [ ] 全量 `tsc --noEmit` + `jest` 收口。
- [ ] 全仓 grep：改动 UI 源无 pictographic emoji（▲▼/◷ 允许）、无硬编码十六进制色。
- [ ] Expo 起模拟器**对照 v8.png 逐屏目检**；生产清单（IA/逻辑/安全/账本未动、字体加载、非对称警示、三主题可切）逐项自检。

---

## 完成判定（Definition of Done）

- 单元 1–10 全部打勾；`tsc` 零错、`jest` 全绿（≥ 372 + 新增）；
- 模拟器逐屏与 v8.png 视觉一致；三主题可切；非对称 testnet 警示生效；字体加载；
- IA / 业务逻辑 / Phase 2 安全 / Phase 3 编码核心 / IntentLedger 未改。
- 满足后输出最终总结并停止。

## 护栏与恢复（防失控）

- 单元粒度：一轮 = 一个单元；过大就在其下用子复选框拆分再做。
- 同一根因连续失败 2 次 → **冻结**：在「偏差记录」写根因，缩到最小失败单元，附明确验收标准后重试。
- 不删既有通过测试来过门；不为过门硬编码色或引非开源字体。
- 颜色一律走 token；▲▼ 几何非 emoji；辉光仅英雄数字一处。

---

## 偏差记录（Deviations）

> 记录任何对「不可触碰范围」的必要改动及理由，或冻结/缩范围决策。

- （暂无）

---

## Progress

> 每完成一个单元追加一行：`YYYY-MM-DD · 单元 N · 测试数 · 一句话结论`

- 2026-06-23 · 单元 0（计划创建）· — · 建立可重入计划与 10 单元拆分（v8 UI 落地，主题令牌/字体/原语/逐屏重构 + 收尾），事实源锁定 build-v8.js + v8.png，下一轮从「单元 1：主题令牌」开始。
- 2026-06-23 · 单元 1（主题令牌 warn + electrum 对齐 v8）· +3（372→375）· tokens.ts 扩展 ThemeTokens（加 surfaceAlt/lineStrong/faint/glow/warn），electrum 对齐 v8（up #37D69A、down #FF6168、warn #FFA53D 等），daylight/oscilloscope 各补协调 warn + 扩展令牌；tint 复用 color.ts withAlpha；tokens.test 断言 warn 存在/与 brand 可区分/electrum 对齐。tsc 零错、jest 全绿、无 UI 文件改动（tokens.ts 为色源，硬编码色合规）。下一轮从「单元 2：字体基座」开始。
- 2026-06-23 · 单元 2（字体基座 JetBrains Mono/Space Mono/Inter Tight）· +3（375→378）· 装 expo-font + @expo-google-fonts ×3（config plugin 注册）；fonts.ts 暴露 fonts.mono/display/body 家族名 token（纯字符串 jest 安全）+ fontAssets.ts 持 .ttf 映射（仅 App 导入、隔离不入 jest）；App.tsx useFonts(fontMap) 启动加载 + 首帧 gate（错误回退系统字体）；fonts.test 断言 token 形状/角色映射/家族唯一。tsc 零错、jest 全绿、改动文件无硬编码色/emoji。下一轮从「单元 3：共享原语」开始。
