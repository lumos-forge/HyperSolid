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

### - [x] 单元 3：共享原语

- [x] `PriceText`（mono tabular + 可选英雄辉光 glow/glowColor）/`ChangeText`（▲▼ 几何字符 + 带符号 pct + up/down 色）。
- [x] `SurfaceCard`（surface 底 + lineStrong 描边 + 顶部 3px brand 细线，非品牌色铺底）。
- [x] `NetworkWarning`（非对称：testnet chip + 警示条按 `envStore.network`，自读 useTheme/useEnvStore；mainnet 不渲染）。
- [x] TDD 各组件（▲▼/up·down 色/辉光、卡片结构与 rule、警示按 network 显隐与 warn 描边）。

### - [x] 单元 4：Markets 屏

- [x] 简洁列表（星标 / 代号 PERP / Fund·Vol / 价格 / ▲▼）+ 搜索（Search markets）+ All/Watchlist + 警示 chip（仅 testnet）。
- [x] MarketRow 重构为 v8（PERP tag、Fund·Vol 子行、PriceText/ChangeText、formatVol）；接真实 marketStore；去 Trace/SIGNAL/HYPERSOLID；NetworkWarning chip 非对称；TDD（行渲染、▲▼ 标记、警示按 network、搜索过滤）。

### - [x] 单元 5：Market Detail 屏

- [x] 报价块（英雄价 PriceText 辉光 + ChangeText ▲▼ + Mark）+ 统计网格（24h high/low 由 candles 推导、24h vol、Funding+倒计时、Max leverage）+ 周期选择（1H/4H/1D/1W）+ K 线（CandleChart：brand 网格 + 涨跌蜡烛 + 当前价虚线 + 价轴标签 + 价格徽标）+ 委托簿/最新成交 Tab + CTA Trade + testnet 警示条（NetworkWarning strip）。
- [x] CandleChart 用 react-native-svg；TDD 关键元素与文案（detail 屏 + CandleChart 组件）。

### - [x] 单元 6：Trade 屏

- [x] 买/卖（Buy/Long·Sell/Short）+ 类型（Limit/Market）+ 杠杆可调（按 maxLeverage chips）+ 价/量 + Reduce-only/Post-only(Toggle) + TP/SL（Optional 输入）+ 摘要 SurfaceCard（Order value/Leverage/Est. liq）+ 动态 CTA（买绿卖红「Buy/Long BTC」）+ testnet 警示条。
- [x] 新控件接既有服务：reduceOnly/market/tif(Alo=post-only) 进 placeOrder；TP/SL 走**新增 `ExchangeService.placeBracket`**（复用既有 `buildBracketOrder` 编码核心 + 同一 cloid 幂等/不确定回执管线，TDD）；**绝不下真单**，注入 mock；既有下单幂等逻辑/testID/告警文案逐字保留。

### - [x] 单元 7：Positions 屏

- [x] 权益 SurfaceCard（Equity·USDC 英雄辉光 + Available/Unrealized PnL/Margin ratio + 账户健康条按 margin ratio 着色/Healthy·Caution·At risk）+ 分段（Positions·N / Orders·N / Fills·N）+ 持仓卡 PositionRow（coin·PERP、Long/Short·lev tag、▲▼ PnL、Size/Entry/Mark/ROE 网格）。
- [x] 保留 view-only 组合查询（useViewOnlyPortfolio/loadRecent/loadOpenOrders）与未确认横幅；chrome/banner/copy 英文化；TDD（chrome、健康卡、Tab 切换、持仓卡）。

### - [x] 单元 8：Strategy(Agent) 屏

- [x] Hero SurfaceCard（30D strategy return「+7.06%」+ N running·risk-bounded + ReturnCurve 收益曲线）+ 模板行（Grid/DCA/TWAP/TP-SL，含图标）+ 策略卡（图标 + 名称 + 描述 + ▲▼ 收益 + Toggle 启停）+ New strategy CTA。
- [x] 新增 ReturnCurve（react-native-svg 面积+线）+ Icon 补 grid/repeat/bolt/shield/plus/chevronRight；TDD（曲线空态/绘制、Icon 全量、hero/模板/策略/新建/Toggle 联动 running 数）。

### - [x] 单元 9：Wallet(Account) 屏 + 底部 Tab

- [x] 钱包 SurfaceCard（Local wallet/View-only + Non-custodial badge + 短地址 + Balance 英雄辉光）+ Deposit/Withdraw 入口 + 未确认横幅（接 Phase 3.2 UnconfirmedBanner）+ Account summary/Funding 卡 + 助记词备份卡 + 设置项（Network 切换 / Theme 循环三主题）+ Sign out；onboarding（Create/Restore/View-only）英文化重构。保留全部钱包逻辑（create/restore/viewOnly/signOut + summary/funding 加载）。
- [x] 底部 Tab 英文化 Markets/Trade/Positions/Strategy/Wallet + 激活态（brand，focused 实心）；非首页无 Trace。TDD（onboarding/connected/view-only/summary/funding + 导航 5 Tab）。

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

> 单元 3：v8 Markets 警示 chip 原设计为「warn 实底 + 深色文字 (#241400)」。深色文字在三套主题（含 daylight 浅底）上无法保证对比；为生产对比安全，改为「warn 描边 + warn 文字 + warn 16% 底」的同色调 chip，与警示条统一。属视觉等价的主题安全适配，语义/非对称行为不变。

> 单元 5：Market Detail 部分 v8 区块依赖现有数据模型没有的字段，为「不改业务逻辑 + 不编造数据」而诚实省略：① Open interest（MarketTicker 无 OI）；② 多周期涨跌 7D/30D/90D/180D/1Y（无历史，仅 24h 可由 candles 推）；③ 指标 Tab（无指标计算管线，避免装饰性失效控件）；④ 多空比条 L/S（无持仓分布数据）；⑤ 周期保留功能性的 1H/4H/1D/1W（service 当前固定 interval）。以上需 service 层扩展，列为后续；24h high/low 由 candles 诚实推导，资金费倒计时按 UTC 整点实时计算。

> 单元 9：Deposit/Withdraw 为非托管资金进出入口（用户 P1 要求补足），但真实转账流程（桥充值 / HL 提现）尚未实现，按「不做失效死按钮」原则当前点击弹出诚实说明 Alert（即将上线）。待接入真实流程后替换。钱包安全/创建/恢复/签出逻辑与未确认横幅内核未改。

> 单元 8：Strategy 为 mock UI 壳（既有 TODO，无真实策略/收益数据流）。按 v8 事实源严格对齐，去掉旧版自由发挥的 Kill switch / Guardrails 行（v8 strategy 无此区块）；hero「+7.06%」与策略卡收益为壳层占位（延续既有 mock 约定，待接真实 agent/策略存储后替换）。Toggle 启停为本地状态，未接执行层（既有 TODO 保留）。

> 单元 6：① 百分比滑杆省略——真实功能需账户可用余额，TradeScreen 当前不取持仓/权益数据，注入会引入新数据流（越界）；列为后续（接 positionsData/权益后补）。② 杠杆为票据「意向杠杆」，驱动 Est. liq 估算与摘要展示，**不**自动调用链上 setLeverage（那是独立动作，隐式调用属逻辑改动）。③ 类型仅 Limit/Market（干净映射 OrderRequest.market）；Stop 触发单语义另需触发价 UX，暂缓。④ TP/SL 已通过新增 service 层 `placeBracket`（复用 lib 既有 `buildBracketOrder`，未改编码核心）真实下达括号单。告警文案保持中文（与不可改的 rejectionMessage 一致）。

---

## Progress

> 每完成一个单元追加一行：`YYYY-MM-DD · 单元 N · 测试数 · 一句话结论`

- 2026-06-23 · 单元 0（计划创建）· — · 建立可重入计划与 10 单元拆分（v8 UI 落地，主题令牌/字体/原语/逐屏重构 + 收尾），事实源锁定 build-v8.js + v8.png，下一轮从「单元 1：主题令牌」开始。
- 2026-06-23 · 单元 1（主题令牌 warn + electrum 对齐 v8）· +3（372→375）· tokens.ts 扩展 ThemeTokens（加 surfaceAlt/lineStrong/faint/glow/warn），electrum 对齐 v8（up #37D69A、down #FF6168、warn #FFA53D 等），daylight/oscilloscope 各补协调 warn + 扩展令牌；tint 复用 color.ts withAlpha；tokens.test 断言 warn 存在/与 brand 可区分/electrum 对齐。tsc 零错、jest 全绿、无 UI 文件改动（tokens.ts 为色源，硬编码色合规）。下一轮从「单元 2：字体基座」开始。
- 2026-06-23 · 单元 2（字体基座 JetBrains Mono/Space Mono/Inter Tight）· +3（375→378）· 装 expo-font + @expo-google-fonts ×3（config plugin 注册）；fonts.ts 暴露 fonts.mono/display/body 家族名 token（纯字符串 jest 安全）+ fontAssets.ts 持 .ttf 映射（仅 App 导入、隔离不入 jest）；App.tsx useFonts(fontMap) 启动加载 + 首帧 gate（错误回退系统字体）；fonts.test 断言 token 形状/角色映射/家族唯一。tsc 零错、jest 全绿、改动文件无硬编码色/emoji。下一轮从「单元 3：共享原语」开始。
- 2026-06-23 · 单元 3（共享原语 PriceText/ChangeText/SurfaceCard/NetworkWarning）· +15（378→393）· PriceText 改 mono tabular + 可选英雄辉光（textShadow，仅传 glowColor 时启用）；ChangeText 新增（▲▼ 几何 + 带符号 pct + up/down 色 + mono bold）；SurfaceCard 新增（surface + lineStrong 描边 + 3px brand 顶线 + overflow hidden）；NetworkWarning 新增（自读 envStore/useTheme，testnet→chip/strip，mainnet→null，warn token tint/描边 + alert 图标 + 诚实文案）。TDD 各组件全绿；tsc 零错、jest 全绿、4 文件无硬编码色/pictographic emoji（▲▼ 几何允许）。chip 同色调适配见偏差记录。下一轮从「单元 4：Markets 屏」开始。
- 2026-06-23 · 单元 4（Markets 屏 v8 重构）· +2（393→395）· MarketsScreen 去 Trace/SIGNAL·LIVE/HYPERSOLID，标题改 Markets、网络警示用 NetworkWarning chip（非对称，mainnet 静默）、搜索 Search markets、Tab All/Watchlist（Space Mono）；MarketRow 重构为 v8（PERP tag、Fund·Vol 子行、PriceText + ChangeText ▲▼、新增 formatVol 紧凑量）；同步更新 MarketRow/MarketsScreen/RootNavigator 测试到 v8 契约。tsc 零错、jest 全绿、改动文件无硬编码色/emoji、IA/逻辑未动。下一轮从「单元 5：Market Detail 屏」开始。
- 2026-06-23 · 单元 5（Market Detail 屏 v8 重构 + CandleChart）· +3（395→398）· 新增 CandleChart（react-native-svg：brand 网格 + 涨跌蜡烛 + 当前价虚线 + 价轴标签 + 价格徽标，TDD 空态/绘制/轴标签）；MarketDetailScreen 重构为 v8：报价块（PriceText 英雄辉光 + ChangeText ▲▼ + Mark）、统计网格（24h high/low 由 candles 推、vol、Funding+UTC 整点倒计时、Max leverage）、TF 选择、CandleChart、Order book/Trades Tab、CTA Trade、NetworkWarning strip（非对称）；保留 useLiveDetail 实数据接线。诚实省略 OI/多周期/指标 Tab/多空条（数据缺失，见偏差记录）。tsc 零错、jest 全绿、改动文件无硬编码色/emoji、IA/逻辑未动。下一轮从「单元 6：Trade 屏」开始。
- 2026-06-23 · 单元 6（Trade 屏 v8 重构 + placeBracket）· +5（398→403）· ExchangeService 新增 placeBracket（复用 lib buildBracketOrder + 抽出共享 submitBuilt 幂等管线，placeOrder 行为不变，TDD ×3）；TradeScreen 重构为 v8：Buy/Long·Sell/Short 段、Limit/Market 类型、杠杆 chips、价/量、Reduce-only/Post-only Toggle、TP/SL Optional（走 placeBracket）、摘要 SurfaceCard、动态 CTA（买绿卖红）、testnet 警示条；reduceOnly/market/tif(Alo) 接 placeOrder。既有下单幂等/不确定回执/testID/中文告警逐字保留（13 旧测试全绿）+ 2 新 wiring 测试。诚实省略百分比滑杆（需余额）、不自动 setLeverage（见偏差记录）。tsc 零错、jest 全绿、改动文件无硬编码色/emoji、IA/编码核心未改。下一轮从「单元 7：Positions 屏」开始。
- 2026-06-23 · 单元 7（Positions 屏 v8 重构）· +0（403，改写未加净测试）· PositionRow 重构为 v8 卡（SurfaceCard：coin·PERP + Long/Short·lev tag + ▲▼ PnL + Size/Entry/Mark/ROE 网格，Mark=positionValue/size、ROE 由 marginUsed 推）；PositionsScreen 加权益 SurfaceCard（Equity 英雄辉光 + Available/Unrealized PnL/Margin ratio + 健康条按 margin ratio 着色与 Healthy/Caution/At risk）、分段 Positions·N/Orders·N/Fills·N、英文化 chrome/banner/query；保留 view-only 查询与未确认横幅逻辑。tsc 零错、jest 全绿、改动文件无硬编码色/emoji、IA/逻辑未动。下一轮从「单元 8：Strategy(Agent) 屏」开始。
- 2026-06-23 · 单元 8（Strategy/Agent 屏 v8 重构 + ReturnCurve）· +2（403→405）· 新增 ReturnCurve（react-native-svg 面积+线，TDD 空态/绘制）+ Icon 补 grid/repeat/bolt/shield/plus/chevronRight；AgentScreen 重构为 v8：标题 Strategy + NetworkWarning chip、Hero SurfaceCard（30D return +7.06% + N running·risk-bounded + 收益曲线）、Templates 行、My strategies 策略卡（图标+名+描述+▲▼ 收益 + Toggle 启停联动 running 数）、New strategy CTA；按严格对齐 v8 去掉旧 Kill switch/Guardrails（见偏差记录）。tsc 零错、jest 全绿、改动文件无硬编码色/emoji。下一轮从「单元 9：Wallet(Account) 屏 + 底部 Tab」开始。
- 2026-06-23 · 单元 9（Wallet/Account 屏 v8 重构 + 底部 Tab 英文化）· +0（405，改写未加净测试）· AccountScreen 重构为 v8：标题 Wallet + NetworkWarning chip、未确认横幅、钱包 SurfaceCard（Local/View-only + Non-custodial + 短地址 + Balance 英雄辉光）、Deposit/Withdraw 入口（暂为诚实占位 Alert，见偏差记录）、Account summary/Funding 卡、助记词备份卡、设置项 Network 切换 + Theme 循环三主题、Sign out；onboarding Create/Restore/View-only 英文化；全部钱包逻辑保留。RootNavigator Tab 英文化 Markets/Trade/Positions/Strategy/Wallet（激活态 brand）。tsc 零错、jest 全绿、改动文件无硬编码色/emoji、钱包安全逻辑未改。下一轮从「单元 10：全局收尾验证」开始。
