# Per-Strategy Cancel Button (Strategy List)

Date: 2026-07-13
Status: Approved

## Context

The Strategy tab (`AgentScreen`) lists active strategies; each running/paused row shows a
run/pause `Toggle`, and completed/canceling rows show a status label. There is no way to
cancel a single strategy from the UI — only the global kill-switch. The API client already
exposes `deleteStrategy(id)` (`DELETE /strategies/:id`), and the server semantics are:
`gridLimit` → status `canceling` (async drain of resting orders, stays listed until
drained); every other kind → immediate `remove` (drops out of the list). DELETE stops the
automation; it does not force-close open positions. This unit wires a per-row cancel
button to `deleteStrategy`. Third unit of the "strategy-list experience" enhancement.

## Goal

Add a small destructive "Cancel" button to each running/paused strategy row that, after a
confirmation dialog, cancels that strategy via `deleteStrategy` and refreshes the list.

## Design (all in `mobile/`)

### 1. `hooks/useStrategyController.ts`

Add a canceller mirroring the other actions:
```ts
const cancel = useCallback(async (id: string) => {
  await api.deleteStrategy(id);
  await refresh();
}, [api, refresh]);
```
Expose `cancel` in the returned object (next to `toggle`, `killAll`).

### 2. `screens/AgentScreen.tsx`

- Wire the row (in the `ctrl.strategies.map`): add `onCancel={() => void ctrl.cancel(s.id)}`.
- `StrategyRow` gains an `onCancel: () => void` prop.
- Inside `StrategyRow`, a confirm handler:
  ```ts
  const confirmCancel = () =>
    Alert.alert(t("agent.cancelConfirmTitle"), t("agent.cancelConfirmBody"), [
      { text: t("agent.cancelConfirmBack"), style: "cancel" },
      { text: t("agent.cancelConfirmOk"), style: "destructive", onPress: () => onCancel() },
    ]);
  ```
- Layout: the running/paused branch (currently just `<Toggle>`) becomes a horizontal
  action cluster with the cancel button to the LEFT of the Toggle:
  ```tsx
  <View style={styles.rowActions}>
    <Pressable onPress={confirmCancel} accessibilityRole="button" testID={`cancel-${strategy.id}`}>
      <Text style={[styles.cancelBtnText, { color: theme.down }]}>{t("agent.cancelStrategyBtn")}</Text>
    </Pressable>
    <Toggle theme={theme} value={strategy.status === "running"} onValueChange={onToggle} accessibilityLabel={`toggle-${strategy.id}`} />
  </View>
  ```
  The `completed || canceling` branch is unchanged (status label, no cancel button).
- Styles: `rowActions: { flexDirection: "row", alignItems: "center", gap: 12 }`,
  `cancelBtnText: { fontSize: 13, fontWeight: "600" }`.

### 3. i18n (`mobile/src/i18n/messages.ts`, en + zh)

- `agent.cancelStrategyBtn` — en `"Cancel"`, zh `"取消"` (the small row button).
- `agent.cancelConfirmTitle` — en `"Cancel strategy?"`, zh `"取消策略？"`.
- `agent.cancelConfirmBody` — en `"This strategy will stop running."`, zh `"该策略将停止运行"`.
- `agent.cancelConfirmBack` — en `"Back"`, zh `"返回"` (dialog dismiss).
- `agent.cancelConfirmOk` — en `"Cancel strategy"`, zh `"取消策略"` (destructive confirm).

## Data flow

```
row "Cancel" → Alert.alert(取消策略? …)
  → "返回" → dismiss (no-op)
  → "取消策略" → onCancel() → ctrl.cancel(id) → api.deleteStrategy(id) → refresh()
       → non-gridLimit: row drops from the list
       → gridLimit: row shows the "canceling" label (existing behavior)
```

## Error handling / edge cases

- Cancel button appears only on running/paused rows (where the Toggle is shown), never on
  completed/canceling rows.
- Confirmation is required (destructive) — a stray tap does nothing until the user confirms.
- `deleteStrategy` is idempotent server-side for gridLimit (repeat DELETE is a no-op).
- No change to other strategy behavior or the global kill-switch.

## Testing

`mobile/src/screens/AgentScreen.test.tsx`:
- Add `deleteStrategy: jest.fn(async () => undefined)` to `mockApiFake` (auto-cleared by
  the existing `Object.values(mockApiFake).forEach(mockClear)` in `beforeEach`).
- **Cancel flow:** with a running strategy fixture (e.g. a `dca` row `id:"c1"`), assert the
  `cancel-c1` button renders; `jest.spyOn(Alert, "alert")`, press it, invoke the captured
  destructive button's `onPress`, and assert `deleteStrategy` was called with `"c1"`.
- **No button on terminal rows:** with a `canceling` gridLimit fixture, assert
  `queryByTestId("cancel-<id>")` is `null`.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred

- Conditional live status vs mark — unit B (separate spec).
- Force-closing open positions on cancel (DELETE only stops the automation).
- Swipe-to-cancel / row action menus (a plain button is sufficient).
