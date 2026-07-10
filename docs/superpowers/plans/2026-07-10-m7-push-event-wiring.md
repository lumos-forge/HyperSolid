# M7 P4 —— 事件接线（引擎事件 → 通知）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the server engine's two clean event hooks to the P2 `Notifier` so auto-trade fills and dead-man protection alerts produce user push notifications — via a pure notification catalog, a `NotifyingActivityStore` decorator, and enrichment of the existing `onHealthEvent` sink in `index.ts`.

**Architecture:** A pure `notifications.ts` catalog maps domain events (`Activity` fill, `DeadManHealthEvent`) to `Notification` content (English text + structured `data`). A `NotifyingActivityStore implements ActivityStore` decorator delegates every method to an inner store and, on `record`, fires a fill notification fire-and-forget (guarded so a broken notifier can never break recording). `index.ts` constructs the real `Notifier` (with `new Expo()`), wraps the activity store, and adds one `notify` line to each branch of the existing dead-man `onHealthEvent`. All send paths reuse P2's fail-safe `Notifier.notify` (never throws).

**Tech Stack:** TypeScript, jest + ts-jest. Reuses P1 `pushTokens`, P2 `Notifier`/`Notification`, `ActivityStore`/`Activity`, `DeadManHealthEvent`. Runtime `Expo` value import only in `index.ts` (not in jest-tested modules).

**Reference spec:** `docs/superpowers/specs/2026-07-10-m7-push-event-wiring-design.md`

**Branch:** `feat/m7-push-event-wiring` (already created; spec committed).

**Verified facts (do not re-derive):**
- `Activity` (`server/src/strategies/activityStore.ts`): `{ id, strategyId, owner, time, coin, side, sz, px }`. `ActivityStore` methods: `record(a: Omit<Activity,"id">): Activity`; `list(owner, strategyId): Activity[]`; `listRecent(owner, limit): Activity[]`; `notionalSince(owner, sinceMs): number`. `record` assigns `id` and lowercases `owner`.
- `Notification` (`server/src/push/notifier.ts`): `{ title: string; body: string; data?: Record<string, unknown> }`. `Notifier` has `async notify(owner, n): Promise<NotifyResult>` and never throws (P2).
- `DeadManHealthEvent` (`server/src/engine/deadMan.ts`): `{ kind: "none" } | { kind: "alert"; consecutiveFailures: number } | { kind: "recovered" }`.
- `index.ts`: `const activity = SqliteActivityStore.open(dbPath);` then later `onHealthEvent: (owner, ev) => { if (ev.kind === "alert") { console.error(...) } else if (ev.kind === "recovered") { console.error(...) } }`. `pushTokens = SqlitePushTokenStore.open(dbPath)` already exists (P1 wiring).
- ESM: import the `Expo` VALUE only in `index.ts` (node runtime, not jest). Tested modules import expo-server-sdk types only (or nothing).
- Scripts: `npm run typecheck` = `tsc --noEmit`; `npm test` = `jest`.

---

## File Structure

- Create: `server/src/push/notifications.ts` — `fillNotification`, `deadManAlertNotification`, `deadManRecoveredNotification`.
- Create: `server/src/push/notifications.test.ts` — catalog unit tests.
- Create: `server/src/push/notifyingActivityStore.ts` — `NotifyingActivityStore` decorator.
- Create: `server/src/push/notifyingActivityStore.test.ts` — decorator unit tests.
- Modify: `server/src/index.ts` — construct `Notifier`, wrap activity store, enrich `onHealthEvent`.
- Modify: `docs/BACKEND-ARCHITECTURE.md` — mark M7 P4 landed.

---

## Task 1: notification catalog

**Files:**
- Create: `server/src/push/notifications.ts`
- Test: `server/src/push/notifications.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/notifications.test.ts`:

```ts
import { fillNotification, deadManAlertNotification, deadManRecoveredNotification } from "./notifications";
import type { Activity } from "../strategies/activityStore";

function fill(over: Partial<Activity> = {}): Activity {
  return { id: "a1", strategyId: "s1", owner: "0xabc", time: 1000, coin: "BTC", side: "buy", sz: 0.01, px: 50000, ...over };
}

describe("notification catalog", () => {
  it("fillNotification: buy with formatted price and structured data", () => {
    const n = fillNotification(fill());
    expect(n.title).toBe("Order filled");
    expect(n.body).toBe("Buy 0.01 BTC @ 50,000");
    expect(n.data).toEqual({ kind: "fill", strategyId: "s1", coin: "BTC", side: "buy", sz: 0.01, px: 50000 });
  });

  it("fillNotification: sell capitalizes side", () => {
    const n = fillNotification(fill({ side: "sell", coin: "ETH", sz: 2, px: 3200.5 }));
    expect(n.body).toBe("Sell 2 ETH @ 3,200.5");
    expect(n.data).toMatchObject({ side: "sell", coin: "ETH" });
  });

  it("deadManAlertNotification: mentions the failure count", () => {
    const n = deadManAlertNotification({ consecutiveFailures: 3 });
    expect(n.title).toContain("protection");
    expect(n.body).toContain("3 consecutive");
    expect(n.data).toEqual({ kind: "deadman_alert", consecutiveFailures: 3 });
  });

  it("deadManRecoveredNotification: recovered kind", () => {
    const n = deadManRecoveredNotification();
    expect(n.title).toContain("restored");
    expect(n.data).toEqual({ kind: "deadman_recovered" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/notifications.test.ts`
Expected: FAIL — cannot find module `./notifications`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/push/notifications.ts`:

```ts
import type { Notification } from "./notifier";
import type { Activity } from "../strategies/activityStore";

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** "Order filled" — "Buy 0.01 BTC @ 50,000". */
export function fillNotification(a: Activity): Notification {
  return {
    title: "Order filled",
    body: `${capitalize(a.side)} ${fmt(a.sz)} ${a.coin} @ ${fmt(a.px)}`,
    data: { kind: "fill", strategyId: a.strategyId, coin: a.coin, side: a.side, sz: a.sz, px: a.px },
  };
}

/** Dead-man protection is failing (agent authorization at risk). */
export function deadManAlertNotification(ev: { consecutiveFailures: number }): Notification {
  return {
    title: "Strategy protection at risk",
    body: `${ev.consecutiveFailures} consecutive unprotected heartbeats — check your agent authorization.`,
    data: { kind: "deadman_alert", consecutiveFailures: ev.consecutiveFailures },
  };
}

/** Dead-man protection recovered. */
export function deadManRecoveredNotification(): Notification {
  return {
    title: "Strategy protection restored",
    body: "Your automated strategies are protected again.",
    data: { kind: "deadman_recovered" },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/notifications.test.ts && npm run typecheck`
Expected: PASS (4 tests); `tsc --noEmit` clean.

Note: `fmt` uses `toLocaleString("en-US", { maximumFractionDigits: 8 })` → `50000` renders `"50,000"`, `3200.5` renders `"3,200.5"`, `0.01` renders `"0.01"`, `2` renders `"2"`. If the local Node ICU renders differently and a test fails on the exact string, adjust the expected strings to the actual `toLocaleString` output (Node full-ICU is standard) — do not change the format function.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifications.ts server/src/push/notifications.test.ts && \
  git commit -m "feat(push): notification catalog (fill + dead-man alert/recovered)"
```

---

## Task 2: `NotifyingActivityStore` decorator

**Files:**
- Create: `server/src/push/notifyingActivityStore.ts`
- Test: `server/src/push/notifyingActivityStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/notifyingActivityStore.test.ts`:

```ts
import { NotifyingActivityStore } from "./notifyingActivityStore";
import { fillNotification } from "./notifications";
import type { Activity, ActivityStore } from "../strategies/activityStore";
import type { Notification } from "./notifier";

function innerFake(): ActivityStore & { recorded: Omit<Activity, "id">[] } {
  const recorded: Omit<Activity, "id">[] = [];
  return {
    recorded,
    record(a) { recorded.push(a); return { id: "generated-id", ...a, owner: a.owner.toLowerCase() }; },
    list() { return [{ id: "L", strategyId: "s", owner: "o", time: 1, coin: "BTC", side: "buy", sz: 1, px: 1 }]; },
    listRecent() { return [{ id: "R", strategyId: "s", owner: "o", time: 1, coin: "ETH", side: "sell", sz: 2, px: 2 }]; },
    notionalSince() { return 123; },
  };
}

function notifierFake(opts: { throwSync?: boolean } = {}) {
  const calls: { owner: string; n: Notification }[] = [];
  return {
    calls,
    async notify(owner: string, n: Notification) {
      calls.push({ owner, n });
      if (opts.throwSync) throw new Error("boom");
      return { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    },
  };
}

const A = { strategyId: "s1", owner: "0xABC", time: 1000, coin: "BTC", side: "buy" as const, sz: 0.01, px: 50000 };

describe("NotifyingActivityStore", () => {
  it("delegates record to inner and returns its result", () => {
    const inner = innerFake();
    const notifier = notifierFake();
    const store = new NotifyingActivityStore(inner, notifier);
    const row = store.record(A);
    expect(row.id).toBe("generated-id");
    expect(inner.recorded).toHaveLength(1);
  });

  it("fires a fill notification for the recorded row's owner and content", () => {
    const inner = innerFake();
    const notifier = notifierFake();
    const store = new NotifyingActivityStore(inner, notifier);
    const row = store.record(A);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0].owner).toBe(row.owner); // lowercased by inner
    expect(notifier.calls[0].n).toEqual(fillNotification(row));
  });

  it("still returns the inner result even if notify throws synchronously", () => {
    const inner = innerFake();
    const notifier = notifierFake({ throwSync: true });
    const store = new NotifyingActivityStore(inner, notifier);
    const row = store.record(A);
    expect(row.id).toBe("generated-id");
    expect(inner.recorded).toHaveLength(1);
  });

  it("passes list/listRecent/notionalSince through to inner", () => {
    const inner = innerFake();
    const store = new NotifyingActivityStore(inner, notifierFake());
    expect(store.list("o", "s")[0].id).toBe("L");
    expect(store.listRecent("o", 5)[0].id).toBe("R");
    expect(store.notionalSince("o", 0)).toBe(123);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/notifyingActivityStore.test.ts`
Expected: FAIL — cannot find module `./notifyingActivityStore`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/push/notifyingActivityStore.ts`:

```ts
import type { ActivityStore, Activity } from "../strategies/activityStore";
import type { Notifier } from "./notifier";
import { fillNotification } from "./notifications";

/** Wraps an ActivityStore; on record() also fires a fill push notification
 *  (fire-and-forget; Notifier.notify is itself fail-safe). Other methods pass through. */
export class NotifyingActivityStore implements ActivityStore {
  constructor(
    private readonly inner: ActivityStore,
    private readonly notifier: Pick<Notifier, "notify">,
  ) {}

  record(a: Omit<Activity, "id">): Activity {
    const row = this.inner.record(a);
    try {
      // fire-and-forget: swallow both a synchronous throw and an async rejection
      // so a broken notifier can never break activity recording.
      void Promise.resolve(this.notifier.notify(row.owner, fillNotification(row))).catch(() => {});
    } catch {
      // notifier threw synchronously (non-async broken impl)
    }
    return row;
  }

  list(owner: string, strategyId: string): Activity[] {
    return this.inner.list(owner, strategyId);
  }

  listRecent(owner: string, limit: number): Activity[] {
    return this.inner.listRecent(owner, limit);
  }

  notionalSince(owner: string, sinceMs: number): number {
    return this.inner.notionalSince(owner, sinceMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/notifyingActivityStore.test.ts && npm run typecheck`
Expected: PASS (4 tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifyingActivityStore.ts server/src/push/notifyingActivityStore.test.ts && \
  git commit -m "feat(push): NotifyingActivityStore decorator (fill notifications on record)"
```

---

## Task 3: wire into `index.ts`

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add imports**

In `server/src/index.ts`, add these imports (near the other `./push/*` and expo imports; group with existing imports):

```ts
import { Expo } from "expo-server-sdk";
import { Notifier } from "./push/notifier";
import { NotifyingActivityStore } from "./push/notifyingActivityStore";
import { deadManAlertNotification, deadManRecoveredNotification } from "./push/notifications";
```

- [ ] **Step 2: Construct the Notifier and wrap the activity store**

Locate (P1 already added `pushTokens`):

```ts
  const activity = SqliteActivityStore.open(dbPath);
  const pushTokens = SqlitePushTokenStore.open(dbPath);
```

Replace with:

```ts
  const pushTokens = SqlitePushTokenStore.open(dbPath);
  const notifier = new Notifier({ expo: new Expo(), store: pushTokens });
  const activity = new NotifyingActivityStore(SqliteActivityStore.open(dbPath), notifier);
```

(Order: `pushTokens` before `notifier`; `activity` now wraps the sqlite store. All later uses of `activity` and `pushTokens` are unchanged — `buildApp({ ..., activity, pushTokens, ... })` still receives the same variable names.)

- [ ] **Step 3: Enrich the dead-man health sink**

Locate the `onHealthEvent` handler:

```ts
        onHealthEvent: (owner, ev) => {
          if (ev.kind === "alert") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
          } else if (ev.kind === "recovered") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm recovered for ${owner}`);
          }
        },
```

Replace with:

```ts
        onHealthEvent: (owner, ev) => {
          if (ev.kind === "alert") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
            void notifier.notify(owner, deadManAlertNotification(ev));
          } else if (ev.kind === "recovered") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm recovered for ${owner}`);
            void notifier.notify(owner, deadManRecoveredNotification());
          }
        },
```

- [ ] **Step 4: Typecheck + build**

Run: `cd server && npm run typecheck && npx tsc`
Expected: both clean. (`new Expo()` type-checks; `notifier` is used by both the decorator and the health sink, so no unused-var.)

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/index.ts && \
  git commit -m "feat(push): wire fill + dead-man notifications in index.ts (P4)"
```

---

## Task 4: roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the roadmap M7 status**

In `docs/BACKEND-ARCHITECTURE.md`, the M7 row currently ends (from P2):

```
；P2 通知核心+Expo 传输落地：fail-safe `Notifier.notify(owner, notification)`（注入 Expo 客户端、批量 chunk 发送、即时 ticket DeviceNotRegistered 令牌剪枝、不外抛，`server/src/push/notifier.ts`）；P2.5 延迟回执轮询、P3 mobile 注册、P4 事件接线+偏好 待做】**
```

Replace the `；P2.5 延迟回执轮询、P3 mobile 注册、P4 事件接线+偏好 待做】**` tail with:

```
；P4 事件接线落地：成交经 `NotifyingActivityStore` 装饰器发通知、dead-man `onHealthEvent` alert/recovered 发通知，通知目录 `server/src/push/notifications.ts`；P3 mobile 注册、P5 通知偏好+locale、P2.5 延迟回执轮询、P4.5 更细分类 待做】**
```

- [ ] **Step 2: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: mark M7 P4 事件接线 landed"
```

- [ ] **Step 3: Full server validation (no regressions)**

Run:
```bash
cd server && npm run typecheck && npm test
```
Expected: typecheck clean; the whole jest suite passes (new push tests + all existing — especially existing `activityStore` and scheduler tests, since `ActivityStore` behavior is unchanged for consumers).

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-event-wiring && \
  gh pr create --title "feat(server): M7 P4 事件接线（成交 + dead-man 告警 → 推送）" \
    --body "M7 推送子项目 P4。把两个干净事件钩子接到 P2 Notifier：① 自动成交经 \`NotifyingActivityStore\` 装饰器（record 后 fire-and-forget 发 fill 通知）；② dead-man \`onHealthEvent\` 富化（alert/recovered 各发一条）。通知目录 \`notifications.ts\`（英文文本 + 结构化 data；locale 归 P5）。index.ts 首次装配真实 \`Expo\` 客户端。全程 fail-safe（Notifier.notify 不外抛 + 装饰器 try/catch 兜底），绝不打断交易 tick。Spec: docs/superpowers/specs/2026-07-10-m7-push-event-wiring-design.md"
```
Expected: PR created.

- [ ] **Step 5: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §4 catalog (fill/alert/recovered) → Task 1; §5 decorator → Task 2; §6 index wiring (Notifier construct, wrap activity, enrich onHealthEvent) → Task 3; §7 tests 1–8 → Tasks 1 (4 catalog) + 2 (4 decorator); §8 validation → Task 4; §3 English text → Task 1 content; §2 non-goals respected (no kill-switch/prefs/receipts). Doc note → Task 4. All covered.
- **Placeholder scan:** all code complete; fakes fully written. The `toLocaleString` note is a reconcile instruction (like the promtool float note), not a placeholder — the format function is fixed, only expected strings adjust if ICU differs.
- **Type consistency:** `fillNotification(a: Activity): Notification`, `deadManAlertNotification({consecutiveFailures}): Notification`, `deadManRecoveredNotification(): Notification`, `NotifyingActivityStore` implements all four `ActivityStore` methods with identical signatures, `notifier: Pick<Notifier,"notify">` — all consistent across Tasks 1–3 and match the spec + verified `ActivityStore`/`Notification`/`DeadManHealthEvent` shapes.
- **ESM safety:** the runtime `import { Expo }` is only in `index.ts` (Task 3), never in a jest-tested module; `notifications.ts`/`notifyingActivityStore.ts` import only types from `./notifier` + `../strategies/activityStore`.
- **No-regression:** `NotifyingActivityStore` implements `ActivityStore` unchanged for consumers; `record` returns the inner result; existing tests that use the raw sqlite/memory store are untouched.
