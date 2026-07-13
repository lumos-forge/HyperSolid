# M4 Trailing-Stop Mobile Create Form — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `trailing` template + create form (coin + trailPct) to the mobile Strategy tab, wired through the controller and `StrategyApi.createStrategy("trailing", …)`.

**Architecture:** Widen the mobile strategy types with `trailing`/`TrailingParams`, add a `createTrailing` controller method, and add a template + form card + validation + i18n to `AgentScreen`, mirroring the existing `tpsl` template.

**Tech Stack:** Expo RN + TypeScript, jest-expo + @testing-library/react-native.

Spec: `docs/superpowers/specs/2026-07-13-m4-trailing-stop-mobile-design.md`

---

## Task 1: Strategy types + controller `createTrailing`

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/hooks/useStrategyController.ts`

- [ ] **Step 1: Widen the strategy types**

In `mobile/src/services/strategyApi.ts`, replace:
```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";
```
with:
```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";
```
Add the params interface after `TpslParams` (before `GridParams`):
```ts
export interface TrailingParams extends StrategyParamsCommon {
  coin: string;
  trailPct: number;
}
```
Replace:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams;
```
with:
```ts
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams;
```

- [ ] **Step 2: Add the controller creator**

In `mobile/src/hooks/useStrategyController.ts`, add `TrailingParams` to the type import
from `../services/strategyApi`:
```ts
import type { StrategyApi, Strategy, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams, AgentStatus, Activity } from "../services/strategyApi";
```
Add the creator immediately after the `createGridLimit` `useCallback`:
```ts
  const createTrailing = useCallback(async (params: TrailingParams) => {
    await api.createStrategy("trailing", params);
    await refresh();
  }, [api, refresh]);
```
Add `createTrailing` to the returned object (next to `createGridLimit`). Replace:
```ts
  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, createGrid, createGridLimit, toggle, killAll, refresh };
```
with:
```ts
  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, createGrid, createGridLimit, createTrailing, toggle, killAll, refresh };
```

- [ ] **Step 3: Typecheck**

Run: `cd mobile && npx tsc --noEmit`
Expected: `tsc` clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/services/strategyApi.ts mobile/src/hooks/useStrategyController.ts && git commit -m "feat(m4): mobile trailing strategy type + controller createTrailing"
```

---

## Task 2: i18n keys (en + zh)

`messages.test.ts` enforces en/zh key parity.

**Files:**
- Modify: `mobile/src/i18n/messages.ts`

- [ ] **Step 1: Add the English keys**

In `mobile/src/i18n/messages.ts`, in the English block, immediately after the line
`"agent.tpslNeedsOne": "Enter a take-profit or stop-loss price",` add:
```ts
    "agent.templateTrailing": "Trailing",
    "agent.newTrailing": "New trailing stop",
    "agent.createTrailing": "Create trailing stop",
    "agent.trailPct": "Callback rate %",
    "agent.invalidTrailing": "Callback rate must be between 0 and 100",
```

- [ ] **Step 2: Add the Chinese keys**

In the Chinese block, immediately after the line
`"agent.tpslNeedsOne": "请填写止盈价或止损价",` add:
```ts
    "agent.templateTrailing": "移动止损",
    "agent.newTrailing": "新建移动止损",
    "agent.createTrailing": "创建移动止损",
    "agent.trailPct": "回撤率 %",
    "agent.invalidTrailing": "回撤率需在 0 到 100 之间",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/i18n/messages.ts && git commit -m "i18n(m4): trailing-stop create-form strings (en/zh)"
```

---

## Task 3: AgentScreen template + form

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx`
- Modify: `mobile/src/screens/AgentScreen.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `mobile/src/screens/AgentScreen.test.tsx`, add tests after the existing TWAP create
test (they follow the same `render` → connect → switch template → fill → press pattern;
reuse the file's existing `renderConnected`/setup helper — match how the TWAP test
starts, e.g. `fireEvent.press(screen.getByTestId("strategy-connect-btn"))`):
```ts
  it("switches to the trailing template and creates a trailing stop", async () => {
    renderAgent();
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    fireEvent.press(screen.getByTestId("template-trailing"));
    fireEvent.changeText(screen.getByTestId("trailing-coin"), "ETH");
    fireEvent.changeText(screen.getByTestId("trailing-pct"), "5");
    fireEvent.press(screen.getByTestId("trailing-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("trailing", { coin: "ETH", trailPct: 5 }),
    );
  });

  it("does not create a trailing stop with an out-of-range callback rate", async () => {
    renderAgent();
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    fireEvent.press(screen.getByTestId("template-trailing"));
    fireEvent.changeText(screen.getByTestId("trailing-coin"), "ETH");
    fireEvent.changeText(screen.getByTestId("trailing-pct"), "150");
    fireEvent.press(screen.getByTestId("trailing-create"));
    await waitFor(() => expect(screen.getByTestId("trailing-create")).toBeTruthy());
    expect(mockApiFake.createStrategy).not.toHaveBeenCalledWith("trailing", expect.anything());
  });
```
NOTE: use the SAME render/setup call the surrounding create tests use (this file’s
DCA/TWAP tests show the exact call — mirror it; the placeholder `renderAgent()` above
stands for that existing setup). If the tests use a bare `render(<AgentScreen … />)`,
copy that instead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "trailing"`
Expected: FAIL — no `template-trailing` / `trailing-*` testIDs exist yet.

- [ ] **Step 3: Widen the `Template` type**

In `mobile/src/screens/AgentScreen.tsx`, replace:
```ts
type Template = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";
```
with:
```ts
type Template = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";
```

- [ ] **Step 4: Add trailing to the template picker + label**

Replace:
```ts
        {(["dca", "twap", "tpsl", "grid", "gridLimit"] as Template[]).map((k) => (
```
with:
```ts
        {(["dca", "twap", "tpsl", "grid", "gridLimit", "trailing"] as Template[]).map((k) => (
```
Replace the label ternary tail:
```ts
                : k === "grid" ? "agent.templateGrid"
                : "agent.templateGridLimit",
```
with:
```ts
                : k === "grid" ? "agent.templateGrid"
                : k === "gridLimit" ? "agent.templateGridLimit"
                : "agent.templateTrailing",
```

- [ ] **Step 5: Add state + handler**

Add the state next to the other template state (immediately after the
`const [gridMode, setGridMode] = useState<"longOnly" | "symmetric">("longOnly");` line):
```ts
  const [trailPct, setTrailPct] = useState("");
```
Add the handler immediately after the `onCreateGrid` function definition:
```ts
  async function onCreateTrailing() {
    const pct = Number(trailPct);
    if (!(pct > 0) || !(pct < 100)) { Alert.alert(t("agent.invalidParams"), t("agent.invalidTrailing")); return; }
    await ctrl.createTrailing({ coin: coin.toUpperCase(), trailPct: pct, ...(deadMan ? { deadMan: true } : {}) });
    setTrailPct("");
  }
```

- [ ] **Step 6: Add the trailing form card**

Immediately after the `{template === "tpsl" && ( ... )}` block (the tpsl `SurfaceCard`),
add:
```tsx
      {template === "trailing" && (
        <SurfaceCard theme={theme} rule={false} testID="new-trailing" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newTrailing")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="trailing-coin" />
          <Field theme={theme} label={t("agent.trailPct")} value={trailPct} onChangeText={setTrailPct} keyboard testID="trailing-pct" />
          <Pressable onPress={onCreateTrailing} accessibilityRole="button" testID="trailing-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createTrailing")}</Text>
          </Pressable>
        </SurfaceCard>
      )}
```

- [ ] **Step 7: Typecheck + full test suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full jest-expo suite passes (trailing + no regressions).

- [ ] **Step 8: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx && git commit -m "feat(m4): trailing-stop template + create form in AgentScreen"
```

---

## Task 4: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M4 roadmap note**

In `docs/BACKEND-ARCHITECTURE.md`, in the M4 row's trailing annotation, replace:
```
mobile 建仓 UI 待做
```
with:
```
mobile 建仓 UI 落地（AgentScreen trailing 模板 + coin/trailPct 表单 + `createTrailing`）
```

(If the exact fragment differs, replace only the literal `mobile 建仓 UI 待做`.)

- [ ] **Step 2: Full mobile validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: `tsc` clean; full suite passes.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m4): mark trailing-stop mobile create form landed"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m4-trailing-stop-mobile
gh pr create --title "feat(m4): trailing-stop mobile create form" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** `StrategyType`/`TrailingParams` → Task 1. Controller
`createTrailing` → Task 1. i18n keys → Task 2. Template + picker + state + handler +
form card → Task 3. Roadmap + validation → Task 4. No gaps.

**Placeholder scan:** No TBD/TODO in the implementation steps. The AgentScreen test's
`renderAgent()` is explicitly flagged to be replaced with the file's existing
render/setup call (the DCA/TWAP tests show it); this is a deliberate "match existing
pattern" instruction, not a code placeholder. Task 4 Step 4 PR body-file is composed at
execution time.

**Type consistency:** `TrailingParams { coin, trailPct }` and `StrategyType`'s
`"trailing"` are used identically in strategyApi.ts, useStrategyController.ts
(`createTrailing`), and AgentScreen.tsx (`ctrl.createTrailing`, form). `createStrategy("trailing", { coin, trailPct })`
matches the server `/strategies` contract and the test assertion. `agent.trailPct` /
`agent.invalidTrailing` / `agent.templateTrailing` / `agent.newTrailing` /
`agent.createTrailing` are the exact keys added in Task 2 and referenced in Task 3.
