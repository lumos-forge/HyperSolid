# M4 Scheduled Order — Mobile Create Form

Date: 2026-07-13
Status: Approved

## Context

The server added the `scheduled` strategy (PR #87): at an absolute `runAt` (epoch ms),
it opens a position at market and completes. The mobile Strategy tab (`AgentScreen`)
can create dca/twap/tpsl/grid/gridLimit/trailing/conditional via a template picker +
per-kind form cards, but has no `scheduled` template. This unit adds it, completing
scheduled entry end to end. It closely mirrors the `conditional` form, but the trigger
is a **"run in N hours"** delay (client computes `runAt = now + N·3600000`) instead of
a price + direction — avoiding a native date picker (consistent with P5c).

## Goal

Add a `scheduled` template + create form (coin, side, sizeUsdc, delay-hours) to
`AgentScreen`, wired through `useStrategyController.createScheduled` and
`StrategyApi.createStrategy("scheduled", …)`. Also render the new kind correctly in the
strategy list (the title/subtitle chains must handle it, per the review lesson from
conditional).

## Design

All changes are in `mobile/`, mirroring the `conditional` template.

### 1. `mobile/src/services/strategyApi.ts`

```ts
export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional" | "scheduled";

export interface ScheduledParams extends StrategyParamsCommon {
  coin: string;
  side: "buy" | "sell";
  sizeUsdc: number;
  runAt: number;
}

export type StrategyParams = ... | ConditionalParams | ScheduledParams;
```

### 2. `mobile/src/hooks/useStrategyController.ts`

Import `ScheduledParams`; add a creator mirroring `createConditional`:
```ts
const createScheduled = useCallback(async (params: ScheduledParams) => {
  await api.createStrategy("scheduled", params);
  await refresh();
}, [api, refresh]);
```
Expose `createScheduled` in the returned object.

### 3. `mobile/src/screens/AgentScreen.tsx`

- `type Template = ... | "conditional" | "scheduled";`.
- Template picker: add `"scheduled"` to the list and its label case.
- State:
  ```ts
  const [schedSide, setSchedSide] = useState<"buy" | "sell">("buy");
  const [schedSize, setSchedSize] = useState("");
  const [schedDelay, setSchedDelay] = useState("");
  ```
- Handler:
  ```ts
  async function onCreateScheduled() {
    const size = Number(schedSize), hrs = Number(schedDelay);
    if (!(size > 0) || !(hrs > 0)) { Alert.alert(t("agent.invalidParams"), t("agent.invalidScheduled")); return; }
    const runAt = Math.round(Date.now() + hrs * 3600000);
    await ctrl.createScheduled({ coin: coin.toUpperCase(), side: schedSide, sizeUsdc: size, runAt, ...(deadMan ? { deadMan: true } : {}) });
    setSchedSize(""); setSchedDelay("");
  }
  ```
- Form card, rendered when `template === "scheduled"` — coin Field (shared `coin`), a
  side segmented selector (`sched-side-buy`/`sched-side-sell` → setSchedSide, reusing the
  twap selector markup), size Field (`sched-size`, label `agent.condSize`), delay Field
  (`sched-delay`, label `agent.schedDelay`), and a create button (`sched-create`).
- `StrategyRow` title/subtitle: add a `scheduled` case (before the DCA fallback), so a
  created scheduled strategy shows correctly instead of "{coin} DCA · $undefined":
  - title: `t("agent.strategyScheduled", { coin: (params as ScheduledParams).coin })`.
  - subtitle: `` `${t(side === "buy" ? "agent.buy" : "agent.sell")} ${sizeUsdc}` ``.

### 4. i18n (`mobile/src/i18n/messages.ts`, en + zh)

- `agent.templateScheduled` — en `"Scheduled"`, zh `"定时单"`.
- `agent.newScheduled` — en `"New scheduled order"`, zh `"新建定时单"`.
- `agent.createScheduled` — en `"Create scheduled order"`, zh `"创建定时单"`.
- `agent.schedDelay` — en `"Run in (hours)"`, zh `"多少小时后执行"`.
- `agent.invalidScheduled` — en `"Enter a positive size and delay"`, zh `"请填写正数的金额与延时"`.
- `agent.strategyScheduled` — en `"{coin} Scheduled"`, zh `"{coin} 定时单"`.
- The size label reuses `agent.condSize`; side reuses `agent.buy` / `agent.sell` / `agent.side`.

## Data flow

```
pick "scheduled" → coin + side + size + delay-hours → Create
  → onCreateScheduled validates size > 0 && delay > 0
  → runAt = round(now + delay·3600000)
  → ctrl.createScheduled({ coin, side, sizeUsdc, runAt }) → api.createStrategy("scheduled", …) → POST /strategies
```

## Error handling / compatibility

- Invalid size or delay (≤ 0, non-number) → `Alert` and no submit (side is a selector,
  always valid). The server also validates `runAt` as a positive integer.
- `runAt` is rounded to an integer (the server requires a positive integer epoch ms).
- Reuses shared `coin`/`deadMan` state and the existing create flow; no change to other
  templates.

## Testing

- `AgentScreen.test.tsx` — switch to the `scheduled` template (`template-scheduled`),
  select `sched-side-buy`, fill `sched-size` + `sched-delay` (e.g. `2`), press
  `sched-create`, and assert `createStrategy` was called with
  `("scheduled", objectContaining({ coin: "ETH", side: "buy", sizeUsdc: 100 }))` where
  the captured `runAt` is a future timestamp within a window of `before + 2·3600000`
  (deterministic bound, not an exact value); an invalid delay (e.g. `0`) does not call
  `createStrategy`.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred

- A native date/time picker (delay-hours is the chosen minimal input).
- Showing a live countdown / exact scheduled time in the strategy list row.
