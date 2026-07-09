# 死手 app 设置 UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AgentScreen 加一个账户级「死手开关」toggle，创建策略时把 `deadMan:true` 并入参数，并诚实揭示只撤单不平仓。

**Architecture:** mobile 策略 param 类型加共享 `deadMan?`；AgentScreen 加一个共享 `deadMan` 状态 + Toggle（template picker 之后，对所有模板可见），5 个 create 用条件 spread `...(deadMan ? {deadMan:true} : {})` 并入参数；文案入 i18n（en+zh）。server/controller/API 不变（params 透传，已验证持久化）。

**Tech Stack:** Expo RN + TS、@testing-library/react-native、Jest。gate：`cd mobile && npx tsc --noEmit && npx jest`（含 `noHardcodedColors` + `messages`）。

---

## File Structure

- `mobile/src/services/strategyApi.ts` — 5 个 param 接口 extends 新增 `StrategyParamsCommon { deadMan?: boolean }`。
- `mobile/src/i18n/messages.ts` — `agent.deadManLabel` / `agent.deadManHint`（en + zh）。
- `mobile/src/screens/AgentScreen.tsx` /（既有）`.test.tsx` — 共享 `deadMan` 状态 + Toggle UI + 5 个 create 条件并入 + 测试。

---

## Task 1: 类型 `deadMan?` + i18n 文案

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/i18n/messages.ts`

依赖：无。

### 背景（当前 strategyApi.ts:5-22）
5 个 param 接口（DcaParams/TwapParams/TpslParams/GridParams/GridLimitParams）各自独立，无共享基。messages.ts 有 `en:`（:10 起）与 `zh:`（:477 起）两块，agent.* 键（如 `"agent.invalidParams"`/`"agent.invalidParamsBody"`）在两块都有；`messages.test.ts` 强制 en/zh 键对等。

- [ ] **Step 1: 给 strategyApi.ts 加共享基并让 5 个接口 extends 它**

在 `DcaParams` 定义之前插入：
```ts
export interface StrategyParamsCommon {
  /** Opt-in: while this strategy runs, arm the account-level scheduleCancel dead-man switch. */
  deadMan?: boolean;
}
```
把 5 个接口声明头改为 extends（字段不动）：
```ts
export interface DcaParams extends StrategyParamsCommon {
```
```ts
export interface TwapParams extends StrategyParamsCommon {
```
```ts
export interface TpslParams extends StrategyParamsCommon {
```
```ts
export interface GridParams extends StrategyParamsCommon {
```
```ts
export interface GridLimitParams extends StrategyParamsCommon {
```

- [ ] **Step 2: 在 messages.ts 的 en 块加两键**

在 `en:` 块内、`"agent.invalidParamsBody": ...` 那一行之后加：
```ts
    "agent.deadManLabel": "Dead-man switch (account-wide)",
    "agent.deadManHint": "If the backend goes offline past its timeout, all open orders on this account are cancelled. It only cancels orders — it does not close positions, so an offline position stays exposed to the market.",
```

- [ ] **Step 3: 在 messages.ts 的 zh 块加对等两键**

在 `zh:` 块内、对应的 zh `"agent.invalidParamsBody": ...` 那一行之后加：
```ts
    "agent.deadManLabel": "死手开关（账户级）",
    "agent.deadManHint": "后端失联超时后，自动撤销本账户全部挂单。只撤单、不平仓——离线持仓仍暴露市场风险。",
```

- [ ] **Step 4: 运行确认 typecheck + messages 对等**

Run: `cd mobile && npx tsc --noEmit && npx jest messages`
Expected: tsc 无错；messages 测试 PASS（en/zh 新键对等）。

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add mobile/src/services/strategyApi.ts mobile/src/i18n/messages.ts
git commit --no-verify -m "feat(mobile): strategy deadMan param type + dead-man i18n strings

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: AgentScreen 共享 toggle + create 并入 + 测试

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx`
- Test: `mobile/src/screens/AgentScreen.test.tsx`

依赖：Task 1（`deadMan?` 类型 + i18n 键）。

### 背景（当前 AgentScreen.tsx）
- 共享状态 `const [coin, setCoin] = useState("BTC");`（:148）等在同一处。
- `Toggle`（`{ theme, value, onValueChange, accessibilityLabel }`）已 import（:11）。
- template picker 的 `</View>` 在 :303；紧接 :305 起是各模板条件卡片。
- 5 个 create 处理器：`onCreate`(dca, :181)、`onCreateTwap`(:190)、`onCreateTpsl`(:201-205)、`onCreateGrid`(:214)、`onCreateGridLimit`(:224)——各 `await ctrl.createX({ ... });`。
- `t`（useT）、`theme`（useTheme）、`styles`（本文件 StyleSheet）均在作用域。测试 `AgentScreen.test.tsx` 用 `mockApiFake`（mock 的 StrategyApi），create 经真实 `useStrategyController` → `mockApiFake.createStrategy(type, params)`；既有 DCA 测试（:108-118）断言 `createStrategy` 精确参数（无 deadMan，默认关时不受影响）。

- [ ] **Step 1: 写失败测试到 `AgentScreen.test.tsx`**

在文件末尾（最后一个 `it(...)` 之后、`describe` 闭合之前）追加：
```ts
  it("includes deadMan:true in the created strategy when the dead-man toggle is on", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("new-dca")).toBeTruthy());
    fireEvent.press(screen.getByRole("switch")); // the account-wide dead-man toggle (no strategy rows in this mock)
    fireEvent.changeText(screen.getByTestId("dca-amount"), "50");
    fireEvent.changeText(screen.getByTestId("dca-interval"), "24");
    fireEvent.press(screen.getByTestId("dca-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, deadMan: true }),
    );
  });
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd mobile && npx jest AgentScreen -t "dead-man toggle is on"`
Expected: FAIL（无 dead-man toggle → `getByRole("switch")` 找不到；且 create 无 deadMan）。

- [ ] **Step 3: 加共享 `deadMan` 状态（AgentScreen.tsx，`const [coin, ...]` 附近，如 :148 之后）**

```ts
  const [deadMan, setDeadMan] = useState(false);
```

- [ ] **Step 4: 在 template picker 之后插入共享 toggle 行（:303 的 `</View>` 之后、:305 的条件卡片之前）**

```tsx
      <View style={styles.deadManRow} testID="deadman-row">
        <View style={styles.deadManText}>
          <Text style={[styles.fieldLabel, { color: theme.text }]}>{t("agent.deadManLabel")}</Text>
          <Text style={[styles.deadManHint, { color: theme.muted }]}>{t("agent.deadManHint")}</Text>
        </View>
        <Toggle theme={theme} value={deadMan} onValueChange={setDeadMan} accessibilityLabel={t("agent.deadManLabel")} />
      </View>
```

- [ ] **Step 5: 5 个 create 处理器并入条件 `deadMan`**

给每个 create 的参数对象追加 `...(deadMan ? { deadMan: true } : {})`（默认关时不加该键，既有精确断言测试不受影响）。逐个改：
- `onCreate`（dca, :181）：
```ts
    await ctrl.createDca({ coin: coin.toUpperCase(), side: "buy", quoteAmountUsdc: q, intervalHours: iv, ...(deadMan ? { deadMan: true } : {}) });
```
- `onCreateTwap`（:190）：
```ts
    await ctrl.createTwap({ coin: coin.toUpperCase(), side: twapSide, totalUsdc: total, slices, durationHours: dur, ...(deadMan ? { deadMan: true } : {}) });
```
- `onCreateTpsl`（:201-205）：
```ts
    await ctrl.createTpsl({
      coin: coin.toUpperCase(),
      ...(tpN !== undefined ? { takeProfitPrice: tpN } : {}),
      ...(slN !== undefined ? { stopLossPrice: slN } : {}),
      ...(deadMan ? { deadMan: true } : {}),
    });
```
- `onCreateGrid`（:214）：
```ts
    await ctrl.createGrid({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel, mode: gridMode, ...(deadMan ? { deadMan: true } : {}) });
```
- `onCreateGridLimit`（:224）：
```ts
    await ctrl.createGridLimit({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel, mode: glMode, ...(deadMan ? { deadMan: true } : {}) });
```

- [ ] **Step 6: 加样式（AgentScreen.tsx 的 `StyleSheet.create({ ... })` 内）**

在本文件底部 `StyleSheet.create` 对象里加三个样式（只用布局，无色值——色由 inline theme 提供）：
```ts
  deadManRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  deadManText: { flex: 1 },
  deadManHint: { fontSize: 12, marginTop: 2 },
```
（若 `fieldLabel` 样式已存在则复用；`deadManHint` 的字号/间距为布局值，无 hex。）

- [ ] **Step 7: 运行确认 PASS + 全量门禁**

Run:
```bash
cd mobile
npx jest AgentScreen
npx tsc --noEmit
npx jest
```
Expected: 新测试 + 既有 AgentScreen 测试（含默认关的 DCA 精确断言）全绿；tsc 无错；全套件（含 `noHardcodedColors` + `messages`）绿。

- [ ] **Step 8: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx
git commit --no-verify -m "feat(mobile): account-wide dead-man toggle in AgentScreen create form

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd mobile && npx tsc --noEmit && npx jest
```

既有测试基线保持绿（默认关 → create 无 deadMan，精确断言不变）；新增覆盖：死手 toggle 打开后 create 含 `deadMan:true`；en/zh 文案对等；无硬编码 hex。
