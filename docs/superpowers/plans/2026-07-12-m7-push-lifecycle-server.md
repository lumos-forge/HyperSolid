# M7 P4.5-server — Strategy-Completed Push + `lifecycle` Category — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a localized "strategy completed" push (new `lifecycle` category) when a TWAP finishes its slices or a TP/SL triggers, gated by per-owner prefs and quiet hours.

**Architecture:** Widen `PushCategory` with `lifecycle` (default on); add a localized `strategyCompletedNotification`; observe `running→completed` transitions via a `NotifyingStrategyStore` decorator (mirroring `NotifyingActivityStore`); make quiet hours cover `{fills, lifecycle}`; expose `lifecycle` through `/push/prefs`; wire the decorator in `index.ts`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, jest.

Spec: `docs/superpowers/specs/2026-07-12-m7-push-lifecycle-server-design.md`

---

## Task 1: Add the `lifecycle` category to prefs + messages + catalog

Widening `PushCategory` ripples into the catalog and prefs together, so this is one
commit. (`set` already iterates `CATEGORIES`, so adding to the list covers writes.)

**Files:**
- Modify: `server/src/push/pushPrefStore.ts`
- Modify: `server/src/push/pushPrefStore.test.ts`
- Modify: `server/src/push/messages.ts`
- Modify: `server/src/push/notifications.ts`
- Modify: `server/src/push/notifications.test.ts`

- [ ] **Step 1: Update the prefs tests**

In `server/src/push/pushPrefStore.test.ts`, update the two default-shape assertions
and add a lifecycle case. Replace:
```ts
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true });
```
with:
```ts
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true, lifecycle: true });
```
Replace:
```ts
    expect(s.get(OWNER)).toEqual({ fills: false, alerts: true });
```
with:
```ts
    expect(s.get(OWNER)).toEqual({ fills: false, alerts: true, lifecycle: true });
```
Then add, inside the `describe`, a new test:
```ts
  it("persists a disabled lifecycle category", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { lifecycle: false }, 1000);
    expect(s.isEnabled(OWNER, "lifecycle")).toBe(false);
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true, lifecycle: false });
  });
```

- [ ] **Step 2: Add the catalog test**

In `server/src/push/notifications.test.ts`, add the import if missing and a new test.
At the top, ensure the import line includes `strategyCompletedNotification`:
```ts
import { fillNotification, deadManAlertNotification, deadManRecoveredNotification, strategyCompletedNotification } from "./notifications";
```
Add this test inside the `describe("notification catalog", ...)` block:
```ts
  it("strategyCompletedNotification en/zh", () => {
    const s = { id: "s1", kind: "twap", owner: "0xabc", params: { coin: "ETH" } } as any;
    const en = strategyCompletedNotification(s, "en");
    expect(en.title).toBe("Strategy completed");
    expect(en.body).toBe("Your ETH twap strategy finished.");
    expect(en.data).toEqual({ kind: "strategy_completed", strategyId: "s1", strategyKind: "twap", coin: "ETH" });
    expect(strategyCompletedNotification(s, "zh").title).toBe("策略已完成");
    expect(strategyCompletedNotification(s, "zh").body).toBe("你的 ETH twap 策略已完成。");
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx jest src/push/pushPrefStore.test.ts src/push/notifications.test.ts`
Expected: FAIL — `lifecycle` missing from `PushPrefs`/defaults and
`strategyCompletedNotification` does not exist.

- [ ] **Step 4: Widen `PushCategory` / `PushPrefs` / defaults**

In `server/src/push/pushPrefStore.ts`, replace:
```ts
export type PushCategory = "fills" | "alerts";

export interface PushPrefs {
  fills: boolean;
  alerts: boolean;
}
```
with:
```ts
export type PushCategory = "fills" | "alerts" | "lifecycle";

export interface PushPrefs {
  fills: boolean;
  alerts: boolean;
  lifecycle: boolean;
}
```
Replace:
```ts
const CATEGORIES: PushCategory[] = ["fills", "alerts"];
```
with:
```ts
const CATEGORIES: PushCategory[] = ["fills", "alerts", "lifecycle"];
```
Replace the `get` return:
```ts
    return {
      fills: map.get("fills") ?? true,
      alerts: map.get("alerts") ?? true,
    };
```
with:
```ts
    return {
      fills: map.get("fills") ?? true,
      alerts: map.get("alerts") ?? true,
      lifecycle: map.get("lifecycle") ?? true,
    };
```

- [ ] **Step 5: Add the catalog copy + builder**

In `server/src/push/messages.ts`, add to the `en` block after `deadmanRecoveredBody`:
```ts
    lifecycleTitle: "Strategy completed",
    lifecycleBody: (coin: string, kind: string) => `Your ${coin} ${kind} strategy finished.`,
```
and to the `zh` block after its `deadmanRecoveredBody`:
```ts
    lifecycleTitle: "策略已完成",
    lifecycleBody: (coin: string, kind: string) => `你的 ${coin} ${kind} 策略已完成。`,
```

In `server/src/push/notifications.ts`, add the import for the strategy type at the top
(next to the existing `Activity` import):
```ts
import type { Strategy } from "../strategies/types";
```
and append the builder at the end of the file:
```ts
/** Strategy-completed notification, localized. */
export function strategyCompletedNotification(s: Strategy, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  const coin = (s.params as { coin?: string }).coin ?? "";
  return {
    title: m.lifecycleTitle,
    body: m.lifecycleBody(coin, s.kind),
    data: { kind: "strategy_completed", strategyId: s.id, strategyKind: s.kind, coin },
  };
}
```
(`notifications.ts` already imports `pushMessages` and `PushLocale` from `./messages`
and `Notification` from `./notifier` for the existing builders.)

- [ ] **Step 6: Run the tests to verify they pass + typecheck**

Run: `cd server && npx jest src/push/pushPrefStore.test.ts src/push/notifications.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/pushPrefStore.ts server/src/push/pushPrefStore.test.ts server/src/push/messages.ts server/src/push/notifications.ts server/src/push/notifications.test.ts && git commit -m "feat(push): add lifecycle category + strategyCompletedNotification"
```

---

## Task 2: Quiet hours covers `lifecycle`

**Files:**
- Modify: `server/src/push/notifier.ts`
- Modify: `server/src/push/notifier.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/push/notifier.test.ts`, add this test just before the final `});` of
the `describe("Notifier.notify", ...)` block:
```ts
  it("suppresses lifecycle during quiet hours", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const quietHours = { isQuietNow: () => true };
    const res = await new Notifier({ expo, store, quietHours, now: () => 0 }).notify(OWNER, "lifecycle", () => N);
    expect(res).toEqual({ tokens: 0, sent: 0, errors: 0, pruned: 0 });
    expect(expo.sends).toHaveLength(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/notifier.test.ts -t "lifecycle during quiet"`
Expected: FAIL — lifecycle is not yet quietable, so the notification is sent.

- [ ] **Step 3: Make quiet hours cover the quietable set**

In `server/src/push/notifier.ts`, add a module-level set near the top (after the
`EXPO_PUSH_TOKEN` const):
```ts
// Non-safety categories that quiet hours may suppress. `alerts` always sends.
const QUIETABLE = new Set<PushCategory>(["fills", "lifecycle"]);
```
(`PushCategory` is already imported from `./pushPrefStore`.)

Replace the quiet-hours gate condition:
```ts
    if (category === "fills" && this.quietHours) {
```
with:
```ts
    if (QUIETABLE.has(category) && this.quietHours) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest src/push/notifier.test.ts`
Expected: PASS — lifecycle + fills suppressed in quiet hours; the existing "always
sends alerts even during quiet hours" test still passes.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifier.ts server/src/push/notifier.test.ts && git commit -m "feat(push): quiet hours suppresses lifecycle too (alerts still bypass)"
```

---

## Task 3: `NotifyingStrategyStore` decorator

**Files:**
- Create: `server/src/strategies/notifyingStrategyStore.ts`
- Create: `server/src/strategies/notifyingStrategyStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/strategies/notifyingStrategyStore.test.ts`:
```ts
import { NotifyingStrategyStore } from "./notifyingStrategyStore";
import { MemoryStrategyStore } from "./store";

function notifierFake() {
  const calls: { owner: string; category: string }[] = [];
  return {
    calls,
    async notify(owner: string, category: string) {
      calls.push({ owner, category });
      return { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    },
  };
}

const OWNER = "0xowner";

describe("NotifyingStrategyStore", () => {
  it("fires one lifecycle notification when a TWAP completes its last slice", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "twap", { coin: "ETH", side: "buy", totalUsdc: 100, slices: 2, durationHours: 1 } as any);
    store.recordFill(s.id, 50, 2000); // slice 1 of 2 → still running
    expect(notifier.calls).toHaveLength(0);
    store.recordFill(s.id, 50, 3000); // slice 2 of 2 → completed
    expect(notifier.calls).toEqual([{ owner: OWNER, category: "lifecycle" }]);
  });

  it("fires on a tpsl trigger", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "tpsl", { coin: "BTC", side: "sell", sz: 1, takeProfitPx: 70000 } as any);
    store.recordTrigger(s.id, 5000);
    expect(notifier.calls).toEqual([{ owner: OWNER, category: "lifecycle" }]);
  });

  it("does not fire when a fill leaves the strategy running", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "twap", { coin: "ETH", side: "buy", totalUsdc: 100, slices: 3, durationHours: 1 } as any);
    store.recordFill(s.id, 33, 2000);
    expect(notifier.calls).toHaveLength(0);
  });

  it("does not fire on a non-completed setStatus", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "dca", { coin: "ETH", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } as any);
    store.setStatus(s.id, "paused");
    expect(notifier.calls).toHaveLength(0);
  });

  it("does not re-fire for an already-completed strategy", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = notifierFake();
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "tpsl", { coin: "BTC", side: "sell", sz: 1, takeProfitPx: 70000 } as any);
    store.recordTrigger(s.id, 5000); // completes → 1 notify
    store.setStatus(s.id, "completed"); // already completed → no new notify
    expect(notifier.calls).toHaveLength(1);
  });

  it("does not break the delegated write when the notifier throws synchronously", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const notifier = { notify: () => { throw new Error("boom"); } };
    const store = new NotifyingStrategyStore(inner, notifier);
    const s = store.create(OWNER, "tpsl", { coin: "BTC", side: "sell", sz: 1, takeProfitPx: 70000 } as any);
    store.recordTrigger(s.id, 5000);
    expect(inner.get(s.id)?.status).toBe("completed");
  });

  it("passes reads and other methods through to the inner store", () => {
    const inner = new MemoryStrategyStore(() => 1000);
    const store = new NotifyingStrategyStore(inner, notifierFake());
    const s = store.create(OWNER, "dca", { coin: "ETH", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } as any);
    expect(store.get(s.id)?.id).toBe(s.id);
    expect(store.list(OWNER)).toHaveLength(1);
    expect(store.listAll()).toHaveLength(1);
    store.remove(s.id);
    expect(store.get(s.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/strategies/notifyingStrategyStore.test.ts`
Expected: FAIL — `Cannot find module './notifyingStrategyStore'`.

- [ ] **Step 3: Implement the decorator**

Create `server/src/strategies/notifyingStrategyStore.ts`:
```ts
import type { StrategyStore } from "./store";
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus } from "./types";
import type { RungState } from "./gridLimit";
import type { Notifier } from "../push/notifier";
import type { PushLocale } from "../push/messages";
import { strategyCompletedNotification } from "../push/notifications";

/** Wraps a StrategyStore; when a strategy transitions to `completed`, fires a
 *  `lifecycle` push (fire-and-forget; Notifier.notify is itself fail-safe).
 *  All other behavior passes through unchanged. */
export class NotifyingStrategyStore implements StrategyStore {
  constructor(
    private readonly inner: StrategyStore,
    private readonly notifier: Pick<Notifier, "notify">,
  ) {}

  private fireIfCompleted(id: string, before: StrategyStatus | undefined): void {
    const s = this.inner.get(id);
    if (!s || before === "completed" || s.status !== "completed") return;
    try {
      // fire-and-forget: swallow a synchronous throw and an async rejection so a
      // broken notifier can never break strategy persistence.
      void Promise.resolve(
        this.notifier.notify(s.owner, "lifecycle", (locale: PushLocale) => strategyCompletedNotification(s, locale)),
      ).catch(() => {});
    } catch {
      // notifier threw synchronously (non-async broken impl)
    }
  }

  // --- completion-producing methods: detect running→completed and notify ---
  setStatus(id: string, status: StrategyStatus): void {
    const before = this.inner.get(id)?.status;
    this.inner.setStatus(id, status);
    this.fireIfCompleted(id, before);
  }
  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void {
    const before = this.inner.get(id)?.status;
    this.inner.recordFill(id, quoteUsdc, nextRunAt);
    this.fireIfCompleted(id, before);
  }
  recordTrigger(id: string, now: number): void {
    const before = this.inner.get(id)?.status;
    this.inner.recordTrigger(id, now);
    this.fireIfCompleted(id, before);
  }

  // --- pure pass-throughs ---
  create(owner: string, kind: StrategyKind, params: StrategyParams): Strategy {
    return this.inner.create(owner, kind, params);
  }
  get(id: string): Strategy | undefined { return this.inner.get(id); }
  list(owner: string): Strategy[] { return this.inner.list(owner); }
  listAll(): Strategy[] { return this.inner.listAll(); }
  seedGridLevel(id: string, level: number): void { this.inner.seedGridLevel(id, level); }
  recordGridAction(id: string, newLevel: number, boughtUsdc: number): void { this.inner.recordGridAction(id, newLevel, boughtUsdc); }
  gridLimitRungs(id: string): RungState[] { return this.inner.gridLimitRungs(id); }
  setGridLimitRung(id: string, rung: RungState): void { this.inner.setGridLimitRung(id, rung); }
  addFilledUsdc(id: string, usdc: number): void { this.inner.addFilledUsdc(id, usdc); }
  remove(id: string): void { this.inner.remove(id); }
}
```

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `cd server && npx jest src/strategies/notifyingStrategyStore.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/strategies/notifyingStrategyStore.ts server/src/strategies/notifyingStrategyStore.test.ts && git commit -m "feat(push): NotifyingStrategyStore fires lifecycle push on completion"
```

---

## Task 4: `/push/prefs` route covers `lifecycle` + wiring

**Files:**
- Modify: `server/src/http/app.ts`
- Modify: `server/src/http/app.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Update the route tests**

In `server/src/http/app.test.ts`, update the default-prefs assertion. Replace:
```ts
    expect(res.json()).toEqual({ fills: true, alerts: true });
```
with:
```ts
    expect(res.json()).toEqual({ fills: true, alerts: true, lifecycle: true });
```
Then add these two tests just before the final `});` of the push `describe` block
(build the bearer header from `tokenFor(app)` as the surrounding tests do):
```ts
  it("persists a lifecycle toggle via POST and reflects it in GET", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const post = await app.inject({ method: "POST", url: "/push/prefs", headers: auth, payload: { lifecycle: false } });
    expect(post.statusCode).toBe(204);
    const res = await app.inject({ method: "GET", url: "/push/prefs", headers: auth });
    expect(res.json()).toEqual({ fills: true, alerts: true, lifecycle: false });
    await app.close();
  });

  it("rejects a non-boolean lifecycle with 400", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "POST", url: "/push/prefs", headers: { authorization: `Bearer ${token}` }, payload: { lifecycle: "yes" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/http/app.test.ts`
Expected: FAIL — GET default is `{fills,alerts}` (no lifecycle) and the POST loop
ignores `lifecycle`.

- [ ] **Step 3: Widen the POST validation loop**

In `server/src/http/app.ts`, replace:
```ts
    for (const key of ["fills", "alerts"] as const) {
```
with:
```ts
    for (const key of ["fills", "alerts", "lifecycle"] as const) {
```
Also widen the local `prefs` object type and the body cast a few lines above it.
Replace:
```ts
    const body = (req.body ?? {}) as { fills?: unknown; alerts?: unknown };
    const prefs: { fills?: boolean; alerts?: boolean } = {};
```
with:
```ts
    const body = (req.body ?? {}) as { fills?: unknown; alerts?: unknown; lifecycle?: unknown };
    const prefs: { fills?: boolean; alerts?: boolean; lifecycle?: boolean } = {};
```

- [ ] **Step 4: Run app tests to verify they pass + typecheck**

Run: `cd server && npx jest src/http/app.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 5: Wire the decorator in `index.ts`**

In `server/src/index.ts`, add the import next to the other strategy imports:
```ts
import { NotifyingStrategyStore } from "./strategies/notifyingStrategyStore";
```

Immediately after the `notifier` is constructed (the
`const notifier = new Notifier({ ... });` line), add:
```ts
  const notifyingStore = new NotifyingStrategyStore(store, notifier);
```

Pass `notifyingStore` to the scheduler tick (so completions are observed). In the
`void tick(` call, replace the first argument `store,` with `notifyingStore,`.

Pass it to the app too. In the `buildApp({ ... })` call, replace `store,` with
`store: notifyingStore,`.

- [ ] **Step 6: Run full server suite + typecheck**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; all suites pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/http/app.ts server/src/http/app.test.ts server/src/index.ts && git commit -m "feat(push): /push/prefs lifecycle + wire NotifyingStrategyStore"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, find the `P4.5 更细分类` deferred fragment in the
M7 row and replace it with a landed note. Replace:
```
P4.5 更细分类
```
with:
```
P4.5-server 策略完成推送落地：新增 lifecycle 类别（默认开）+ `strategyCompletedNotification` + `NotifyingStrategyStore` 装饰器（twap 末片/tpsl 触发→completed 跃迁发通知，fail-safe）+ 免打扰覆盖 fills/lifecycle（alerts 穿透）+ `/push/prefs` 含 lifecycle（P4.5-mobile 开关 UI 待做）
```

(If the surrounding text differs, replace only the literal `P4.5 更细分类`.)

- [ ] **Step 2: Full server validation**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; full jest suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P4.5-server strategy-completed push landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-lifecycle-server
gh pr create --title "feat(push): M7 P4.5-server — strategy-completed push + lifecycle category" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** lifecycle category + defaults → Task 1 (pushPrefStore). Catalog
copy + `strategyCompletedNotification` → Task 1 (messages/notifications). Quiet-hours
covers lifecycle → Task 2. `NotifyingStrategyStore` completion detection → Task 3.
`/push/prefs` lifecycle + decorator wiring → Task 4. Roadmap → Task 5. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after.
(Task 5 Step 4 PR body-file composed at execution time; app.test bearer header built
from `tokenFor` rather than pasted due to the `Bearer` view-redaction.)

**Type consistency:** `PushCategory = "fills"|"alerts"|"lifecycle"` and
`PushPrefs { fills, alerts, lifecycle }` are used identically across pushPrefStore.ts,
notifier.ts (`QUIETABLE` set, gate), app.ts (validation loop + prefs object), and the
tests. `strategyCompletedNotification(s: Strategy, locale: PushLocale)` matches its
call in `NotifyingStrategyStore` and its test. `NotifyingStrategyStore` implements the
full `StrategyStore` interface (create/get/list/listAll/setStatus/recordFill/
recordTrigger/seedGridLevel/recordGridAction/gridLimitRungs/setGridLimitRung/
addFilledUsdc/remove). `notify(owner, "lifecycle", render)` matches the Notifier
signature.
