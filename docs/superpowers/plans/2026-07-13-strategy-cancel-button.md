# Per-Strategy Cancel Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-row destructive "Cancel" button to running/paused strategy rows that, after a confirmation dialog, cancels the strategy via `deleteStrategy` and refreshes the list.

**Architecture:** `useStrategyController` gains a `cancel(id)` action; `StrategyRow` renders a "Cancel" button beside the run/pause Toggle (running/paused rows only) that opens an `Alert.alert` confirmation whose destructive button invokes `onCancel` → `ctrl.cancel(id)`.

**Tech Stack:** Expo RN + TypeScript, jest-expo + @testing-library/react-native, i18n via `useT()` (en default, en+zh parity enforced by `messages.test.ts`).

Spec: `docs/superpowers/specs/2026-07-13-strategy-cancel-button-design.md`
Branch: `feat/strategy-cancel-button`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: Controller `cancel(id)`

**Files:**
- Modify: `mobile/src/hooks/useStrategyController.ts` (add `cancel` useCallback after the create* actions; add to the return object)

- [ ] **Step 1: Add the `cancel` action**

After the `createScheduled` useCallback, add:
```ts
  const cancel = useCallback(async (id: string) => {
    await api.deleteStrategy(id);
    await refresh();
  }, [api, refresh]);
```

- [ ] **Step 2: Expose it in the return object**

In the final `return { … }`, add `cancel` after `killAll`:
```ts
  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, createGrid, createGridLimit, createTrailing, createConditional, createScheduled, toggle, killAll, cancel, refresh };
```

- [ ] **Step 3: Typecheck**

Run: `cd mobile && npx tsc --noEmit`
Expected: clean (0 errors).

- [ ] **Step 4: Commit**

```bash
git add mobile/src/hooks/useStrategyController.ts
git commit -m "feat: useStrategyController.cancel(id) via deleteStrategy"
```

---

### Task 2: i18n keys (en + zh)

**Files:**
- Modify: `mobile/src/i18n/messages.ts` (en block + zh block; place near the other `agent.*` action keys)

- [ ] **Step 1: Add keys to the EN block**

Add (e.g. after `"agent.pauseAll": …`):
```
    "agent.cancelStrategyBtn": "Cancel",
    "agent.cancelConfirmTitle": "Cancel strategy?",
    "agent.cancelConfirmBody": "This strategy will stop running.",
    "agent.cancelConfirmBack": "Back",
    "agent.cancelConfirmOk": "Cancel strategy",
```

- [ ] **Step 2: Add keys to the ZH block**

Add the matching keys (after the zh `"agent.pauseAll": …`):
```
    "agent.cancelStrategyBtn": "取消",
    "agent.cancelConfirmTitle": "取消策略？",
    "agent.cancelConfirmBody": "该策略将停止运行",
    "agent.cancelConfirmBack": "返回",
    "agent.cancelConfirmOk": "取消策略",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/i18n/messages.ts
git commit -m "feat: i18n keys for per-strategy cancel (en+zh)"
```

---

### Task 3: Cancel button + confirmation (TDD)

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx` (row map passes `onCancel`; `StrategyRow` prop + `confirmCancel` + action cluster; two styles)
- Test: `mobile/src/screens/AgentScreen.test.tsx` (add `deleteStrategy` mock + two tests; import `Alert`)

- [ ] **Step 1: Add the `deleteStrategy` mock + import Alert in the test**

In `AgentScreen.test.tsx`, add to `mockApiFake` (after `setStrategyStatus`):
```ts
  deleteStrategy: jest.fn(async () => undefined),
```
And change the RN import (line 2 area) to include `Alert`:
```ts
import { Alert } from "react-native";
```
(Place this import near the other imports at the top of the test file.)

- [ ] **Step 2: Write the failing tests**

Add after the countdown tests:
```tsx
  it("cancels a strategy after confirming the dialog", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "c1", type: "dca", status: "running", params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } },
    ]);
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("cancel-c1")).toBeTruthy());
    fireEvent.press(screen.getByTestId("cancel-c1"));
    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; style?: string; onPress?: () => void }>;
    const confirm = buttons.find((b) => b.style === "destructive")!;
    confirm.onPress!();
    await waitFor(() => expect(mockApiFake.deleteStrategy).toHaveBeenCalledWith("c1"));
    alertSpy.mockRestore();
  });

  it("shows no cancel button on a canceling strategy row", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "cg1", type: "gridLimit", status: "canceling", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 } },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-cg1")).toBeTruthy());
    expect(screen.queryByTestId("cancel-cg1")).toBeNull();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "cancel"`
Expected: FAIL (the first test cannot find `cancel-c1`).

- [ ] **Step 4: Pass `onCancel` into each row**

In `AgentScreen.tsx`, in the `ctrl.strategies.map((s) => <StrategyRow … />)`, add the prop:
```tsx
        ctrl.strategies.map((s) => <StrategyRow key={s.id} theme={theme} strategy={s} now={now} onToggle={() => void ctrl.toggle(s)} onCancel={() => void ctrl.cancel(s.id)} getRungs={(id) => api.getRungs(id)} />)
```

- [ ] **Step 5: Extend the `StrategyRow` signature**

Change the `StrategyRow` signature to add `onCancel`:
```tsx
function StrategyRow({
  theme, strategy, now, onToggle, onCancel, getRungs,
}: {
  theme: ThemeTokens; strategy: Strategy; now: number; onToggle: () => void; onCancel: () => void; getRungs?: (id: string) => Promise<Rung[]>;
}) {
```

- [ ] **Step 6: Add the confirm handler + action cluster**

Inside `StrategyRow`, before the `return (`, add:
```ts
  const confirmCancel = () =>
    Alert.alert(t("agent.cancelConfirmTitle"), t("agent.cancelConfirmBody"), [
      { text: t("agent.cancelConfirmBack"), style: "cancel" },
      { text: t("agent.cancelConfirmOk"), style: "destructive", onPress: () => onCancel() },
    ]);
```
Replace the running/paused Toggle branch:
```tsx
        {completed || canceling ? (
          <Text style={[styles.hint, { color: theme.faint }]}>{t(canceling ? "agent.statusCanceling" : "agent.statusCompleted")}</Text>
        ) : (
          <View style={styles.rowActions}>
            <Pressable onPress={confirmCancel} accessibilityRole="button" testID={`cancel-${strategy.id}`}>
              <Text style={[styles.cancelBtnText, { color: theme.down }]}>{t("agent.cancelStrategyBtn")}</Text>
            </Pressable>
            <Toggle
              theme={theme}
              value={strategy.status === "running"}
              onValueChange={onToggle}
              accessibilityLabel={`toggle-${strategy.id}`}
            />
          </View>
        )}
```

- [ ] **Step 7: Add the two styles**

In the `StyleSheet.create({ … })`, near `rowTop`, add:
```ts
  rowActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  cancelBtnText: { fontSize: 13, fontWeight: "600" },
```

- [ ] **Step 8: Run the cancel tests to verify they pass**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "cancel"`
Expected: PASS (2 tests).

- [ ] **Step 9: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 10: Commit**

```bash
git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx
git commit -m "feat: per-strategy cancel button with confirmation dialog"
```

---

### Task 4: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/strategy-cancel-button
gh pr create --title "feat: per-strategy cancel button in the strategy list" --body-file <body>
```
Body: summarize controller `cancel` + row button + confirm dialog + i18n + tests + validation; note DELETE semantics (gridLimit → canceling, others → removed; positions not force-closed).

- [ ] **Step 3: Code review + CI**

Dispatch the code-review agent (background) + `gh pr checks <n> --watch` in parallel.

- [ ] **Step 4: Merge**

On clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** controller `cancel` (Task 1) ✔, i18n 5 keys (Task 2) ✔, row button + confirm dialog + terminal-row exclusion (Task 3) ✔, tests for confirm-flow + no-button-on-canceling (Task 3) ✔, no server change ✔.
- **Placeholder scan:** none — all steps carry concrete code/commands.
- **Type consistency:** `cancel(id: string)` defined in Task 1 and consumed as `ctrl.cancel(s.id)` in Task 3; `onCancel: () => void` prop added to the signature (Step 5) and passed (Step 4); `deleteStrategy` already exists on `StrategyApi`.
- **Test locale:** en default; the confirm-flow test asserts on `deleteStrategy` (not text) and terminal-row test on testID, so both are locale-independent.
