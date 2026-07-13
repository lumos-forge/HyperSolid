# M4 Conditional-Order Mobile Create Form — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `conditional` template + create form (coin, side, sizeUsdc, triggerPrice, triggerDirection) to the mobile Strategy tab, wired through the controller and `StrategyApi.createStrategy("conditional", …)`.

**Architecture:** Widen the mobile strategy types with `conditional`/`ConditionalParams`, add a `createConditional` controller method, and add a template + form card (reusing twap's side selector + grid's mode selector) + validation + i18n to `AgentScreen`.

**Tech Stack:** Expo RN + TypeScript, jest-expo + @testing-library/react-native.

Spec: `docs/superpowers/specs/2026-07-13-m4-conditional-order-mobile-design.md`

---

## Task 1: Strategy types + controller `createConditional`

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/hooks/useStrategyController.ts`

- [ ] **Step 1: Widen the strategy types**

In `mobile/src/services/strategyApi.ts`, replace:
```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";
```
with:
```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional";
```
Add the params interface after `TrailingParams`:
```ts
export interface ConditionalParams extends StrategyParamsCommon {
  coin: string;
  side: "buy" | "sell";
  sizeUsdc: number;
  triggerPrice: number;
  triggerDirection: "above" | "below";
}
```
Replace:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams;
```
with:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams | ConditionalParams;
```

- [ ] **Step 2: Add the controller creator**

In `mobile/src/hooks/useStrategyController.ts`, add `ConditionalParams` to the type
import from `../services/strategyApi`:
```ts
import type { StrategyApi, Strategy, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, ConditionalParams, AgentStatus, Activity } from "../services/strategyApi";
```
Add the creator immediately after the `createTrailing` `useCallback`:
```ts
  const createConditional = useCallback(async (params: ConditionalParams) => {
    await api.createStrategy("conditional", params);
    await refresh();
  }, [api, refresh]);
```
Add `createConditional` to the returned object (next to `createTrailing`). Replace:
```ts
  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, createGrid, createGridLimit, createTrailing, toggle, killAll, refresh };
```
with:
```ts
  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, createGrid, createGridLimit, createTrailing, createConditional, toggle, killAll, refresh };
```

- [ ] **Step 3: Typecheck**

Run: `cd mobile && npx tsc --noEmit`
Expected: `tsc` clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/strategyApi.ts mobile/src/hooks/useStrategyController.ts && git commit -m "feat(m4): mobile conditional strategy type + controller createConditional"
```

---

## Task 2: i18n keys (en + zh)

`messages.test.ts` enforces en/zh key parity.

**Files:**
- Modify: `mobile/src/i18n/messages.ts`

- [ ] **Step 1: Add the English keys**

In `mobile/src/i18n/messages.ts`, in the English block, immediately after the line
`"agent.invalidTrailing": "Callback rate must be between 0 and 100",` add:
```ts
    "agent.templateConditional": "Conditional",
    "agent.newConditional": "New conditional order",
    "agent.createConditional": "Create conditional order",
    "agent.condSize": "Order size (USDC)",
    "agent.triggerPrice": "Trigger price",
    "agent.triggerDirection": "Trigger when",
    "agent.condAbove": "Above",
    "agent.condBelow": "Below",
    "agent.invalidConditional": "Enter a positive size and trigger price",
```

- [ ] **Step 2: Add the Chinese keys**

In the Chinese block, immediately after the line
`"agent.invalidTrailing": "回撤率需在 0 到 100 之间",` add:
```ts
    "agent.templateConditional": "条件单",
    "agent.newConditional": "新建条件单",
    "agent.createConditional": "创建条件单",
    "agent.condSize": "下单金额 (USDC)",
    "agent.triggerPrice": "触发价",
    "agent.triggerDirection": "触发方向",
    "agent.condAbove": "涨破",
    "agent.condBelow": "跌破",
    "agent.invalidConditional": "请填写正数的金额与触发价",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/i18n/messages.ts && git commit -m "i18n(m4): conditional-order create-form strings (en/zh)"
```

---

## Task 3: AgentScreen template + form

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx`
- Modify: `mobile/src/screens/AgentScreen.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `mobile/src/screens/AgentScreen.test.tsx`, add tests after the existing trailing
tests (same `render(<AgentScreen />)` → connect → switch template → fill → press
pattern):
```ts
  it("switches to the conditional template and creates a conditional order", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-conditional")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-conditional"));
    fireEvent.changeText(screen.getByTestId("conditional-coin"), "ETH");
    fireEvent.press(screen.getByTestId("cond-side-sell"));
    fireEvent.changeText(screen.getByTestId("cond-size"), "100");
    fireEvent.changeText(screen.getByTestId("cond-trigger"), "3000");
    fireEvent.press(screen.getByTestId("cond-dir-below"));
    fireEvent.press(screen.getByTestId("cond-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("conditional", { coin: "ETH", side: "sell", sizeUsdc: 100, triggerPrice: 3000, triggerDirection: "below" }),
    );
  });

  it("does not create a conditional order with a non-positive size", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-conditional")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-conditional"));
    fireEvent.changeText(screen.getByTestId("conditional-coin"), "ETH");
    fireEvent.changeText(screen.getByTestId("cond-size"), "0");
    fireEvent.changeText(screen.getByTestId("cond-trigger"), "3000");
    fireEvent.press(screen.getByTestId("cond-create"));
    await waitFor(() => expect(screen.getByTestId("cond-create")).toBeTruthy());
    expect(mockApiFake.createStrategy).not.toHaveBeenCalledWith("conditional", expect.anything());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "conditional"`
Expected: FAIL — no `template-conditional` / `cond-*` testIDs exist yet.

- [ ] **Step 3: Widen the `Template` type**

In `mobile/src/screens/AgentScreen.tsx`, replace:
```ts
type Template = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";
```
with:
```ts
type Template = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional";
```

- [ ] **Step 4: Add conditional to the template picker + label**

Replace:
```ts
        {(["dca", "twap", "tpsl", "grid", "gridLimit", "trailing"] as Template[]).map((k) => (
```
with:
```ts
        {(["dca", "twap", "tpsl", "grid", "gridLimit", "trailing", "conditional"] as Template[]).map((k) => (
```
Replace the label ternary tail:
```ts
                : k === "gridLimit" ? "agent.templateGridLimit"
                : "agent.templateTrailing",
```
with:
```ts
                : k === "gridLimit" ? "agent.templateGridLimit"
                : k === "trailing" ? "agent.templateTrailing"
                : "agent.templateConditional",
```

- [ ] **Step 5: Add state + handler**

Add the state immediately after the `const [trailPct, setTrailPct] = useState("");` line:
```ts
  const [condSide, setCondSide] = useState<"buy" | "sell">("buy");
  const [condSize, setCondSize] = useState("");
  const [condTrigger, setCondTrigger] = useState("");
  const [condDir, setCondDir] = useState<"above" | "below">("above");
```
Add the handler immediately after the `onCreateTrailing` function definition:
```ts
  async function onCreateConditional() {
    const size = Number(condSize), trig = Number(condTrigger);
    if (!(size > 0) || !(trig > 0)) { Alert.alert(t("agent.invalidParams"), t("agent.invalidConditional")); return; }
    await ctrl.createConditional({ coin: coin.toUpperCase(), side: condSide, sizeUsdc: size, triggerPrice: trig, triggerDirection: condDir, ...(deadMan ? { deadMan: true } : {}) });
    setCondSize(""); setCondTrigger("");
  }
```

- [ ] **Step 6: Add the conditional form card**

Immediately after the `{template === "trailing" && ( ... )}` block (the trailing
`SurfaceCard`), add:
```tsx
      {template === "conditional" && (
        <SurfaceCard theme={theme} rule={false} testID="new-conditional" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newConditional")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="conditional-coin" />
          <View style={styles.sideRow}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("agent.side")}</Text>
            <View style={styles.sideBtns}>
              {(["buy", "sell"] as const).map((sd) => (
                <Pressable key={sd} testID={`cond-side-${sd}`} accessibilityRole="button" onPress={() => setCondSide(sd)}
                  style={[styles.sideBtn, { borderColor: theme.line }, condSide === sd && { backgroundColor: theme.surface }]}>
                  <Text style={[styles.segmentText, { color: condSide === sd ? theme.text : theme.muted }]}>{t(sd === "buy" ? "agent.buy" : "agent.sell")}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Field theme={theme} label={t("agent.condSize")} value={condSize} onChangeText={setCondSize} keyboard testID="cond-size" />
          <Field theme={theme} label={t("agent.triggerPrice")} value={condTrigger} onChangeText={setCondTrigger} keyboard testID="cond-trigger" />
          <View style={styles.sideRow}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("agent.triggerDirection")}</Text>
            <View style={styles.sideBtns}>
              {(["above", "below"] as const).map((d) => (
                <Pressable key={d} testID={`cond-dir-${d}`} accessibilityRole="button" onPress={() => setCondDir(d)}
                  style={[styles.sideBtn, { borderColor: theme.line }, condDir === d && { backgroundColor: theme.surface }]}>
                  <Text style={[styles.segmentText, { color: condDir === d ? theme.text : theme.muted }]}>{t(d === "above" ? "agent.condAbove" : "agent.condBelow")}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable onPress={onCreateConditional} accessibilityRole="button" testID="cond-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createConditional")}</Text>
          </Pressable>
        </SurfaceCard>
      )}
```

- [ ] **Step 7: Typecheck + full test suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full jest-expo suite passes (conditional + no regressions).

- [ ] **Step 8: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx && git commit -m "feat(m4): conditional-order template + create form in AgentScreen"
```

---

## Task 4: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M4 roadmap note**

In `docs/BACKEND-ARCHITECTURE.md`, in the M4 row's conditional annotation, replace:
```
mobile 建仓 UI 待做
```
with:
```
mobile 建仓 UI 落地（AgentScreen conditional 模板 + coin/side/size/触发价/方向 表单 + `createConditional`）
```

(The trailing note was already changed to "落地"; the sole remaining `mobile 建仓 UI 待做`
is the conditional one. If more than one match exists, target the fragment inside the
`条件单【…】` annotation.)

- [ ] **Step 2: Full mobile validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full suite passes.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m4): mark conditional-order mobile create form landed"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m4-conditional-order-mobile
gh pr create --title "feat(m4): conditional-order mobile create form" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** `StrategyType`/`ConditionalParams` → Task 1. Controller
`createConditional` → Task 1. i18n keys → Task 2. Template + picker + state + handler +
form card (side + direction selectors) → Task 3. Roadmap + validation → Task 4. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after. Task 4
Step 4 PR body-file is composed at execution time.

**Type consistency:** `ConditionalParams { coin, side, sizeUsdc, triggerPrice, triggerDirection }`
is used identically in strategyApi.ts, useStrategyController.ts (`createConditional`), and
AgentScreen.tsx (`ctrl.createConditional`, form). `createStrategy("conditional", { … })`
matches the server `/strategies` contract and the test assertion. The `agent.*` keys
(templateConditional/newConditional/createConditional/condSize/triggerPrice/triggerDirection/
condAbove/condBelow/invalidConditional) are the exact keys added in Task 2 and referenced
in Task 3; `agent.side`/`agent.buy`/`agent.sell` are reused (pre-existing). The
`styles.sideRow`/`sideBtns`/`sideBtn`/`segmentText`/`fieldLabel` used by the card already
exist (twap/grid use them).
