# M4 Conditional Order — Mobile Create Form

Date: 2026-07-13
Status: Approved

## Context

The server added the `conditional` strategy (PR #85): when the mark crosses a trigger
price in a direction, it opens a position at market and completes. The mobile Strategy
tab (`AgentScreen`) can create dca/twap/tpsl/grid/gridLimit/trailing via a template
picker + per-kind form cards backed by `useStrategyController` + `StrategyApi.createStrategy`,
but has no `conditional` template. This unit adds it, completing conditional entry end
to end.

## Goal

Add a `conditional` template and create form (coin, side, sizeUsdc, triggerPrice,
triggerDirection) to `AgentScreen`, wired through `useStrategyController.createConditional`
and `StrategyApi.createStrategy("conditional", …)`. It reuses the existing segmented
selector patterns (twap's side, grid's mode) for the two enum fields.

## Design

All changes are in `mobile/`, mirroring existing templates.

### 1. `mobile/src/services/strategyApi.ts`

```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional";

export interface ConditionalParams extends StrategyParamsCommon {
  coin: string;
  side: "buy" | "sell";
  sizeUsdc: number;
  triggerPrice: number;
  triggerDirection: "above" | "below";
}

export type StrategyParams = ... | TrailingParams | ConditionalParams;
```

### 2. `mobile/src/hooks/useStrategyController.ts`

Import `ConditionalParams`; add a creator mirroring `createTrailing`:
```ts
const createConditional = useCallback(async (params: ConditionalParams) => {
  await api.createStrategy("conditional", params);
  await refresh();
}, [api, refresh]);
```
Expose `createConditional` in the returned object.

### 3. `mobile/src/screens/AgentScreen.tsx`

- `type Template = ... | "trailing" | "conditional";`.
- Template picker: add `"conditional"` to the list and its label case.
- State:
  ```ts
  const [condSide, setCondSide] = useState<"buy" | "sell">("buy");
  const [condSize, setCondSize] = useState("");
  const [condTrigger, setCondTrigger] = useState("");
  const [condDir, setCondDir] = useState<"above" | "below">("above");
  ```
- Handler (mirrors `onCreateTpsl`/`onCreateTrailing`):
  ```ts
  async function onCreateConditional() {
    const size = Number(condSize), trig = Number(condTrigger);
    if (!(size > 0) || !(trig > 0)) { Alert.alert(t("agent.invalidParams"), t("agent.invalidConditional")); return; }
    await ctrl.createConditional({ coin: coin.toUpperCase(), side: condSide, sizeUsdc: size, triggerPrice: trig, triggerDirection: condDir, ...(deadMan ? { deadMan: true } : {}) });
    setCondSize(""); setCondTrigger("");
  }
  ```
- Form card, rendered when `template === "conditional"`. It reuses the twap side-selector
  markup for `side` (testIDs `cond-side-buy` / `cond-side-sell`) and the grid mode-selector
  markup for `triggerDirection` (testIDs `cond-dir-above` / `cond-dir-below`), plus
  `Field`s for coin (shared `coin` state), sizeUsdc (`cond-size`), triggerPrice (`cond-trigger`),
  and a create button (`cond-create`):
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

### 4. i18n (`mobile/src/i18n/messages.ts`, en + zh)

- `agent.templateConditional` — en `"Conditional"`, zh `"条件单"`.
- `agent.newConditional` — en `"New conditional order"`, zh `"新建条件单"`.
- `agent.createConditional` — en `"Create conditional order"`, zh `"创建条件单"`.
- `agent.condSize` — en `"Order size (USDC)"`, zh `"下单金额 (USDC)"`.
- `agent.triggerPrice` — en `"Trigger price"`, zh `"触发价"`.
- `agent.triggerDirection` — en `"Trigger when"`, zh `"触发方向"`.
- `agent.condAbove` — en `"Above"`, zh `"涨破"`.
- `agent.condBelow` — en `"Below"`, zh `"跌破"`.
- `agent.invalidConditional` — en `"Enter a positive size and trigger price"`, zh `"请填写正数的金额与触发价"`.
- `side` labels reuse the existing `agent.buy` / `agent.sell` / `agent.side`.

## Data flow

```
pick "conditional" → coin + side + size + triggerPrice + direction → Create
  → onCreateConditional validates size > 0 && triggerPrice > 0
  → ctrl.createConditional({ coin, side, sizeUsdc, triggerPrice, triggerDirection })
    → api.createStrategy("conditional", …) → POST /strategies
```

## Error handling / compatibility

- Invalid `sizeUsdc` or `triggerPrice` (≤ 0, non-number) → `Alert` and no submit
  (side/direction are selectors, always valid). Mirrors the server's checks.
- Reuses shared `coin`/`deadMan` state and the existing create flow; no change to the
  other templates.
- Server already validates the full config; the client checks are UX guards.

## Testing

- `AgentScreen.test.tsx` — switch to the `conditional` template (`template-conditional`),
  select `cond-side-sell`, fill `cond-size` + `cond-trigger`, select `cond-dir-below`,
  press `cond-create`, and assert `createStrategy` was called with
  `("conditional", { coin, side: "sell", sizeUsdc, triggerPrice, triggerDirection: "below" })`;
  an invalid size (e.g. `0`) does not call `createStrategy`.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred

- Scheduled/timed one-shot orders (server + mobile).
- Editing/cancelling a pending conditional beyond the existing strategy list controls.
