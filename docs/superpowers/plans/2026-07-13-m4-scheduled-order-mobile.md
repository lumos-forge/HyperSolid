# Plan: M4 Scheduled Order — Mobile Create Form

Spec: `docs/superpowers/specs/2026-07-13-m4-scheduled-order-mobile-design.md`
Branch: `feat/m4-scheduled-order-mobile`

Mirrors the merged conditional-mobile unit (PR #86). All changes in `mobile/`.
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

## Task 1 — Types + controller

**`mobile/src/services/strategyApi.ts`**
- Extend `StrategyType` (line 37 region — actually the `type StrategyType` decl): append `| "scheduled"`.
- Add interface (after `ConditionalParams`):
  ```ts
  export interface ScheduledParams extends StrategyParamsCommon {
    coin: string;
    side: "buy" | "sell";
    sizeUsdc: number;
    runAt: number;
  }
  ```
  (Match the exact `extends`/common base used by `ConditionalParams`.)
- `StrategyParams` union (line 37): append `| ScheduledParams`.

**`mobile/src/hooks/useStrategyController.ts`**
- Import `ScheduledParams` alongside `ConditionalParams`.
- After `createConditional` (line 78 block), add:
  ```ts
  const createScheduled = useCallback(async (params: ScheduledParams) => {
    await api.createStrategy("scheduled", params);
    await refresh();
  }, [api, refresh]);
  ```
- Return object (line 96): add `createScheduled` after `createConditional`.

**Verify:** `cd mobile && npx tsc --noEmit` (green).

---

## Task 2 — i18n keys (en + zh)

**`mobile/src/i18n/messages.ts`** — add 6 keys in BOTH blocks (parity enforced by `messages.test.ts`).

En block (near lines 316 / 350):
```
"agent.templateScheduled": "Scheduled",
"agent.newScheduled": "New scheduled order",
"agent.createScheduled": "Create scheduled order",
"agent.schedDelay": "Run in (hours)",
"agent.invalidScheduled": "Enter a positive size and delay",
"agent.strategyScheduled": "{coin} Scheduled",
```
Zh block (near lines 816 / 850):
```
"agent.templateScheduled": "定时单",
"agent.newScheduled": "新建定时单",
"agent.createScheduled": "创建定时单",
"agent.schedDelay": "多少小时后执行",
"agent.invalidScheduled": "请填写正数的金额与延时",
"agent.strategyScheduled": "{coin} 定时单",
```
Place `strategyScheduled` next to `strategyConditional`; the rest next to `invalidConditional`.

**Verify:** `cd mobile && npm test -- messages` (i18n parity green).

---

## Task 3 — AgentScreen template, form, StrategyRow, tests (TDD)

**Write the test FIRST** in `mobile/src/screens/AgentScreen.test.tsx` (after the conditional create test):
- Render `<AgentScreen />`, connect (`strategy-connect-btn`), `await waitFor`.
- Capture `const before = Date.now();`.
- Press `template-scheduled`; type `coin` "ETH" (shared coin field), press `sched-side-buy`,
  type `sched-size` "100", `sched-delay` "2", press `sched-create`.
- `await waitFor(() => expect(mockApiFake.createStrategy).toHaveBeenCalledWith("scheduled", expect.objectContaining({ coin: "ETH", side: "buy", sizeUsdc: 100 })));`
- Capture the scheduled call args; assert its `runAt` is a future-window number:
  ```ts
  const call = mockApiFake.createStrategy.mock.calls.find((c) => c[0] === "scheduled")!;
  const runAt = (call[1] as any).runAt;
  expect(runAt).toBeGreaterThanOrEqual(before + 2 * 3600000);
  expect(runAt).toBeLessThanOrEqual(Date.now() + 2 * 3600000);
  ```
- Second test: invalid delay ("0") does NOT call `createStrategy("scheduled", …)`.

Run test → RED (feature absent).

**Then implement in `mobile/src/screens/AgentScreen.tsx`:**
1. `Template` type: append `| "scheduled"`.
2. Picker array (305): append `"scheduled"`; label ternary (320-321): change tail to
   `... : k === "conditional" ? "agent.templateConditional" : "agent.templateScheduled"`.
3. State (near line 168): `schedSide` (default `"buy"`), `schedSize` (`""`), `schedDelay` (`""`).
4. Handler (after `onCreateConditional`, ~242):
   ```ts
   async function onCreateScheduled() {
     const size = Number(schedSize), hrs = Number(schedDelay);
     if (!(size > 0) || !(hrs > 0)) { Alert.alert(t("agent.invalidParams"), t("agent.invalidScheduled")); return; }
     const runAt = Math.round(Date.now() + hrs * 3600000);
     await ctrl.createScheduled({ coin: coin.toUpperCase(), side: schedSide, sizeUsdc: size, runAt, ...(deadMan ? { deadMan: true } : {}) });
     setSchedSize(""); setSchedDelay("");
   }
   ```
   (Match the exact `Alert.alert` invalid-title key and `deadMan` spread used by `onCreateConditional`.)
5. Form card after the conditional card (~431), rendered when `template === "scheduled"`:
   header `agent.newScheduled`; shared coin Field; a side segmented selector
   (`sched-side-buy`/`sched-side-sell` → `setSchedSide`, mirroring the twap/conditional
   side selector markup + `styles.sideRow/sideBtns/sideBtn/segmentText`); size Field
   (`sched-size`, label `agent.condSize`, numeric); delay Field (`sched-delay`, label
   `agent.schedDelay`, numeric); create `Pressable` (`sched-create`, label
   `agent.createScheduled`).
6. StrategyRow title chain (after line 556, before the DCA fallback 557):
   `: strategy.type === "scheduled" ? t("agent.strategyScheduled", { coin: (strategy.params as ScheduledParams).coin })`.
7. StrategyRow subtitle chain (after line 577, before the DCA fallback 578):
   ```ts
   : strategy.type === "scheduled"
   ? `${t((strategy.params as ScheduledParams).side === "buy" ? "agent.buy" : "agent.sell")} ${(strategy.params as ScheduledParams).sizeUsdc}`
   ```
8. Import `ScheduledParams` from `../services/strategyApi` (alongside `ConditionalParams`).

Run test → GREEN.

**Verify:** `cd mobile && npx tsc --noEmit && npm test` (full suite green).

---

## Task 4 — Roadmap doc + full validation + PR

- `docs/BACKEND-ARCHITECTURE.md`: the M4 scheduled row annotation ending
  `mobile 建仓 UI 待做` → mark the mobile create form as landed (e.g.
  `mobile 建仓 UI ✅` / remove the 待做 note), matching how trailing/conditional rows read.
- Full validation: `cd mobile && npx tsc --noEmit && npm test` (expect ~138 suites green).
- Commit; push `feat/m4-scheduled-order-mobile`.
- `gh pr create` (title `feat(m4): scheduled-order mobile create form`, body summarizing
  the template/form/StrategyRow/i18n + validation).
- Dispatch code-review agent (background) + `gh pr checks --watch` in parallel.
  **Proactively confirm the StrategyRow scheduled title+subtitle cases are present**
  (the #86 lesson) so it isn't flagged.
- On clean review + green CI: `gh pr merge --squash --delete-branch`; sync `main`.

---

## Completion criteria
- `scheduled` selectable in the template picker; form creates a strategy with a computed
  future `runAt`; list row renders `{coin} 定时单 · buy/sell size` (not the DCA fallback).
- `npx tsc --noEmit` + full jest green; i18n parity green.
- PR reviewed, CI green, squash-merged, branch deleted, main synced.
