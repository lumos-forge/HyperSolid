# Scheduled Order — Live Countdown in the Strategy List

Date: 2026-07-13
Status: Approved

## Context

The Strategy tab (`AgentScreen`) lists active strategies. The `scheduled` strategy
(`kind:"scheduled"`, params `{coin, side, sizeUsdc, runAt}`) opens a market position when
`now >= runAt`. Its list row currently shows a static subtitle `"{buy|sell} {sizeUsdc}"`,
giving the user no sense of *when* it will fire. This unit adds a live, per-minute
countdown to that row, derived purely on the client from `params.runAt` — no server
change. First unit of the broader "strategy-list experience" enhancement (the other units
— per-row cancel, conditional live status — are separate specs).

## Goal

Show a live countdown next to the scheduled row subtitle: `"buy 100 · 剩 2h 15m"`,
refreshing every minute, with sensible edge behavior for "about to fire" and "paused".

## Design (all in `mobile/`)

### 1. Pure helper — `mobile/src/lib/formatCountdown.ts`

```ts
/** Format a positive remaining duration (ms) as "2h 15m" or, under one hour, "15m". */
export function formatCountdown(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
```
- Called only with `ms > 0` (the caller handles `<= 0` as "imminent").
- Units `h`/`m` are literal (language-neutral), consistent with the DCA subtitle `$x / 24h`.
- Unit-tested in isolation.

### 2. Minute tick — `AgentScreen`

- Add `const [now, setNow] = useState(() => Date.now());`.
- `useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(id); }, []);`
- A single screen-level timer; pass `now` into each `StrategyRow` as a prop (no per-row timers).

### 3. Scheduled subtitle — `StrategyRow`

Replace the current scheduled subtitle branch:
```ts
: strategy.type === "scheduled"
? (() => {
    const p = strategy.params as ScheduledParams;
    const base = `${t(p.side === "buy" ? "agent.buy" : "agent.sell")} ${p.sizeUsdc}`;
    if (strategy.status !== "running") return base;
    const remaining = p.runAt - now;
    return remaining <= 0
      ? `${base} · ${t("agent.schedImminent")}`
      : `${base} · ${t("agent.schedCountdown", { time: formatCountdown(remaining) })}`;
  })()
```
- `now` is the prop from AgentScreen; `StrategyRow` gains a `now: number` prop.
- Only `running` scheduled rows show the countdown; `paused`/`completed`/`canceling`
  fall back to `base` (completed/canceling already render a status label top-right).

### 4. i18n (`mobile/src/i18n/messages.ts`, en + zh)

- `agent.schedCountdown` — en `"{time} left"`, zh `"剩 {time}"`.
- `agent.schedImminent` — en `"Executing soon"`, zh `"即将执行"`.

## Data flow

```
setInterval(60s) → setNow(Date.now())
  → StrategyRow(now) → scheduled subtitle recomputes:
       running & runAt-now > 0  → "buy 100 · 剩 2h 15m"
       running & runAt-now <= 0 → "buy 100 · 即将执行"
       not running              → "buy 100"
```

## Error handling / edge cases

- `runAt - now <= 0` while still `running` (scheduler hasn't ticked yet) → `即将执行`.
- Paused → no countdown (scheduler skips paused strategies, so a ticking clock would
  mislead); the paused state is already visible via the row Toggle.
- Under one hour → `剩 15m` (no `0h`). Exactly on an hour boundary → `剩 2h 0m`.
- Non-scheduled kinds are untouched.

## Testing

- `mobile/src/lib/formatCountdown.test.ts` (pure): `60000 → "1m"`, `3600000 → "1h 0m"`,
  `8_100_000 → "2h 15m"` (2h15m), `900_000 → "15m"`, `30_000 → "0m"` (sub-minute).
- `mobile/src/screens/AgentScreen.test.tsx`: with a `running` scheduled fixture whose
  `params.runAt = Date.now() + 2h`, assert the row subtitle contains the countdown (`剩`
  / a `h`/`m` token); with a `paused` scheduled fixture, assert the subtitle is just
  `"buy {size}"` (no countdown). Use the existing list-fixture mechanism.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred (separate units)

- Per-row cancel button (`deleteStrategy` wiring) — unit C.
- Conditional live status vs mark — unit B.
- Sub-minute precision / seconds countdown (minute cadence is sufficient here).
