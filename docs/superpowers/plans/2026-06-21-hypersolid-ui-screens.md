# HyperSolid 全部 UI 页面实现计划（continuous-agent-loop）

> **驱动方式：** 本计划由 `continuous-agent-loop`（sequential + quality gates）逐单元推进。
> 每一轮（iteration）只完整交付**一个**未打勾单元：TDD → 实现 → 质量门 → 自检 → 打勾 → 停。
> 这是**可重入**计划——每轮先读本文件，选第一个未打勾单元，不假设从零开始。
> 子技能建议：superpowers:subagent-driven-development 或 superpowers:test-driven-development。

**目标：** 让 `mobile/` 内全部 7 个屏幕的 UI 与设计稿严格一致，统一示波器/磷光视觉语言与单线图标系统，全程 tsc 零错 + jest 全绿。

---

## 设计唯一事实源（必须严格对齐，禁止自由发挥）

- 总览图：`docs/design/renders/allscreens.png`
- 逐屏精确布局/文案/数据：`docs/design/renders/build-allscreens.js`
  - 函数 `markets()` / `detail()` / `trade()` / `positions()` / `agent()` / `accountOnboard()` / `accountConnected()` 即每屏规格
- 图标：只能用 `mobile/src/components/Icon.tsx` 里的 `<Icon name=.../>`，**禁止 emoji**
  - 可用 name：`markets` `trade` `positions` `agent` `account` `star` `key` `alert` `swap` `chevron` `arrowRight` `eye` `lock`
  - 设计稿用到但 `Icon.tsx` 暂缺的图标（如 `search`）须先在单元 1 补进 `Icon.tsx`
- 颜色/字体：只能用 `mobile/src/theme/tokens.ts` 的主题 token（`bg/surface/line/text/muted/brand/up/down`），**禁止硬编码十六进制色值**
  - 颜色一律走 token，使三套主题（electrum/daylight/oscilloscope）通用；`allscreens.png` 仅是 oscilloscope 调色，结构与主题无关
- 信息架构：5 个底部 Tab（行情 Markets / 交易 Trade / 持仓 Positions / 策略 Agent / 钱包 Account），**Trade 为独立 Tab**
- 写任何 Expo/RN 代码前，先读 `mobile/AGENTS.md` 与 https://docs.expo.dev/versions/v56.0.0/

## 不可触碰 / 范围边界

- 不改与 UI 无关的业务逻辑（`services/` `lib/` `wallet/` `state/`）；如必须改，先在本文件「偏差记录」区写明理由
- 不删既有通过的测试来「过门」；不为通过而 mock 掉真实断言
- 不做真机部署、真实 testnet 下单等需人工交互的步骤
- 基线：当前 121 个单测通过、tsc 零错。任何一轮结束都不得让其下降。

---

## 每一轮的固定流程（严格按序）

1. 读本文件，选**第一个未打勾**单元；若全部已打勾 → 跳到「完成判定」。
2. 把该单元标题标记为进行中（可在本行后追加「（进行中）」）。
3. **TDD**：先写/扩展该屏或组件的 `*.test.tsx`，断言关键文案、结构、token 颜色、`<Icon>` 存在；先看它失败。
4. **实现**：新建/修改对应组件与屏，严格对齐 design 事实源；复用单元 1 的共享外壳组件，保持 DRY。
5. **质量门**（全部必须通过，否则**不许打勾**）：
   - `cd mobile && npx tsc --noEmit` → 零错误
   - `cd mobile && npx jest` → 全绿，且 ≥ 121 + 本单元新增测试数
   - grep 确认改动文件**无 emoji 字形、无硬编码十六进制色值**
6. **自检对照**：逐项对照 `build-allscreens.js` 中该屏函数（布局块 / 文案 / 数据 / 图标 / 状态色）。
7. 把该单元打勾，并在本文件底部「Progress」区追加一行：日期 + 单元 + 测试数 + 一句话结论。
8. **停止本轮**（一轮只完整交付一个单元）。

---

## 单元清单（按顺序执行）

### - [x] 单元 1：共享外壳组件（先做，保证全局风格统一且 DRY）

**目的：** 抽出各屏复用的磷光外壳，避免每屏重复样式、防止风格漂移。
**文件（新建于 `mobile/src/components/`，各配 `*.test.tsx`）：**

- [x] `Trace.tsx` —— 顶部磷光波形头（SVG 波形，`brand`/`hi` 描边，底部 `line` 分隔）
- [x] `StatusRow.tsx` —— 顶部状态栏行：左 `9:41`、中标题（如 `HYPERSOLID`）、右状态 `Pill`
- [x] `Pill.tsx` —— 胶囊标签，支持中性（brand 底）与 `up`（绿底）变体（如 `◷ TESTNET` / `◉ ARMED`）
- [x] `SectionLabel.tsx` —— 字距加宽的小节标题（如 `盘口 ORDERBOOK` / `STRATEGIES`）
- [x] `Toggle.tsx` —— 方形开关（off=`line`，on=`brand`+辉光），用于策略行
- [x] `Chip.tsx` —— 周期/筛选小药丸（选中=`brand` 实底，未选=`line` 描边），用于 1H/4H/1D/1W
- [x] `ScreenScaffold.tsx` —— 组合 `Trace?` + `StatusRow` + 可滚动内容容器（统一 `bg`、内边距、SafeArea）
- [x] 补图标：在 `Icon.tsx` 增加设计稿用到但缺失的 `search`（放大镜：`<circle cx=10.5 cy=10.5 r=6.5/><path d="M20 20 15.5 15.5"/>`），并补一条 `Icon` 渲染断言测试

**验收：** 组件以 `ThemeTokens` 为 prop 或经 `useTheme()` 取色，零硬编码色；各组件至少 1 个渲染/交互测试通过。
**实现说明：** 颜色翻译需要的半透明（如 Pill 底色、Toggle 辉光）通过新增 `theme/color.ts` 的 `withAlpha(token, a)` 从 token 派生，不引入新色值；字体保持系统默认（App 未加载 Space Mono/JetBrains Mono），仅用字重/字距还原观感。

### - [x] 单元 2：行情 Markets（对齐 `markets()`）

- [x] 用 `ScreenScaffold` + `Trace` + `StatusRow`(`HYPERSOLID` / `◷ TESTNET`)
- [x] `SIGNAL · LIVE` readout + 圆点
- [x] 搜索框：`<Icon name="search"/>` + 占位文案 `search markets`
- [x] 全部 / 自选 段控（沿用现有 `MarketsScreen` 行为）
- [x] 币种行复用 `MarketRow`（已含 `star` 图标 + 涨跌色），核对与设计稿一致
- [x] **验收：** 现有 `MarketsScreen.test.tsx` 仍通过 + 新增外壳断言
**实现说明：** 状态栏 Pill 显示真实网络（`◷ ${network}`，非硬编码 TESTNET）；搜索框做成可用 `TextInput`（按 coin 子串过滤，纯 UI 层、不动 services）；设计稿用 `Markets` 大标题被 `HYPERSOLID` 状态栏取代，故 `RootNavigator.test` 的默认 Tab 标记从 `Markets` 改为唯一标记 `SIGNAL · LIVE`（语义不变，非过门）。

### - [x] 单元 3：详情 Market Detail（对齐 `detail()`）

- [x] 返回区 `<Icon name="chevron"/>` + `BTC-PERP`
- [x] 大价格 + 涨跌（`up`/`down` token）
- [x] 周期 `Chip`：1H/4H/1D/1W
- [x] K 线区（复用 `Sparkline`，网格背景用 token）
- [x] 6 项 `StatGrid`（标记价/24h 涨跌/资金费/24h 量/最大杠杆/前日价）
- [x] 盘口 `OrderbookView` + `SectionLabel`
- [x] 去交易 CTA：文案 + `<Icon name="arrowRight"/>`（已落地，核对样式）
**实现说明/偏差：**（1）原生 stack header 与设计的内嵌返回栏重复 → 在 `MarketsStack` 给 MarketDetail 设 `headerShown:false`，改由 `ScreenScaffold.statusLeft`（chevron + `coin-PERP`，点按 `navigation.goBack()`）+ 右侧涨跌 `Pill`（新增 `down` 变体）呈现。（2）周期 `Chip` 仅本地选中态，未驱动重新拉取 K 线（属 service 层，留 `// TODO`，不在本单元改 services）。（3）保留既有「最近成交 TRADES」实时区（设计稿因手机尺寸未含）——属 UI 增量，不与设计冲突。（4）K 线网格图案简化为描边卡片（避免引入图案绘制依赖）。

### - [x] 单元 4：交易 Trade（对齐 `trade()`）

- [x] `ScreenScaffold` + 标题「交易 Trade」+ 网络提示行
- [x] 买入/做多 · 卖出/做空 双段（选中用 `up`/`down`）
- [x] 标的 / 数量 / 价格 字段 + 当前价 hint
- [x] 名义价值（`< $10` 用 `down` 警示）+ 提交订单按钮
- [x] **验收：** 保留现有下单业务逻辑（不改 `services/exchange`、`lib/order`），仅对齐 UI 外壳
**实现说明：** 用 `ScreenScaffold`(statusTitle=HYPERSOLID + 动态网络 `Pill` + heading=交易 Trade) 取代手写 ScrollView/title；未连接 / 只读两态也包进同一外壳。下单逻辑（`onSubmit`/`validateOrder`/`ExchangeService`/`canSubmit`）原样保留。

### - [x] 单元 5：持仓 Positions（对齐 `positions()`）

- [x] view-only 提示：`<Icon name="eye"/>` + 文案（已落地，核对）
- [x] 地址输入 + 查询按钮
- [x] 权益 / 可提现 / 未实现盈亏 汇总（盈亏走 `up`/`down`）
- [x] 持仓行复用 `PositionRow`
**实现说明：** 用 `ScreenScaffold`(statusTitle=HYPERSOLID + 动态网络 `Pill` + heading=持仓 Positions) 取代手写 ScrollView/title；view-only 查询逻辑（`useViewOnlyPortfolio`/`PositionsService`/`load`）原样保留，仅改 UI 外壳。

### - [x] 单元 6：策略 Agent（对齐 `agent()`，替换当前占位页）

- [x] 把 `AgentScreen` 从 `BoardPlaceholder` 换成完整 UI（`Trace` + `StatusRow` `YOUR AGENT` / `◉ ARMED` Pill）
- [x] `PHOSPHOR TRACE · ACTIVE` 头卡 + 说明（trade-only · 无提现权限 · 离线也运行）
- [x] `SectionLabel` STRATEGIES + 策略行（TP-SL / GRID / DCA）+ `Toggle`
- [x] GUARDRAILS 行（max 5× · 日内 −$200）
- [x] KILL SWITCH（`down`）/ 新建 按钮
- [x] **本轮只做 UI 外壳 + mock 数据；自动化执行逻辑用 `// TODO` 标注，禁止伪造真实下单/自动化**
**实现说明：** 策略数据为本地 mock 常量，开关用本地 `useState`（不连真实策略/执行层）；KILL SWITCH 与 + 新建 仅 `// TODO` 占位，无任何真实下单/自动化。`◉`/`▮` 为几何字符（非 emoji，过 grep gate）。旧 `BoardPlaceholder` 组件保留未删（其他无引用，留作后续占位用）。

### - [x] 单元 7：钱包 Account 两态（对齐 `accountOnboard()` + `accountConnected()`）

- [x] 未连接：创建（`star`）/ 助记词恢复（`key`）/ 只读进入（`eye`）（已落地，核对外壳与 design 一致）
- [x] 已连接：钱包卡（`lock`）+ 助记词备份警示（`alert`）+ 网络切换（`swap`）+ 退出
- [x] 统一改用 `ScreenScaffold`，与其余屏外壳一致
**实现说明：** 两态均改用 `ScreenScaffold`(statusTitle=HYPERSOLID + 动态网络 `Pill` + heading)；onboard 两处小节标题改用 `SectionLabel`。钱包逻辑（`WalletManager`/`onCreate`/`onRestore`/`onViewOnly`/`onSignOut`）原样保留。

### - [x] 单元 8：全局收尾验证

- [x] 底部导航在每屏正确高亮当前 Tab（含 Detail 属于 Markets 栈时仍高亮行情）
- [x] 全仓 grep：`mobile/src` 业务代码无 emoji 字形、无硬编码十六进制色值
- [x] 重渲染 `docs/design/renders/allscreens.png` 与实现做最终肉眼对照（可选）
- [x] 全量 `tsc --noEmit` + `jest` 收口
**实现说明：** 导航高亮由 `RootNavigator` 配置保证（`tabBarActiveTintColor=brand`、`Icon active={focused}`；MarketDetail 在 `MarketsStack` 内故 Detail 屏仍高亮「行情」）。全仓非测试源零 emoji（含 ←→ 箭头区）、screens/components 零硬编码十六进制色（仅 `theme/tokens.ts` 持有调色板，符合预期）。7 屏 + 导航 + 7 个外壳组件均有渲染测试，`tsc` 零错、`jest` 166 全绿。可选的「allscreens.png 重渲染」跳过：该图为设计源（重渲染仅复现同一稿），实现对齐已在单元 2–7 各自自检完成。

---

## 完成判定（Definition of Done）

- 单元 1–8 全部打勾；`tsc` 零错、`jest` 全绿（≥ 121 + 新增）；
- 7 屏均与设计事实源一致；仍无 emoji、无硬编码色；底部导航在每屏正确高亮当前 Tab。
- 满足后输出最终总结并停止，不再开新工作。

## 护栏与恢复（防止 loop 失控）

- 单元粒度：一轮 = 一个单元；单元过大就在其下用子复选框拆分再做。
- 同一根因连续失败 2 次 → **冻结**：在「偏差记录」写下根因，把范围缩到最小失败单元，附明确验收标准后重试。
- 参考已知坑：jest setup 用 `@testing-library/react-native` v14 内置 matchers（无 `setupFilesAfterEnv`、不引用已废弃的 `@testing-library/jest-native`）；`react-test-renderer` 锁定与 react 完全一致版本。

---

## 偏差记录（Deviations）

> 记录任何对「不可触碰范围」的必要改动及理由，或冻结/缩范围决策。

- （暂无）

---

## Progress

> 每完成一个单元追加一行：`YYYY-MM-DD · 单元 N · 测试数 · 一句话结论`

- 2026-06-21 · 单元 0（计划创建）· — · 建立可重入计划与单元拆分，下一轮从「单元 1：共享外壳组件」开始。
- 2026-06-21 · 单元 1（共享外壳组件）· +24（121→145）· 新增 Trace/StatusRow/Pill/SectionLabel/Toggle/Chip/ScreenScaffold + withAlpha 工具 + Icon 补 search；tsc 零错、jest 全绿、新源文件零 emoji/零硬编码色。下一轮从「单元 2：行情 Markets」开始。
- 2026-06-21 · 单元 2（行情 Markets）· +3（145→148）· MarketsScreen 改用 ScreenScaffold+Trace+StatusRow+Pill(动态网络)+SIGNAL·LIVE readout+可用搜索框；RootNavigator 默认 Tab 标记改为 SIGNAL·LIVE；tsc 零错、jest 全绿、零 emoji/硬编码色。下一轮从「单元 3：详情 Market Detail」开始。
- 2026-06-21 · 单元 3（详情 Market Detail）· +5（148→153）· MarketDetailScreen 改用 ScreenScaffold + 内嵌返回栏(chevron/goBack) + 涨跌 Pill(新增 down 变体) + 大价格 + 1H/4H/1D/1W Chip + Sparkline 卡片 + StatGrid + SectionLabel + OrderbookView + 去交易 CTA；MarketDetail 关闭原生 header；周期切换留 TODO；保留实时 Trades 区。tsc 零错、jest 全绿、零 emoji/硬编码色。下一轮从「单元 4：交易 Trade」开始。
- 2026-06-21 · 单元 4（交易 Trade）· +4（153→157）· TradeScreen 改用 ScreenScaffold(HYPERSOLID + 动态网络 Pill + heading) 取代手写 ScrollView/title；买卖双段/字段/当前价/名义价值/提交订单 对齐 trade()；下单业务逻辑原样保留。tsc 零错、jest 全绿、零 emoji/硬编码色。下一轮从「单元 5：持仓 Positions」开始。
- 2026-06-21 · 单元 5（持仓 Positions）· +2（157→159）· PositionsScreen 改用 ScreenScaffold(HYPERSOLID + 动态网络 Pill + heading)；eye 提示/地址查询/权益·可提现·盈亏汇总/PositionRow 对齐 positions()；view-only 查询逻辑原样保留。tsc 零错、jest 全绿、零 emoji/硬编码色。下一轮从「单元 6：策略 Agent」开始。
- 2026-06-21 · 单元 6（策略 Agent）· +4（159→163）· AgentScreen 从 BoardPlaceholder 占位页替换为完整 UI：Trace + YOUR AGENT/◉ ARMED Pill + PHOSPHOR TRACE·ACTIVE 头卡 + STRATEGIES(TP/SL·GRID·DCA + Toggle, mock+本地态) + GUARDRAILS + KILL SWITCH/新建（仅 TODO，无真实自动化）。tsc 零错、jest 全绿、零 emoji/硬编码色。下一轮从「单元 7：钱包 Account 两态」开始。
- 2026-06-21 · 单元 7（钱包 Account 两态）· +3（163→166）· AccountScreen 未连接/已连接两态均改用 ScreenScaffold(HYPERSOLID + 动态网络 Pill + heading)，onboard 小节标题改 SectionLabel；star/key/eye/lock/alert/swap 图标与 design 对齐；钱包逻辑原样保留。tsc 零错、jest 全绿、零 emoji/硬编码色。下一轮从「单元 8：全局收尾验证」开始。
- 2026-06-21 · 单元 8（全局收尾验证）· 166（无新增）· 导航高亮 config 验证（active tint + Icon active={focused}，Detail 在 MarketsStack 仍高亮行情）；全仓非测试源零 emoji、screens/components 零硬编码十六进制色（仅 tokens.ts 持调色板）；7 屏+导航+7 外壳组件均有测试，tsc 零错、jest 166 全绿。**全部 8 单元完成，Definition of Done 达成。**
