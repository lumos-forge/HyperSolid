# 死手 app 设置 UX 设计（mobile/ RN · AgentScreen）

日期：2026-07-09
状态：已批准

## 背景

服务端已支持 scheduleCancel 死手开关的**逐 owner opt-in**（策略参数 `deadMan:true`，PR #56）：owner 有任一 running 且 `deadMan` 的策略时，后端失联超 TTL 自动撤该账户全部挂单。但 app 里无法设置——`deadMan` 目前只能经原始 `POST /strategies` API 传。本切片把 opt-in 暴露到 AgentScreen 的策略创建 UI，并诚实揭示其账户级、只撤单不平仓的语义（spec §6.1）。

**UX 难点**：`deadMan` 是逐策略参数、却产生**账户级**效果。做成逐模板开关会误导（「我给 BTC 网格开了死手」却会撤 ETH 网格）。故用**单一共享开关**并以「账户级」明确标注。

## 目标

- AgentScreen 创建区加一个共享 `deadMan` 开关（账户级），对所有模板可见，创建任一策略时并入其参数。
- 诚实揭示：账户级 + 只撤单不平仓、离线持仓仍暴露。
- 遵循门禁：色值经 `useTheme`（无硬编码 hex）；文案入 `messages.ts`（en+zh 对等）。

**非目标（YAGNI）**：不做「改既有策略的 deadMan」（server 无 params PATCH；用户可停旧策略、新建带死手的）；不做独立设置页（就近放创建区）；不改 server/controller/API（params 透传，server 已验证持久化）。

## 架构

### 1. `services/strategyApi.ts`：param 类型加 `deadMan?`

仿 server 的 `StrategyParamsCommon`：新增共享基接口，5 个 param 接口 extends 它：
```ts
export interface StrategyParamsCommon {
  /** Opt-in: while this strategy runs, arm the account-level scheduleCancel dead-man switch. */
  deadMan?: boolean;
}
export interface DcaParams extends StrategyParamsCommon { /* ...existing... */ }
export interface TwapParams extends StrategyParamsCommon { /* ... */ }
export interface TpslParams extends StrategyParamsCommon { /* ... */ }
export interface GridParams extends StrategyParamsCommon { /* ... */ }
export interface GridLimitParams extends StrategyParamsCommon { /* ... */ }
```
`createStrategy(type, params)` 与 `useStrategyController` 无需改（params 透传）。

### 2. `i18n/messages.ts`：新增文案（en + zh 对等）

en：
```ts
    "agent.deadManLabel": "Dead-man switch (account-wide)",
    "agent.deadManHint": "If the backend goes offline past its timeout, all open orders on this account are cancelled. It only cancels orders — it does not close positions, so an offline position stays exposed to the market.",
```
zh：
```ts
    "agent.deadManLabel": "死手开关（账户级）",
    "agent.deadManHint": "后端失联超时后，自动撤销本账户全部挂单。只撤单、不平仓——离线持仓仍暴露市场风险。",
```

### 3. `screens/AgentScreen.tsx`：共享开关 + 并入 create

- 新增共享状态：`const [deadMan, setDeadMan] = useState(false);`（与 `coin` 等并列）。
- 在 template picker（`</View>`，:303）之后、各模板卡片（:305 `template === "dca" ? ...`）之前，插入共享开关行（对所有模板可见）：
```tsx
      <View style={styles.deadManRow} testID="deadman-row">
        <View style={styles.deadManText}>
          <Text style={[styles.fieldLabel, { color: theme.text }]}>{t("agent.deadManLabel")}</Text>
          <Text style={[styles.deadManHint, { color: theme.muted }]}>{t("agent.deadManHint")}</Text>
        </View>
        <Toggle theme={theme} value={deadMan} onValueChange={setDeadMan} accessibilityLabel={t("agent.deadManLabel")} />
      </View>
```
（`Toggle` 已 import；样式 `deadManRow`/`deadManText`/`deadManHint` 加到本文件 `StyleSheet`，只用 theme 色值、无硬编码 hex。）
- 5 个 `onCreateX` 的参数对象各并入 `deadMan`。示例（gridLimit）：
```ts
    await ctrl.createGridLimit({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel, mode: glMode, deadMan });
```
dca/twap/tpsl/grid 同理各加 `deadMan`。

## 关键取舍

- **单一共享开关（账户级）**：契合账户级语义，避免逐模板误导；一个开关应用于正在创建的策略。默认关（opt-in）。
- **对所有模板可见**：账户级死手保护账户全部挂单（含其它策略/手动单），与具体模板无关；诚实标签已界定。
- **只做创建时设置**：不做既有策略改 deadMan（YAGNI，无 server 支持）。
- **诚实揭示**（spec §6.1）：hint 明说「只撤单不平仓、离线持仓仍暴露」。

## 测试

- **`AgentScreen.test`**：
  - 死手开关渲染（`testID="deadman-row"` 存在；label 文案）。
  - 打开开关后创建策略（mock controller 的 create 方法）→ 断言 create 收到的 params 含 `deadMan: true`。
  - 默认（未打开）创建 → params 的 `deadMan` 为 false/undefined（未启用）。
- **`messages.test`**：新增 key en+zh 对等（既有 parity 测试自动覆盖）。
- **`noHardcodedColors.test`**：新增样式无硬编码 hex（既有 guard 自动覆盖）。

## 门禁

`cd mobile && npx tsc --noEmit && npx jest`（含 `npx jest noHardcodedColors` 与 `npx jest messages`）。

## 任务拆分

2 个 task：
1. `services/strategyApi.ts` param 类型加 `deadMan?`（共享基）+ `i18n/messages.ts` 文案（en+zh）。
2. `screens/AgentScreen.tsx`：共享开关状态+UI + 5 个 create 并入 `deadMan` + `AgentScreen.test` 断言。
