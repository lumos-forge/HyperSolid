# Conditional Order — Live Mark Status in the Strategy List

Date: 2026-07-13
Status: Approved

## Context

The `conditional` strategy (`{coin, side, sizeUsdc, triggerPrice, triggerDirection}`) opens a
market position when the mark crosses `triggerPrice`. Its list row shows a static subtitle
(`Buy 100 @ Above 3000`) but no sense of how close the mark is to firing. This unit adds a
live second line — `Mark 2950 · To trigger +1.7%` — refreshing as prices move.

**Scope finding:** the app already has `useLiveMarkets` + `MarketDataService` +
`useMarketStore`, and the client factories `createInfoClient(network)` /
`createSubsClient(network)`, but **no screen currently mounts a live markets feed** — the
market store is unfed in production. So this unit also mounts a live feed on the Strategy
panel (reusing the existing infra) to power the conditional status. Final unit of the
"strategy-list experience" enhancement (after scheduled countdown and per-row cancel).

## Goal

Show a live `Mark {price} · To trigger {±x.x}%` line on each conditional row, driven by a
markets feed mounted on the Strategy panel; omit the line when no mark is available.

## Design (all in `mobile/`)

### 1. Pure helper — `mobile/src/lib/pctToTrigger.ts`

```ts
/** Signed % the mark must still move to reach the trigger: (trigger - mark) / mark * 100. */
export function pctToTrigger(mark: number, triggerPrice: number): number {
  return ((triggerPrice - mark) / mark) * 100;
}
```
- Positive → mark must rise (below an "above" trigger); negative → must fall. Independent
  of `triggerDirection` (already shown on line 1). Unit-tested in isolation.

### 2. Live markets feed — `StrategyPanel` (in `screens/AgentScreen.tsx`)

```ts
const marketData = useMemo(
  () => new MarketDataService(createInfoClient(network), createSubsClient(network)),
  [network],
);
useLiveMarkets(marketData);
const tickers = useMarketStore((s) => s.tickers);
```
- `StrategyPanel` receives `network`. It only mounts when connected, so the feed runs only
  while the connected Strategy panel is on screen; `useLiveMarkets` unsubscribes on unmount.

### 3. Row wiring + second line — `StrategyRow`

- Row map passes the mark for conditional rows:
  ```tsx
  mark={s.type === "conditional" ? tickers.find((tk) => tk.coin === (s.params as ConditionalParams).coin)?.midPx : undefined}
  ```
- `StrategyRow` gains `mark?: number`.
- Compute the status line (only for conditional rows with a mark):
  ```ts
  const condStatus =
    strategy.type === "conditional" && mark != null
      ? `${t("agent.condNow")} ${formatPrice(mark)} · ${t("agent.condDistance")} ${fmtSignedPct(pctToTrigger(mark, (strategy.params as ConditionalParams).triggerPrice))}`
      : null;
  ```
  where `fmtSignedPct(p) = `${p >= 0 ? "+" : ""}${p.toFixed(1)}%``.
- Render it as a second hint line inside `info`, after the `sub` line:
  ```tsx
  {condStatus ? <Text style={[styles.hint, { color: theme.muted }]} testID={`cond-status-${strategy.id}`}>{condStatus}</Text> : null}
  ```
  `formatPrice` is the display formatter from `../components/PriceText`.

### 4. i18n (`mobile/src/i18n/messages.ts`, en + zh)

- `agent.condNow` — en `"Mark"`, zh `"现价"`.
- `agent.condDistance` — en `"To trigger"`, zh `"距触发"`.

## Data flow

```
useLiveMarkets(marketData) → useMarketStore.tickers (live mids)
  → row map: mark = tickers[coin].midPx (conditional rows only)
    → StrategyRow: conditional & mark present
         → "Mark 2950 · To trigger +1.7%"  (pctToTrigger signed)
       conditional & no mark, or non-conditional → no second line
```

## Error handling / edge cases

- No mark for the coin (feed loading / coin absent) → second line omitted; the original
  subtitle stays.
- `pctToTrigger` guards nothing special: `mark` from the store is always > 0 (a real mid);
  the helper is only called when `mark != null`.
- Non-conditional rows are unchanged (scheduled countdown, cancel button, etc. all intact).

## Testing

- `mobile/src/lib/pctToTrigger.test.ts` (pure): `pctToTrigger(2950, 3000)` ≈ `1.695`
  (positive, must rise); `pctToTrigger(2950, 2900)` ≈ `-1.695` (negative, must fall).
- `mobile/src/screens/AgentScreen.test.tsx`:
  - Extend the `../lib/hyperliquid/client` mock with `createInfoClient: jest.fn(() => ({}))`
    and `createSubsClient: jest.fn(() => ({}))`; add `jest.mock("../hooks/useLiveMarkets", () => ({ useLiveMarkets: jest.fn() }))` so tests never open a real socket.
  - **Live status:** inject a ticker via `useMarketStore.setState({ tickers: [ethTicker] })`
    (a `MarketTicker` with `coin:"ETH", midPx:2950`), render a running `conditional`
    strategy on ETH with `triggerPrice:3000`, and assert the `cond-status-<id>` line shows
    `Mark 2950` and `To trigger +1.7%`.
  - **No mark:** with an empty `tickers`, assert `queryByTestId("cond-status-<id>")` is null.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred

- Focus-aware subscription lifecycle (subscribe only when the tab is focused) — a broader
  navigation concern; here the feed lives with the connected Strategy panel's mount.
- Live status for other kinds (tpsl/trailing already show their static params).
- Wiring live markets into other screens (separate effort; this only mounts it here).
