# v8 Deviations Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the honest deviations recorded while landing the v8 UI — wire the real data/flows behind the already-shipped v8 screens (Market Detail enrichment, Trade percent sizing), and scope the money-movement and automation subsystems that need their own specs.

**Architecture:** The v8 visual layer already exists. This phase adds the **data/compute** behind it: extend the normalized market model + add pure financial-math helpers (period returns, indicators) computed from candles, and wire the connected-wallet balance into Trade. Money movement (Withdraw/Deposit) and the Strategy automation engine are security-/scope-heavy subsystems that get their own brainstorm + spec — this plan defines and gates them, it does not fabricate their internals.

**Tech Stack:** Expo SDK 56 / React Native 0.85 / TypeScript; `@nktkas/hyperliquid` SDK (`InfoClient.candleSnapshot`, `ExchangeClient.withdraw3`); `react-native-svg` for charts; Jest + `@testing-library/react-native` v14 (built-in matchers); theme-token-driven styling (no hardcoded hex outside `src/theme/tokens.ts`).

---

## Conventions (apply to every task)

- **Baseline:** `cd mobile && npx tsc --noEmit` → 0 errors; `npx jest` → all green (currently **405**). Each task must keep tsc at 0 and grow jest by its new tests.
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Colors via tokens only** (geometric `▲▼◷` allowed, never pictographic emoji). Charts/overlays tint from `theme` tokens (use `withAlpha` from `src/theme/color.ts` for translucency).
- **No real orders / no real transfers in tests:** inject mock services; default `envStore.network = "testnet"`.
- **Commit:** `git commit --no-verify -m "<msg>"` with trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Commit locally per task; push only when the user says so.
- **Do not change** the Phase 2 wallet-security layer (`src/wallet/*`), the Phase 3 encoding core (`src/lib/hyperliquid/{buildOrder,order,cancel}.ts`), or the `IntentLedger` sync kernel, except where a task explicitly adds a *new* sibling (e.g. a new pure helper file or a new service method that reuses the core).

---

## File Structure (Phase A — this plan implements these)

- `src/lib/hyperliquid/types.ts` — add optional `openInterest` to `MarketTicker`.
- `src/lib/hyperliquid/normalize.ts` — map `openInterest` from the asset ctx.
- `src/lib/hyperliquid/performance.ts` *(new)* — pure `periodReturns(closes, anchors)`.
- `src/lib/hyperliquid/indicators.ts` *(new)* — pure `sma`, `ema`, `bollinger`, `rsi`.
- `src/lib/hyperliquid/bookImbalance.ts` *(new)* — pure `bookImbalance(orderbook)`.
- `src/services/detailData.ts` — add `loadDailyCloses(coin, days)` (reuses `candleSnapshot`).
- `src/hooks/useAvailableBalance.ts` *(new)* — connected-wallet withdrawable balance.
- `src/components/CandleChart.tsx` — add an optional `overlays` prop (price-line overlays).
- `src/components/MultiPeriodReturns.tsx` *(new)* — the 24H/7D/30D/… perf row.
- `src/components/BookImbalanceBar.tsx` *(new)* — the long/short-style book bar.
- `src/components/RsiPanel.tsx` *(new)* — RSI sub-panel under the candle chart.
- `src/components/SizePercentRow.tsx` *(new)* — Trade 25/50/75/100% quick-size row.
- `src/screens/MarketDetailScreen.tsx` — wire OI stat, perf row, indicator overlays, RSI panel, book bar.
- `src/screens/TradeScreen.tsx` — wire the percent-size row to available balance.

---

## Phase A — Market Detail enrichment + Trade percent sizing

> **STATUS: ✅ COMPLETE (executed inline 2026-06-23).** All 6 tasks shipped via TDD; jest 405→424 (+19), tsc 0, no hardcoded hex/emoji. Commits: A1 b0cf54c · A2 3cb17c5 · A3 2031521 · A4 eaba68c · A5 0caa2e9 · A6 a8ee465.

### Task A1: Surface Open Interest

OI already arrives in `RawAssetCtx.openInterest` (see `src/lib/hyperliquid/types.ts`) but is dropped during normalization. Add it as an **optional** field (so the ~10 existing `MarketTicker` fixtures don't need editing) and show it in the Market Detail stats grid.

**Files:**
- Modify: `src/lib/hyperliquid/types.ts` (the `MarketTicker` interface)
- Modify: `src/lib/hyperliquid/normalize.ts` (`normalizeMarkets`)
- Test: `src/lib/hyperliquid/normalize.test.ts`
- Modify: `src/screens/MarketDetailScreen.tsx` (stats array)

- [x] **Step 1: Write the failing test** — append to `src/lib/hyperliquid/normalize.test.ts`:

```ts
it("carries open interest through normalization", () => {
  const meta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] };
  const ctxs = [{ midPx: "64000", prevDayPx: "63000", funding: "0.0001", dayNtlVlm: "1000", openInterest: "1950000000" }];
  const [t] = normalizeMarkets([meta, ctxs] as never);
  expect(t.openInterest).toBe(1_950_000_000);
});
```

- [x] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/hyperliquid/normalize.test.ts -t "open interest"`
Expected: FAIL (`t.openInterest` is `undefined`).

- [x] **Step 3: Add the field** — in `src/lib/hyperliquid/types.ts`, inside `interface MarketTicker`, after `szDecimals: number;` add:

```ts
  /** 24h open interest (USD notional). Optional: absent for markets without a ctx. */
  openInterest?: number;
```

- [x] **Step 4: Map it** — in `src/lib/hyperliquid/normalize.ts`, inside the object built by `normalizeMarkets` (next to `dayNtlVlm: Number(ctx?.dayNtlVlm ?? 0),`) add:

```ts
      openInterest: Number(ctx?.openInterest ?? 0),
```

- [x] **Step 5: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/hyperliquid/normalize.test.ts`
Expected: PASS.

- [x] **Step 6: Show it in Market Detail** — in `src/screens/MarketDetailScreen.tsx`, in the `stats` array, insert after the `24h vol · USDC` row:

```ts
    ["Open interest", ticker?.openInterest ? formatCompact(ticker.openInterest) : "—"],
```

(`formatCompact` is already imported.)

- [x] **Step 7: Update the detail test** — in `src/screens/MarketDetailScreen.test.tsx`, add `openInterest: 1.95e9` to the `btc` fixture object, then add inside the chrome test:

```ts
    expect(screen.getByText("Open interest")).toBeTruthy();
```

- [x] **Step 8: Full gates + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: 0 tsc errors; all green (+1).

```bash
git add mobile/src/lib/hyperliquid/types.ts mobile/src/lib/hyperliquid/normalize.ts mobile/src/lib/hyperliquid/normalize.test.ts mobile/src/screens/MarketDetailScreen.tsx mobile/src/screens/MarketDetailScreen.test.tsx
git commit --no-verify -m "feat(mobile): surface open interest in Market Detail

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task A2: Multi-period performance row

Compute 24H/7D/30D/90D/180D/1Y returns from daily closes. Add a pure helper + a `detailData` method that fetches daily candles, render a `MultiPeriodReturns` row.

**Files:**
- Create: `src/lib/hyperliquid/performance.ts`
- Test: `src/lib/hyperliquid/performance.test.ts`
- Modify: `src/services/detailData.ts`
- Create: `src/components/MultiPeriodReturns.tsx`
- Test: `src/components/MultiPeriodReturns.test.tsx`
- Modify: `src/screens/MarketDetailScreen.tsx`

- [x] **Step 1: Write the failing test** — `src/lib/hyperliquid/performance.test.ts`:

```ts
import { periodReturns } from "./performance";

describe("periodReturns", () => {
  it("computes signed percent change for each anchor against the latest close", () => {
    // 11 daily closes, latest = 110, 1-day-ago = 100 -> +10%
    const closes = [50, 60, 70, 80, 90, 95, 100, 102, 105, 100, 110];
    const out = periodReturns(closes, [{ label: "1D", days: 1 }, { label: "10D", days: 10 }]);
    expect(out[0]).toEqual({ label: "1D", pct: 10 });          // (110-100)/100
    expect(out[1]).toEqual({ label: "10D", pct: 120 });        // (110-50)/50
  });

  it("returns null pct when there is not enough history", () => {
    const out = periodReturns([100, 110], [{ label: "30D", days: 30 }]);
    expect(out[0]).toEqual({ label: "30D", pct: null });
  });
});
```

- [x] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/hyperliquid/performance.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement** — `src/lib/hyperliquid/performance.ts`:

```ts
export interface PeriodReturn {
  label: string;
  /** Percent change vs `days` ago; null when history is too short. */
  pct: number | null;
}

/** Signed percent return for each anchor, latest close vs the close `days` bars earlier. */
export function periodReturns(
  closes: number[],
  anchors: Array<{ label: string; days: number }>,
): PeriodReturn[] {
  const latest = closes[closes.length - 1];
  return anchors.map(({ label, days }) => {
    const past = closes[closes.length - 1 - days];
    if (latest === undefined || past === undefined || past === 0) return { label, pct: null };
    return { label, pct: ((latest - past) / past) * 100 };
  });
}
```

- [x] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/hyperliquid/performance.test.ts`
Expected: PASS.

- [x] **Step 5: Add the daily-closes fetch** — in `src/services/detailData.ts`, add a method to the service class (it already wraps `candleSnapshot` via `loadCandles`):

```ts
  /** Daily closing prices, oldest→newest, for multi-period performance. */
  async loadDailyCloses(coin: string, days = 365, now = Date.now()): Promise<number[]> {
    const candles = await this.loadCandles(coin, "1d", days + 1, now);
    return candles.map((c) => c.close);
  }
```

- [x] **Step 6: Write the component test** — `src/components/MultiPeriodReturns.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react-native";
import { MultiPeriodReturns } from "./MultiPeriodReturns";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("MultiPeriodReturns", () => {
  it("renders each period with a ▲/▼ marker colored up/down, and — for null", () => {
    render(
      <MultiPeriodReturns
        theme={t}
        data={[{ label: "24H", pct: 0.85 }, { label: "7D", pct: -2.36 }, { label: "1Y", pct: null }]}
      />,
    );
    expect(screen.getByText("24H")).toBeTruthy();
    expect(screen.getByText(/▲/)).toBeTruthy();
    expect(screen.getByText(/2\.36%/)).toHaveStyle({ color: t.down });
    expect(screen.getByText("—")).toBeTruthy();
  });
});
```

- [x] **Step 7: Run it, expect fail**

Run: `cd mobile && npx jest src/components/MultiPeriodReturns.test.tsx`
Expected: FAIL (module not found).

- [x] **Step 8: Implement the component** — `src/components/MultiPeriodReturns.tsx`:

```tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import type { PeriodReturn } from "../lib/hyperliquid/performance";
import { fonts } from "../theme/fonts";

export function MultiPeriodReturns({ theme, data }: { theme: ThemeTokens; data: PeriodReturn[] }) {
  return (
    <View style={styles.row}>
      {data.map(({ label, pct }) => {
        const up = (pct ?? 0) >= 0;
        const color = pct === null ? theme.faint : up ? theme.up : theme.down;
        const text = pct === null ? "—" : `${up ? "▲ " : "▼ "}${Math.abs(pct).toFixed(2)}%`;
        return (
          <View key={label} style={styles.cell}>
            <Text style={[styles.label, { color: theme.faint }]}>{label}</Text>
            <Text style={[styles.value, { color }]}>{text}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 14 },
  cell: { alignItems: "center", flex: 1 },
  label: { fontFamily: fonts.body.regular, fontSize: 10, marginBottom: 3 },
  value: { fontFamily: fonts.mono.bold, fontSize: 11, fontVariant: ["tabular-nums"] },
});
```

- [x] **Step 9: Run it, expect pass**

Run: `cd mobile && npx jest src/components/MultiPeriodReturns.test.tsx`
Expected: PASS.

- [x] **Step 10: Wire into Market Detail** — in `src/screens/MarketDetailScreen.tsx`:
  1. import: `import { MultiPeriodReturns } from "../components/MultiPeriodReturns";` and `import { periodReturns } from "../lib/hyperliquid/performance";`
  2. add state + fetch (place near the other hooks):

```tsx
  const [dailyCloses, setDailyCloses] = useState<number[]>([]);
  useEffect(() => {
    let active = true;
    service.loadDailyCloses(coin).then((c) => active && setDailyCloses(c)).catch(() => active && setDailyCloses([]));
    return () => { active = false; };
  }, [service, coin]);
  const perf = periodReturns(dailyCloses, [
    { label: "24H", days: 1 }, { label: "7D", days: 7 }, { label: "30D", days: 30 },
    { label: "90D", days: 90 }, { label: "180D", days: 180 }, { label: "1Y", days: 365 },
  ]);
```

  3. render `<MultiPeriodReturns theme={theme} data={perf} />` right below the `<CandleChart .../>`.

- [x] **Step 11: Mock the new method in the detail test** — in `src/screens/MarketDetailScreen.test.tsx`, the `useLiveDetail`/`DetailDataService` are already mocked; extend the `DetailDataService` mock so `loadDailyCloses` resolves `[]` (so the effect is harmless): `jest.mock("../services/detailData", () => ({ DetailDataService: class { async loadDailyCloses() { return []; } } }));`

- [x] **Step 12: Full gates + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: 0 tsc; all green.

```bash
git add mobile/src/lib/hyperliquid/performance.ts mobile/src/lib/hyperliquid/performance.test.ts mobile/src/services/detailData.ts mobile/src/components/MultiPeriodReturns.tsx mobile/src/components/MultiPeriodReturns.test.tsx mobile/src/screens/MarketDetailScreen.tsx mobile/src/screens/MarketDetailScreen.test.tsx
git commit --no-verify -m "feat(mobile): multi-period performance row in Market Detail

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task A3: Price-overlay indicators (MA / EMA / BOLL)

Pure indicator math + an `overlays` prop on `CandleChart` to draw indicator polylines in price space; wire the existing indicator tabs to toggle them.

**Files:**
- Create: `src/lib/hyperliquid/indicators.ts`
- Test: `src/lib/hyperliquid/indicators.test.ts`
- Modify: `src/components/CandleChart.tsx`
- Modify: `src/screens/MarketDetailScreen.tsx`

- [x] **Step 1: Write the failing test** — `src/lib/hyperliquid/indicators.test.ts`:

```ts
import { sma, ema, bollinger, rsi } from "./indicators";

describe("indicators", () => {
  it("sma averages over the window, null until the window fills", () => {
    expect(sma([2, 4, 6, 8], 2)).toEqual([null, 3, 5, 7]);
  });

  it("ema seeds on the first sma then smooths", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(2, 5); // seed = sma of first 3
    expect(out[3]).toBeCloseTo(3, 5); // 4*0.5 + 2*0.5
  });

  it("bollinger returns mid/upper/lower bands at 2σ", () => {
    const { upper, mid, lower } = bollinger([1, 2, 3, 4, 5], 5, 2);
    expect(mid[4]).toBe(3);
    expect(upper[4]).toBeGreaterThan(3);
    expect(lower[4]).toBeLessThan(3);
  });

  it("rsi is 100 for a monotonically rising series", () => {
    const out = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14);
    expect(out[out.length - 1]).toBeCloseTo(100, 5);
  });
});
```

- [x] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/hyperliquid/indicators.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement** — `src/lib/hyperliquid/indicators.ts`:

```ts
export function sma(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    let sum = 0;
    for (let j = i + 1 - period; j <= i; j++) sum += values[j];
    return sum / period;
  });
}

export function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = values.map(() => null);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i + 1 - period; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function bollinger(values: number[], period: number, mult = 2) {
  const mid = sma(values, period);
  const upper: (number | null)[] = values.map(() => null);
  const lower: (number | null)[] = values.map(() => null);
  for (let i = 0; i < values.length; i++) {
    const m = mid[i];
    if (m === null) continue;
    let variance = 0;
    for (let j = i + 1 - period; j <= i; j++) variance += (values[j] - m) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(0, diff);
    const loss = Math.max(0, -diff);
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}
```

- [x] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/hyperliquid/indicators.test.ts`
Expected: PASS.

- [x] **Step 5: Add `overlays` to CandleChart** — in `src/components/CandleChart.tsx`, add to the props type:

```tsx
  overlays?: Array<{ values: (number | null)[]; color: string }>;
```

and, inside the `<Svg>` (after the candle `<Rect>`s, before the current-price line), render each overlay as a polyline in price space (reuse the existing `y()` and `cw`):

```tsx
        {(overlays ?? []).map((o, oi) => {
          const d = o.values
            .map((v, i) => (v == null ? null : `${i === 0 || o.values[i - 1] == null ? "M" : "L"}${(i * cw + cw / 2).toFixed(1)} ${y(v).toFixed(1)}`))
            .filter(Boolean)
            .join(" ");
          return d ? <Path key={`o${oi}`} d={d} fill="none" stroke={o.color} strokeWidth={1.2} /> : null;
        })}
```

Add `Path` to the `react-native-svg` import: `import Svg, { Line, Rect, Path } from "react-native-svg";`.

- [x] **Step 6: Update the CandleChart test** — in `src/components/CandleChart.test.tsx` add:

```tsx
  it("draws indicator overlays when provided", () => {
    render(
      <CandleChart
        candles={candles}
        theme={t}
        currentPrice={64550}
        overlays={[{ values: [64000, 64100, 64600], color: t.brand }]}
      />,
    );
    expect(screen.getByTestId("candle-chart")).toBeTruthy();
  });
```

- [x] **Step 7: Wire the indicator tabs** — in `src/screens/MarketDetailScreen.tsx`:
  1. import: `import { sma, ema, bollinger } from "../lib/hyperliquid/indicators";`
  2. add state: `const [indicator, setIndicator] = useState<"none" | "MA" | "EMA" | "BOLL">("none");`
  3. compute overlays from `candles.map((c) => c.close)`:

```tsx
  const closes = candles.map((c) => c.close);
  const overlays = (() => {
    if (indicator === "MA") return [{ values: sma(closes, 7), color: theme.brand }];
    if (indicator === "EMA") return [{ values: ema(closes, 7), color: theme.brand }];
    if (indicator === "BOLL") {
      const b = bollinger(closes, 20, 2);
      return [
        { values: b.upper, color: theme.muted },
        { values: b.mid, color: theme.brand },
        { values: b.lower, color: theme.muted },
      ];
    }
    return [];
  })();
```

  4. pass `overlays={overlays}` to `<CandleChart … />`.
  5. render a tab row above the chart (reuse the `Chip` component already imported):

```tsx
      <View style={styles.tfs}>
        {(["none", "MA", "EMA", "BOLL"] as const).map((ind) => (
          <Chip key={ind} theme={theme} label={ind === "none" ? "—" : ind} active={indicator === ind} onPress={() => setIndicator(ind)} />
        ))}
      </View>
```

- [x] **Step 8: Full gates + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: 0 tsc; all green.

```bash
git add mobile/src/lib/hyperliquid/indicators.ts mobile/src/lib/hyperliquid/indicators.test.ts mobile/src/components/CandleChart.tsx mobile/src/components/CandleChart.test.tsx mobile/src/screens/MarketDetailScreen.tsx
git commit --no-verify -m "feat(mobile): MA/EMA/BOLL chart overlays in Market Detail

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task A4: RSI sub-panel

Render RSI(14) in a small panel under the candle chart (the `rsi()` helper already exists from Task A3).

**Files:**
- Create: `src/components/RsiPanel.tsx`
- Test: `src/components/RsiPanel.test.tsx`
- Modify: `src/screens/MarketDetailScreen.tsx`

- [x] **Step 1: Write the failing test** — `src/components/RsiPanel.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react-native";
import { RsiPanel } from "./RsiPanel";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("RsiPanel", () => {
  it("renders an empty placeholder until there is data", () => {
    render(<RsiPanel values={[null, null]} theme={t} />);
    expect(screen.getByTestId("rsi-panel-empty")).toBeTruthy();
  });

  it("renders the panel and the latest RSI readout", () => {
    render(<RsiPanel values={[null, 30, 55, 72.4]} theme={t} />);
    expect(screen.getByTestId("rsi-panel")).toBeTruthy();
    expect(screen.getByText(/RSI 72\.4/)).toBeTruthy();
  });
});
```

- [x] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/components/RsiPanel.test.tsx`
Expected: FAIL (module not found).

- [x] **Step 3: Implement** — `src/components/RsiPanel.tsx`:

```tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";

const VIEW_W = 348;

export function RsiPanel({
  values,
  theme,
  height = 56,
}: {
  values: (number | null)[];
  theme: ThemeTokens;
  height?: number;
}) {
  const points = values.map((v, i) => ({ v, i })).filter((p) => p.v != null) as { v: number; i: number }[];
  if (points.length < 2) return <View testID="rsi-panel-empty" style={{ height }} />;
  const latest = points[points.length - 1].v;
  const x = (i: number) => (i / (values.length - 1)) * VIEW_W;
  const y = (v: number) => height - (v / 100) * height;
  const d = points.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const line = latest >= 70 ? theme.down : latest <= 30 ? theme.up : theme.brand;

  return (
    <View testID="rsi-panel" style={[styles.wrap, { height: height + 16 }]}>
      <Text style={[styles.label, { color: theme.faint }]}>{`RSI ${latest.toFixed(1)}`}</Text>
      <Svg width="100%" height={height} viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none">
        <Line x1={0} y1={y(70)} x2={VIEW_W} y2={y(70)} stroke={withAlpha(theme.down, 0.4)} strokeWidth={1} strokeDasharray="3 4" />
        <Line x1={0} y1={y(30)} x2={VIEW_W} y2={y(30)} stroke={withAlpha(theme.up, 0.4)} strokeWidth={1} strokeDasharray="3 4" />
        <Path d={d} fill="none" stroke={line} strokeWidth={1.4} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 10 },
  label: { fontFamily: fonts.mono.regular, fontSize: 9, marginBottom: 4 },
});
```

- [x] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/components/RsiPanel.test.tsx`
Expected: PASS.

- [x] **Step 5: Wire it in** — in `src/screens/MarketDetailScreen.tsx`, import `import { RsiPanel } from "../components/RsiPanel";` and `rsi` from indicators, then render `<RsiPanel values={rsi(closes, 14)} theme={theme} />` below `MultiPeriodReturns`.

- [x] **Step 6: Full gates + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: 0 tsc; all green.

```bash
git add mobile/src/components/RsiPanel.tsx mobile/src/components/RsiPanel.test.tsx mobile/src/screens/MarketDetailScreen.tsx
git commit --no-verify -m "feat(mobile): RSI sub-panel in Market Detail

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task A5: Book-imbalance bar (honest replacement for the omitted long/short bar)

There is **no** public HL endpoint for a global long/short position ratio, so do not fabricate one. Instead show the **order-book depth imbalance** (bid vs ask cumulative size near top of book) — a real, available metric — clearly labelled so it isn't mistaken for trader positioning.

**Files:**
- Create: `src/lib/hyperliquid/bookImbalance.ts`
- Test: `src/lib/hyperliquid/bookImbalance.test.ts`
- Create: `src/components/BookImbalanceBar.tsx`
- Test: `src/components/BookImbalanceBar.test.tsx`
- Modify: `src/screens/MarketDetailScreen.tsx`

- [x] **Step 1: Write the failing test** — `src/lib/hyperliquid/bookImbalance.test.ts`:

```ts
import { bookImbalance } from "./bookImbalance";

describe("bookImbalance", () => {
  it("returns bid/ask share of the top-N cumulative size", () => {
    const book = {
      bids: [{ px: 100, sz: 3, total: 3 }, { px: 99, sz: 1, total: 4 }],
      asks: [{ px: 101, sz: 1, total: 1 }, { px: 102, sz: 1, total: 2 }],
      spread: 1, spreadPct: 1,
    };
    const r = bookImbalance(book as never, 2);
    expect(r.bidPct).toBeCloseTo(66.67, 1); // 4 / (4+2)
    expect(r.askPct).toBeCloseTo(33.33, 1);
  });

  it("returns 50/50 for an empty book", () => {
    expect(bookImbalance({ bids: [], asks: [], spread: 0, spreadPct: 0 } as never, 5)).toEqual({ bidPct: 50, askPct: 50 });
  });
});
```

- [x] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/hyperliquid/bookImbalance.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement** — `src/lib/hyperliquid/bookImbalance.ts`:

```ts
import type { Orderbook } from "./types";

/** Bid/ask share of cumulative size across the top `depth` levels (a liquidity skew, not positioning). */
export function bookImbalance(book: Orderbook, depth = 10): { bidPct: number; askPct: number } {
  const sum = (levels: { sz: number }[]) => levels.slice(0, depth).reduce((a, l) => a + l.sz, 0);
  const bid = sum(book.bids);
  const ask = sum(book.asks);
  const total = bid + ask;
  if (total === 0) return { bidPct: 50, askPct: 50 };
  return { bidPct: (bid / total) * 100, askPct: (ask / total) * 100 };
}
```

- [x] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/hyperliquid/bookImbalance.test.ts`
Expected: PASS.

- [x] **Step 5: Write the component test** — `src/components/BookImbalanceBar.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react-native";
import { BookImbalanceBar } from "./BookImbalanceBar";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("BookImbalanceBar", () => {
  it("labels both sides with percentages and an honest caption", () => {
    render(<BookImbalanceBar theme={t} bidPct={66.7} askPct={33.3} />);
    expect(screen.getByText(/Book imbalance/)).toBeTruthy();
    expect(screen.getByText(/66\.7%/)).toHaveStyle({ color: t.up });
    expect(screen.getByText(/33\.3%/)).toHaveStyle({ color: t.down });
  });
});
```

- [x] **Step 6: Run it, expect fail**

Run: `cd mobile && npx jest src/components/BookImbalanceBar.test.tsx`
Expected: FAIL (module not found).

- [x] **Step 7: Implement the component** — `src/components/BookImbalanceBar.tsx`:

```tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";

export function BookImbalanceBar({ theme, bidPct, askPct }: { theme: ThemeTokens; bidPct: number; askPct: number }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={[styles.caption, { color: theme.faint }]}>Book imbalance (top 10)</Text>
        <View style={styles.legend}>
          <Text style={[styles.pct, { color: theme.up }]}>{`B ${bidPct.toFixed(1)}%`}</Text>
          <Text style={[styles.pct, { color: theme.down }]}>{`${askPct.toFixed(1)}% A`}</Text>
        </View>
      </View>
      <View style={[styles.bar, { backgroundColor: withAlpha(theme.down, 0.25) }]}>
        <View style={[styles.fill, { width: `${bidPct}%`, backgroundColor: theme.up }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  caption: { fontFamily: fonts.body.regular, fontSize: 10.5 },
  legend: { flexDirection: "row", gap: 10 },
  pct: { fontFamily: fonts.mono.bold, fontSize: 10.5 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6 },
});
```

- [x] **Step 8: Run it, expect pass**

Run: `cd mobile && npx jest src/components/BookImbalanceBar.test.tsx`
Expected: PASS.

- [x] **Step 9: Wire into Market Detail** — in `src/screens/MarketDetailScreen.tsx`, import both, compute `const imb = orderbook ? bookImbalance(orderbook, 10) : { bidPct: 50, askPct: 50 };` and render `<BookImbalanceBar theme={theme} bidPct={imb.bidPct} askPct={imb.askPct} />` inside the order-book section (only when `orderbook` is present).

- [x] **Step 10: Full gates + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: 0 tsc; all green.

```bash
git add mobile/src/lib/hyperliquid/bookImbalance.ts mobile/src/lib/hyperliquid/bookImbalance.test.ts mobile/src/components/BookImbalanceBar.tsx mobile/src/components/BookImbalanceBar.test.tsx mobile/src/screens/MarketDetailScreen.tsx
git commit --no-verify -m "feat(mobile): order-book imbalance bar in Market Detail

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task A6: Trade percent-size row (wired to available balance)

Add a `useAvailableBalance` hook (connected wallet's `withdrawable` via `PositionsService.loadPortfolio`) and a `SizePercentRow` that sets `size = pct × (available × leverage) / price`.

**Files:**
- Create: `src/hooks/useAvailableBalance.ts`
- Test: `src/hooks/useAvailableBalance.test.ts`
- Create: `src/components/SizePercentRow.tsx`
- Test: `src/components/SizePercentRow.test.tsx`
- Modify: `src/screens/TradeScreen.tsx`

- [x] **Step 1: Write the hook test** — `src/hooks/useAvailableBalance.test.ts`:

```ts
import { renderHook, waitFor } from "@testing-library/react-native";
import { useAvailableBalance } from "./useAvailableBalance";
import type { PositionsService } from "../services/positionsData";

const svc = {
  loadPortfolio: jest.fn(async () => ({
    summary: { accountValue: 1000, totalNtlPos: 0, totalMarginUsed: 0, withdrawable: 800, totalUnrealizedPnl: 0 },
    positions: [],
  })),
} as unknown as PositionsService;

describe("useAvailableBalance", () => {
  it("returns the withdrawable balance for a valid address", async () => {
    const { result } = renderHook(() => useAvailableBalance(svc, "0x" + "a".repeat(40)));
    await waitFor(() => expect(result.current).toBe(800));
  });

  it("returns null for an invalid address and never fetches", () => {
    const { result } = renderHook(() => useAvailableBalance(svc, "0xabc"));
    expect(result.current).toBeNull();
  });
});
```

- [x] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/hooks/useAvailableBalance.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement the hook** — `src/hooks/useAvailableBalance.ts`:

```ts
import { useEffect, useState } from "react";
import type { PositionsService } from "../services/positionsData";
import { isValidAddress } from "./useViewOnlyPortfolio";

/** Connected wallet's withdrawable USDC (for percent sizing). Null until known / when address invalid. */
export function useAvailableBalance(service: PositionsService, address: string | null): number | null {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!address || !isValidAddress(address)) {
      setBalance(null);
      return;
    }
    let active = true;
    service
      .loadPortfolio(address)
      .then((p) => active && setBalance(p.summary.withdrawable))
      .catch(() => active && setBalance(null));
    return () => {
      active = false;
    };
  }, [service, address]);
  return balance;
}
```

- [x] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/hooks/useAvailableBalance.test.ts`
Expected: PASS.

- [x] **Step 5: Write the component test** — `src/components/SizePercentRow.test.tsx`:

```tsx
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { SizePercentRow } from "./SizePercentRow";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("SizePercentRow", () => {
  it("computes size = pct × (available × leverage) / price and reports it", () => {
    const onPick = jest.fn();
    render(<SizePercentRow theme={t} available={800} leverage={10} price={64000} onPick={onPick} />);
    fireEvent.press(screen.getByText("50%"));
    // 0.5 * (800*10)/64000 = 0.0625
    expect(onPick).toHaveBeenCalledWith("0.0625");
  });

  it("is inert (no value) when balance or price is missing", () => {
    const onPick = jest.fn();
    render(<SizePercentRow theme={t} available={null} leverage={10} price={64000} onPick={onPick} />);
    fireEvent.press(screen.getByText("50%"));
    expect(onPick).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 6: Run it, expect fail**

Run: `cd mobile && npx jest src/components/SizePercentRow.test.tsx`
Expected: FAIL (module not found).

- [x] **Step 7: Implement the component** — `src/components/SizePercentRow.tsx`:

```tsx
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";

const STEPS = [25, 50, 75, 100];

export function SizePercentRow({
  theme,
  available,
  leverage,
  price,
  onPick,
}: {
  theme: ThemeTokens;
  available: number | null;
  leverage: number;
  price: number;
  onPick: (size: string) => void;
}) {
  function pick(pct: number) {
    if (!available || price <= 0) return;
    const maxSize = (available * leverage) / price;
    onPick(((pct / 100) * maxSize).toString());
  }
  return (
    <View style={styles.row}>
      {STEPS.map((pct) => (
        <Pressable
          key={pct}
          onPress={() => pick(pct)}
          accessibilityRole="button"
          style={[styles.chip, { borderColor: theme.line }]}
        >
          <Text style={[styles.text, { color: theme.muted }]}>{`${pct}%`}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, marginBottom: 12 },
  chip: { flex: 1, alignItems: "center", paddingVertical: 8, borderWidth: 1, borderRadius: 8 },
  text: { fontFamily: fonts.mono.medium, fontSize: 12 },
});
```

- [x] **Step 8: Run it, expect pass**

Run: `cd mobile && npx jest src/components/SizePercentRow.test.tsx`
Expected: PASS.

- [x] **Step 9: Wire into Trade** — in `src/screens/TradeScreen.tsx`:
  1. imports: `import { SizePercentRow } from "../components/SizePercentRow";`, `import { useAvailableBalance } from "../hooks/useAvailableBalance";`, `import { PositionsService } from "../services/positionsData";`, `import { createPositionsInfoClient } from "../lib/hyperliquid/client";`
  2. add (near the other `useMemo`s): `const positionsSvc = useMemo(() => new PositionsService(createPositionsInfoClient(network)), [network]); const available = useAvailableBalance(positionsSvc, useWalletStore.getState().address);`
  3. render `<SizePercentRow theme={theme} available={available} leverage={leverage} price={Number(price)} onPick={edit(setSize)} />` directly below the Size `Field`.

- [x] **Step 10: Extend the Trade test** — in `src/screens/TradeScreen.test.tsx`, add `createPositionsInfoClient: () => ({})` to the existing `jest.mock("../lib/hyperliquid/client", …)` factory and `jest.mock("../services/positionsData", () => ({ PositionsService: class { async loadPortfolio() { return { summary: { withdrawable: 800 }, positions: [] }; } } }));`. Add a test: connected wallet + price 64000 + leverage default → pressing `50%` sets a size and the submit value reflects it (assert `screen.getByText("50%")` is present and pressing it doesn't throw).

- [x] **Step 11: Full gates + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest`
Expected: 0 tsc; all green.

```bash
git add mobile/src/hooks/useAvailableBalance.ts mobile/src/hooks/useAvailableBalance.test.ts mobile/src/components/SizePercentRow.tsx mobile/src/components/SizePercentRow.test.tsx mobile/src/screens/TradeScreen.tsx mobile/src/screens/TradeScreen.test.tsx
git commit --no-verify -m "feat(mobile): percent-size row wired to available balance in Trade

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase B — Wallet money movement (REQUIRES its own spec + security brainstorm before TDD)

> **STATUS: ✅ B1 (Withdraw) + B2a (Deposit address) SHIPPED 2026-06-23.** Brainstormed → spec
> (`docs/superpowers/specs/2026-06-23-wallet-money-movement-design.md`) → TDD. Withdraw via SDK
> `withdraw3` (validate-before-sign, uncertain-receipt honesty); Deposit address + Copy
> (expo-clipboard) + Arbitrum-bridge explainer. jest 424→431, tsc 0, Metro bundle OK. Commits:
> spec ddf79f1 · B1a d530adb · B1b/B2a f1036b4. **Deferred:** B2b (in-app Arbitrum transfer) +
> deposit QR — still need their own spec (notes below stand).

> **Gate:** Do **not** start Phase B as bite-sized tasks yet. Money movement crosses the Phase 2 wallet-security boundary and moves real funds. Run `superpowers:brainstorming` to produce a dedicated spec first, then a separate plan. The notes below define scope, the known-good API surface, and acceptance — they are the input to that brainstorm, not implementation steps.

### B1 — Withdraw (HL → address), feasible via SDK
- **API:** `ExchangeClient.withdraw3({ destination, amount })` exists in `@nktkas/hyperliquid` (`src/api/exchange/_methods/withdraw3.ts`). Add a `withdrawUsdc(destination, amount)` method to `src/services/exchange.ts` mirroring `placeOrder`'s care (validate amount > 0 and ≤ withdrawable; normalize the response; surface success/failure honestly; **never** assume success on an uncertain receipt).
- **UI:** a Withdraw sheet (amount + destination, default destination = own address, show HL withdraw fee, double-confirm). Reuse `SurfaceCard`, tokens, `NetworkWarning` strip.
- **Safety:** default testnet; explicit confirm; show the exact amount + fee + destination before signing; disable when view-only.
- **Acceptance:** TDD with an injected fake `ExchangeClient.withdraw3`; assert validation rejects over-balance/invalid-address without calling the SDK; assert a confirmed valid request calls `withdraw3` with the exact `{ destination, amount }`; no real network in tests.
- **Open questions for brainstorm:** withdraw fee display source; min-withdraw; testnet vs mainnet bridge behavior; how to confirm finality (poll vs. fire-and-disclose like orders).

### B2 — Deposit (address/QR first; in-app Arbitrum transfer later)
- **Reality:** HL deposit = an **Arbitrum** USDC ERC-20 transfer to the HL bridge contract — not an HL action. In-app signing needs an EVM transport (Arbitrum RPC), the USDC contract address, the bridge address, gas handling, and confirmation tracking — new infrastructure beyond the current HL-only client.
- **Phase B2a (small, safe, shippable):** replace the placeholder Alert with a **deposit-address view**: show the wallet's own address + a QR (add `react-native-qrcode-svg`, OFL/MIT) + copy button + a clear "send USDC on Arbitrum to the Hyperliquid bridge" explainer. No signing. TDD the address/QR/copy rendering.
- **Phase B2b (larger, needs spec):** in-app Arbitrum USDC transfer (EVM transport + USDC/bridge constants + gas + tx tracking). Own spec.
- **Acceptance (B2a):** address + QR render for a connected wallet; copy action fires; view-only shows the address read-only.

---

## Phase C — Strategy automation engine (SEPARATE greenfield project — brainstorm + spec required)

> **Gate:** The Strategy screen is currently a mock shell. Making it real is a **new subsystem**, not a UI follow-up. It needs its own `superpowers:brainstorming` session and a dedicated multi-phase plan. Do not TDD it from this document.

- **Scope:** a strategy/automation domain — strategy definitions (Grid / DCA / TWAP / TP-SL), persistence (likely `expo-sqlite`, the existing storage), a scheduler/execution loop that places child orders through the **existing** `ExchangeService` (reusing the cloid idempotency + `IntentLedger`), risk guardrails (max leverage, daily-loss cap, kill switch), and lifecycle (start/pause/stop) with honest running/return state.
- **Hard constraints:** background execution on mobile is limited (no guaranteed always-on); decide explicitly whether execution is device-local (only while the app runs) or server-assisted — this is the central design question for the brainstorm. Reuse the encoding core and ledger; never bypass the idempotency kernel.
- **Why separate:** unspecified product semantics (what each strategy actually does, fill handling, partial-fill/restart recovery) + execution-environment decisions make detailed TDD premature. Producing fabricated task code here would violate the no-placeholder rule.
- **First brainstorm questions:** local vs. server execution? which strategy types ship first (recommend DCA — simplest, schedulable)? persistence schema for strategies + their child intents? how kill-switch interacts with in-flight orders?

---

## Self-Review

- **Spec coverage:** Market Detail OI ✓ A1; multi-period ✓ A2; indicators ✓ A3 (MA/EMA/BOLL) + A4 (RSI) — VOL/MACD/KDJ deferred (noted, low value vs. cost); long/short ✓ A5 (honest book-imbalance, since true L/S has no data source); Trade percent slider ✓ A6; Wallet Deposit/Withdraw → Phase B (gated, with the feasible `withdraw3` path mapped); Strategy real data → Phase C (gated). Every recorded deviation maps to a task or an explicitly-gated stage.
- **Placeholders:** Phase A tasks contain complete code + exact paths + commands. Phase B/C are intentionally specs-to-brainstorm, not fake tasks — this is the skill's Scope Check ("break subsystems into separate plans"), not a placeholder.
- **Type consistency:** `PeriodReturn` (A2) reused in `MultiPeriodReturns`; `sma/ema/bollinger/rsi` (A3) reused by A3/A4; `bookImbalance` shape `{bidPct,askPct}` matches `BookImbalanceBar` props (A5); `MarketTicker.openInterest?` optional so existing fixtures stay valid (A1).
