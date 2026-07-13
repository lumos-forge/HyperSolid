# Scheduled Order Live Countdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, per-minute countdown ("Buy 100 · 2h 15m left") to the `scheduled` strategy's row in the Strategy tab, derived purely on the client from `params.runAt`.

**Architecture:** A pure `formatCountdown(ms)` helper renders the duration; `AgentScreen` runs a single 60 s `setInterval` that updates a `now` state, threaded into each `StrategyRow` as a prop; the scheduled subtitle branch recomputes from `runAt - now` with edge handling for imminent/paused.

**Tech Stack:** Expo RN + TypeScript, jest-expo + @testing-library/react-native, i18n via `useT()` (en default, en+zh parity enforced by `messages.test.ts`).

Spec: `docs/superpowers/specs/2026-07-13-scheduled-countdown-design.md`
Branch: `feat/scheduled-countdown`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: `formatCountdown` pure helper

**Files:**
- Create: `mobile/src/lib/formatCountdown.ts`
- Test: `mobile/src/lib/formatCountdown.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { formatCountdown } from "./formatCountdown";

describe("formatCountdown", () => {
  it("shows minutes only under one hour", () => {
    expect(formatCountdown(900_000)).toBe("15m"); // 15m
    expect(formatCountdown(60_000)).toBe("1m");
    expect(formatCountdown(30_000)).toBe("0m"); // sub-minute rounds down
  });
  it("shows hours and minutes at or above one hour", () => {
    expect(formatCountdown(3_600_000)).toBe("1h 0m");
    expect(formatCountdown(8_100_000)).toBe("2h 15m"); // 2h15m
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/lib/formatCountdown.test.ts`
Expected: FAIL (Cannot find module './formatCountdown').

- [ ] **Step 3: Write minimal implementation**

```ts
/** Format a positive remaining duration (ms) as "2h 15m" or, under one hour, "15m". */
export function formatCountdown(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/lib/formatCountdown.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/formatCountdown.ts mobile/src/lib/formatCountdown.test.ts
git commit -m "feat: formatCountdown helper for scheduled countdown"
```

---

### Task 2: i18n keys (en + zh)

**Files:**
- Modify: `mobile/src/i18n/messages.ts` (en block near `agent.strategyScheduled`; zh block likewise)

- [ ] **Step 1: Add the two keys to the EN block**

After `"agent.strategyScheduled": "{coin} Scheduled",` add:
```
    "agent.schedCountdown": "{time} left",
    "agent.schedImminent": "Executing soon",
```

- [ ] **Step 2: Add the two keys to the ZH block**

After `"agent.strategyScheduled": "{coin} 定时单",` add:
```
    "agent.schedCountdown": "剩 {time}",
    "agent.schedImminent": "即将执行",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `cd mobile && npx jest src/i18n/messages.test.ts`
Expected: PASS (parity holds).

- [ ] **Step 4: Commit**

```bash
git add mobile/src/i18n/messages.ts
git commit -m "feat: i18n keys for scheduled countdown (en+zh)"
```

---

### Task 3: Minute tick + scheduled subtitle countdown

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx` (react import line 1; add `now` state + effect in the `AgentScreen` component; pass `now` to `StrategyRow` at line 304; extend `StrategyRow` signature line 569-573; replace the scheduled subtitle branch; import `formatCountdown`)
- Test: `mobile/src/screens/AgentScreen.test.tsx` (add two tests after the existing scheduled tests)

- [ ] **Step 1: Write the failing tests**

Add after the "does not create a scheduled order with a non-positive delay" test in `AgentScreen.test.tsx`:
```tsx
  it("shows a live countdown for a running scheduled strategy", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "sc1", type: "scheduled", status: "running", params: { coin: "ETH", side: "buy", sizeUsdc: 100, runAt: Date.now() + 2 * 3600000 + 90_000 } },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-sc1")).toBeTruthy());
    expect(screen.getByText(/^Buy 100 · \d+h \d+m left$/)).toBeTruthy();
  });

  it("omits the countdown for a paused scheduled strategy", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "sc2", type: "scheduled", status: "paused", params: { coin: "ETH", side: "buy", sizeUsdc: 100, runAt: Date.now() + 2 * 3600000 } },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-sc2")).toBeTruthy());
    expect(screen.getByText("Buy 100")).toBeTruthy();
    expect(screen.queryByText(/left/)).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "countdown"`
Expected: FAIL (running row currently renders "Buy 100" with no " left"; the first test's regex won't match).

- [ ] **Step 3: Import useEffect and formatCountdown**

Change line 1:
```ts
import React, { useEffect, useMemo, useState } from "react";
```
Add to the `../services/strategyApi` import area (or a new import line near the other lib imports):
```ts
import { formatCountdown } from "../lib/formatCountdown";
```

- [ ] **Step 4: Add the minute-tick state + effect in `AgentScreen`**

Near the other `useState` calls in the `AgentScreen` component body (e.g. after `const [token, setToken] = useState<string | null>(null);`), add:
```ts
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
```

- [ ] **Step 5: Pass `now` into each row**

At line ~304, change the row render to pass `now`:
```tsx
        ctrl.strategies.map((s) => <StrategyRow key={s.id} theme={theme} strategy={s} now={now} onToggle={() => void ctrl.toggle(s)} getRungs={(id) => api.getRungs(id)} />)
```

- [ ] **Step 6: Extend the `StrategyRow` signature**

Change lines 569-573:
```tsx
function StrategyRow({
  theme, strategy, now, onToggle, getRungs,
}: {
  theme: ThemeTokens; strategy: Strategy; now: number; onToggle: () => void; getRungs?: (id: string) => Promise<Rung[]>;
}) {
```

- [ ] **Step 7: Replace the scheduled subtitle branch**

Replace the current scheduled subtitle branch (the `: strategy.type === "scheduled" ? \`${t(...)} ${...sizeUsdc}\`` block inside the `sub` ternary) with:
```tsx
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

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx -t "countdown"`
Expected: PASS (2 tests).

- [ ] **Step 9: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (≈138 suites).

- [ ] **Step 10: Commit**

```bash
git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx
git commit -m "feat: live per-minute countdown on scheduled strategy rows"
```

---

### Task 4: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/scheduled-countdown
gh pr create --title "feat: scheduled-order live countdown in strategy list" --body-file <body>
```
Body: summarize helper + minute-tick + subtitle branch + i18n + tests + validation.

- [ ] **Step 3: Code review + CI**

Dispatch the code-review agent (background) and `gh pr checks <n> --watch` in parallel.

- [ ] **Step 4: Merge**

On clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** helper (Task 1) ✔, i18n (Task 2) ✔, minute tick + subtitle edge rules running/imminent/paused (Task 3) ✔, tests for pure fn + running/paused rows (Tasks 1,3) ✔, no server change ✔.
- **Placeholder scan:** none — all steps carry concrete code/commands.
- **Type consistency:** `formatCountdown(ms: number): string` used identically in Task 1 and Task 3; `now: number` prop added in signature (Step 6) and passed (Step 5); `ScheduledParams` already imported in AgentScreen (from the scheduled-mobile unit).
- **Test locale:** en is the default locale, so row assertions use English (`Buy`, `… left`), matching existing tests (`"BTC Grid"`).
