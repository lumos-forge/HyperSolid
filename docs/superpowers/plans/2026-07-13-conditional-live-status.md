# Conditional Order Live Mark-Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live `Mark 2950 · To trigger +1.7%` line on each conditional strategy row, powered by a markets feed mounted on the Strategy panel.

**Architecture:** A pure `pctToTrigger(mark, trigger)` helper computes the signed distance; `StrategyPanel` mounts `useLiveMarkets(new MarketDataService(createInfoClient, createSubsClient))` to feed `useMarketStore`; the row map passes each conditional's coin mark into `StrategyRow`, which renders a second hint line when a mark is present.

**Tech Stack:** Expo RN + TypeScript, jest-expo + @testing-library/react-native, zustand market store, i18n via `useT()` (en default, en+zh parity enforced by `messages.test.ts`).

Spec: `docs/superpowers/specs/2026-07-13-conditional-live-status-design.md`
Branch: `feat/conditional-live-status`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: `pctToTrigger` pure helper

**Files:**
- Create: `mobile/src/lib/pctToTrigger.ts`
- Test: `mobile/src/lib/pctToTrigger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { pctToTrigger } from "./pctToTrigger";

describe("pctToTrigger", () => {
  it("is positive when the mark must rise to reach the trigger", () => {
    expect(pctToTrigger(2950, 3000)).toBeCloseTo(1.695, 2);
  });
  it("is negative when the mark must fall to reach the trigger", () => {
    expect(pctToTrigger(2950, 2900)).toBeCloseTo(-1.695, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/lib/pctToTrigger.test.ts`
Expected: FAIL (Cannot find module './pctToTrigger').

- [ ] **Step 3: Write minimal implementation**

```ts
/** Signed % the mark must still move to reach the trigger: (trigger - mark) / mark * 100. */
export function pctToTrigger(mark: number, triggerPrice: number): number {
  return ((triggerPrice - mark) / mark) * 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/lib/pctToTrigger.test.ts`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/pctToTrigger.ts mobile/src/lib/pctToTrigger.test.ts
git commit -m "feat: pctToTrigger helper for conditional live status"
```

---

### Task 2: i18n keys (en + zh)

**Files:**
- Modify: `mobile/src/i18n/messages.ts` (en + zh blocks; place near the other `agent.cond*` keys, e.g. after `agent.condBelow`)

- [ ] **Step 1: Add keys to the EN block**

After `"agent.condBelow": "Below",` add:
```
    "agent.condNow": "Mark",
    "agent.condDistance": "To trigger",
```

- [ ] **Step 2: Add keys to the ZH block**

After `"agent.condBelow": "跌破",` add:
```
    "agent.condNow": "现价",
    "agent.condDistance": "距触发",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/i18n/messages.ts
git commit -m "feat: i18n keys for conditional live status (en+zh)"
```

---

### Task 3: Live feed + conditional status line (TDD)

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx` (imports; `StrategyPanel` feed; row map `mark` prop; `StrategyRow` prop + `condStatus` line)
- Test: `mobile/src/screens/AgentScreen.test.tsx` (extend client mock, mock `useLiveMarkets`, import `useMarketStore`; add two tests)

- [ ] **Step 1: Extend the test mocks**

In `AgentScreen.test.tsx`:
- Add `import { useMarketStore } from "../state/marketStore";` near the other imports.
- Change the client mock to also stub the info/subs factories:
  ```ts
  jest.mock("../lib/hyperliquid/client", () => ({
    createExchangeClient: jest.fn(() => ({})),
    createInfoClient: jest.fn(() => ({})),
    createSubsClient: jest.fn(() => ({})),
  }));
  ```
- Add a no-op mock so tests never open a real socket:
  ```ts
  jest.mock("../hooks/useLiveMarkets", () => ({ useLiveMarkets: jest.fn() }));
  ```
- In `beforeEach`, reset the store so tests are isolated:
  ```ts
  useMarketStore.setState({ tickers: [] });
  ```

- [ ] **Step 2: Write the failing tests**

Add after the cancel tests. Define a ticker fixture helper at the top of the test (near `localWallet`):
```ts
const ethTicker = { coin: "ETH", midPx: 2950, prevDayPx: 2900, changePct: 1.7, funding: 0, dayNtlVlm: 0, maxLeverage: 20, szDecimals: 4 };
```
Then:
```tsx
  it("shows the live mark and distance on a conditional row", async () => {
    useMarketStore.setState({ tickers: [ethTicker] });
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "cd1", type: "conditional", status: "running", params: { coin: "ETH", side: "buy", sizeUsdc: 100, triggerPrice: 3000, triggerDirection: "above" } },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("cond-status-cd1")).toBeTruthy());
    expect(screen.getByText(/Mark 2950 · To trigger \+1\.7%/)).toBeTruthy();
  });

  it("omits the conditional status line when there is no mark", async () => {
    useMarketStore.setState({ tickers: [] });
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "cd2", type: "conditional", status: "running", params: { coin: "ETH", side: "buy", sizeUsdc: 100, triggerPrice: 3000, triggerDirection: "above" } },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-cd2")).toBeTruthy());
    expect(screen.queryByTestId("cond-status-cd2")).toBeNull();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "conditional row\|conditional status"`
Expected: FAIL (no `cond-status-cd1`).

- [ ] **Step 4: Add imports to AgentScreen.tsx**

Add near the existing imports:
```ts
import { formatPrice } from "../components/PriceText";
import { pctToTrigger } from "../lib/pctToTrigger";
import { MarketDataService } from "../services/marketData";
import { useLiveMarkets } from "../hooks/useLiveMarkets";
import { useMarketStore } from "../state/marketStore";
import { createInfoClient, createSubsClient } from "../lib/hyperliquid/client";
```
(If `createExchangeClient` is already imported from `../lib/hyperliquid/client`, add `createInfoClient, createSubsClient` to that existing import instead of a duplicate line.)

- [ ] **Step 5: Mount the live feed in `StrategyPanel`**

Just after `const t = useT();` (and the existing `now` tick) in `StrategyPanel`, add:
```ts
  const marketData = useMemo(
    () => new MarketDataService(createInfoClient(network), createSubsClient(network)),
    [network],
  );
  useLiveMarkets(marketData);
  const tickers = useMarketStore((s) => s.tickers);
```

- [ ] **Step 6: Pass `mark` into conditional rows**

In the `ctrl.strategies.map((s) => <StrategyRow … />)`, add the prop:
```tsx
        ctrl.strategies.map((s) => <StrategyRow key={s.id} theme={theme} strategy={s} now={now} mark={s.type === "conditional" ? tickers.find((tk) => tk.coin === (s.params as ConditionalParams).coin)?.midPx : undefined} onToggle={() => void ctrl.toggle(s)} onCancel={() => void ctrl.cancel(s.id)} getRungs={(id) => api.getRungs(id)} />)
```

- [ ] **Step 7: Extend the `StrategyRow` signature**

```tsx
function StrategyRow({
  theme, strategy, now, mark, onToggle, onCancel, getRungs,
}: {
  theme: ThemeTokens; strategy: Strategy; now: number; mark?: number; onToggle: () => void; onCancel: () => void; getRungs?: (id: string) => Promise<Rung[]>;
}) {
```

- [ ] **Step 8: Compute + render the status line**

After the `sub` computation and before `const info = (`, add:
```ts
  const fmtSignedPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
  const condStatus =
    strategy.type === "conditional" && mark != null
      ? `${t("agent.condNow")} ${formatPrice(mark)} · ${t("agent.condDistance")} ${fmtSignedPct(pctToTrigger(mark, (strategy.params as ConditionalParams).triggerPrice))}`
      : null;
```
Then update the `info` block to render a second hint line:
```tsx
  const info = (
    <>
      <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.hint, { color: theme.muted }]}>{sub}</Text>
      {condStatus ? <Text style={[styles.hint, { color: theme.muted }]} testID={`cond-status-${strategy.id}`}>{condStatus}</Text> : null}
    </>
  );
```
(Match the exact current `info` JSX — replace it wholesale with the version above.)

- [ ] **Step 9: Run the conditional tests to verify they pass**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "conditional row\|conditional status"`
Expected: PASS (2 tests).

- [ ] **Step 10: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 11: Commit**

```bash
git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx
git commit -m "feat: live mark + distance-to-trigger on conditional strategy rows"
```

---

### Task 4: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/conditional-live-status
gh pr create --title "feat: conditional order live mark-status in the strategy list" --body-file <body>
```
Body: summarize helper + Strategy-panel live feed (reusing useLiveMarkets/MarketDataService) + conditional second line + i18n + tests + validation; note the scope finding (this is the first place that mounts a live markets feed).

- [ ] **Step 3: Code review + CI**

Dispatch the code-review agent (background) + `gh pr checks <n> --watch` in parallel.

- [ ] **Step 4: Merge**

On clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** helper (Task 1) ✔, i18n (Task 2) ✔, live feed on StrategyPanel + conditional second line + no-mark omission (Task 3) ✔, tests for pure fn + live/absent mark (Tasks 1,3) ✔, test-mock isolation so no real socket opens (Task 3 Step 1) ✔.
- **Placeholder scan:** none — all steps carry concrete code/commands.
- **Type consistency:** `pctToTrigger(mark, triggerPrice)` identical in Tasks 1 & 3; `mark?: number` prop added (Step 7) and passed (Step 6); `MarketDataService(info, subs)` and `createInfoClient/createSubsClient(network)` signatures match the existing factories.
- **Test locale:** en default, so assertions use `Mark` / `To trigger`, matching the en i18n values.
