# M4 Trailing-Stop — Mobile Create Form

Date: 2026-07-13
Status: Approved

## Context

The server added the `trailing` strategy (PR #83): it tracks a position's favorable
mark extreme and reduce-only-closes on a `trailPct`% retrace. The mobile Strategy tab
(`AgentScreen`) can create `dca`/`twap`/`tpsl`/`grid`/`gridLimit` via a template picker
+ per-kind form cards backed by `useStrategyController` + `StrategyApi.createStrategy`,
but has no `trailing` template. This unit adds it, completing trailing end to end.

## Goal

Add a `trailing` template and create form (coin + trailPct) to `AgentScreen`, wired
through `useStrategyController.createTrailing` and `StrategyApi.createStrategy("trailing", …)`.
Direction is derived from the open position server-side, so the form needs no side
selector.

## Design

All changes are in `mobile/`, mirroring the existing `tpsl` template.

### 1. `mobile/src/services/strategyApi.ts`

```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";

export interface TrailingParams extends StrategyParamsCommon {
  coin: string;
  trailPct: number;
}

export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams;
```
(`StrategyParamsCommon` already carries the optional `deadMan`.)

### 2. `mobile/src/hooks/useStrategyController.ts`

Import `TrailingParams` and add a creator mirroring `createTpsl`:
```ts
const createTrailing = useCallback(async (params: TrailingParams) => {
  await api.createStrategy("trailing", params);
  await refresh();
}, [api, refresh]);
```
Expose `createTrailing` in the hook's returned object next to `createTpsl`.

### 3. `mobile/src/screens/AgentScreen.tsx`

- `type Template = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing";`.
- Template picker: add `"trailing"` to the `[...]` list and its label case
  (`k === "trailing" ? "agent.templateTrailing"`).
- New state: `const [trailPct, setTrailPct] = useState("");`.
- Handler (mirrors `onCreateTpsl`):
  ```ts
  async function onCreateTrailing() {
    const pct = Number(trailPct);
    if (!(pct > 0) || !(pct < 100)) { Alert.alert(t("agent.invalidParams"), t("agent.invalidTrailing")); return; }
    await ctrl.createTrailing({ coin: coin.toUpperCase(), trailPct: pct, ...(deadMan ? { deadMan: true } : {}) });
    setTrailPct("");
  }
  ```
- Form card, rendered when `template === "trailing"`:
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
  The shared `coin` and `deadMan` state are reused (as the other cards do).

### 4. i18n (`mobile/src/i18n/messages.ts`, en + zh)

- `agent.templateTrailing` — en `"Trailing"`, zh `"移动止损"`.
- `agent.newTrailing` — en `"New trailing stop"`, zh `"新建移动止损"`.
- `agent.createTrailing` — en `"Create trailing stop"`, zh `"创建移动止损"`.
- `agent.trailPct` — en `"Callback rate %"`, zh `"回撤率 %"`.
- `agent.invalidTrailing` — en `"Callback rate must be between 0 and 100"`, zh `"回撤率需在 0 到 100 之间"`.

## Data flow

```
pick "trailing" template → enter coin + trailPct → Create
  → onCreateTrailing validates 0 < trailPct < 100
  → ctrl.createTrailing({ coin, trailPct }) → api.createStrategy("trailing", …) → POST /strategies
```

## Error handling / compatibility

- Invalid `trailPct` (≤ 0, ≥ 100, non-number) → `Alert` and no submit (mirrors tpsl).
- Reuses the shared `coin`/`deadMan` state and existing create flow; no change to the
  other templates.
- Server already validates `0 < trailPct < 100`, so the client check is a UX guard.

## Testing

- `AgentScreen.test.tsx` — switch to the `trailing` template (`template-trailing`),
  fill `trailing-coin` + `trailing-pct`, press `trailing-create`, and assert
  `createStrategy` was called with `("trailing", { coin, trailPct })`; an invalid
  `trailPct` (e.g. `0` or `150`) does not call `createStrategy`.
- `useStrategyController.test.ts` (if present) — `createTrailing` calls
  `api.createStrategy("trailing", params)` and refreshes.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred

- Editing/visualising the live trail peak in Positions.
- A side selector (direction is derived from the position server-side).
- Absolute-offset / activation-price trailing (not in the server model).
