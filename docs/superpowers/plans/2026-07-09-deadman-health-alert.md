# 死手开关失败告警 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 server/ 死手开关增加过渡式失败告警：某 owner 连续未受保护（arm 失败或 budget 耗尽）跨阈值时发一次 alert、恢复时发一次 recovered，稳态零日志噪声。

**Architecture:** `engine/deadMan.ts` 新增 `makeDeadManHealth`（按 owner 连续失败计数 → 跳变事件）；`deadManHeartbeat` 加可选 `health`/`onHealthEvent`，把 `skip` 与 `arm 失败`统一记为「未受保护」；`index.ts` 建一个 health 追踪器并用 `console.error` 输出跳变。

**Tech Stack:** TypeScript、Node、Jest（ts-jest）。gate：`cd server && npm run typecheck && npm test`。

---

## File Structure

- `server/src/engine/deadMan.ts` — 追加 `DEADMAN_ALERT_AFTER`、`DeadManHealthEvent`、`DeadManHealth`、`makeDeadManHealth`；`DeadManHeartbeatDeps` 加可选 `health`/`onHealthEvent`；心跳循环体扩展。
- `server/src/engine/deadMan.test.ts` — 追加 health 追踪器测试 + 心跳集成测试。
- `server/src/index.ts` — 建 `makeDeadManHealth()`，心跳调用带 `health` + `onHealthEvent`（console.error）。

---

## Task 1: `makeDeadManHealth` — 连续失败追踪器

**Files:**
- Modify: `server/src/engine/deadMan.ts`
- Test: `server/src/engine/deadMan.test.ts`

依赖：无。

### 背景（当前 deadMan.ts）
文件已有 `makeDeadManBudget`、`deadManHeartbeat`、`DeadManHeartbeatDeps`（activeOwners/budget/executor/now/ttlMs）。本 task 只**新增** health 追踪器（不改现有导出）。

- [ ] **Step 1: 追加失败测试到 `server/src/engine/deadMan.test.ts`**

在文件末尾追加（`makeDeadManHealth` 加到顶部已有的 `./deadMan` import 中）：先把顶部 `import { makeDeadManBudget, deadManHeartbeat } from "./deadMan";` 改为 `import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth } from "./deadMan";`，再追加：
```ts
describe("makeDeadManHealth", () => {
  it("alerts only when consecutive failures reach the threshold", () => {
    const h = makeDeadManHealth(3);
    expect(h.record("0xo", false)).toEqual({ kind: "none" }); // 1
    expect(h.record("0xo", false)).toEqual({ kind: "none" }); // 2
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 3 }); // 3 -> alert
  });

  it("does not repeat the alert while it stays failing", () => {
    const h = makeDeadManHealth(2);
    h.record("0xo", false);
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 2 });
    expect(h.record("0xo", false)).toEqual({ kind: "none" }); // still failing -> silent
    expect(h.record("0xo", false)).toEqual({ kind: "none" });
  });

  it("emits recovered once after an alert, then stays quiet", () => {
    const h = makeDeadManHealth(2);
    h.record("0xo", false);
    h.record("0xo", false); // alert
    expect(h.record("0xo", true)).toEqual({ kind: "recovered" });
    expect(h.record("0xo", true)).toEqual({ kind: "none" }); // steady healthy
  });

  it("resets the streak on a success below the threshold (no alert)", () => {
    const h = makeDeadManHealth(3);
    h.record("0xo", false);
    h.record("0xo", false); // 2 failures, no alert yet
    expect(h.record("0xo", true)).toEqual({ kind: "none" }); // success resets, no recovered (was not alerting)
    expect(h.record("0xo", false)).toEqual({ kind: "none" }); // streak restarts at 1
    expect(h.record("0xo", false)).toEqual({ kind: "none" }); // 2
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 3 }); // 3 -> alert
  });

  it("can alert again after recovering", () => {
    const h = makeDeadManHealth(2);
    h.record("0xo", false);
    h.record("0xo", false); // alert
    h.record("0xo", true); // recovered
    h.record("0xo", false);
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 2 }); // alert again
  });

  it("tracks owners independently", () => {
    const h = makeDeadManHealth(2);
    h.record("0xa", false);
    expect(h.record("0xb", false)).toEqual({ kind: "none" }); // 0xb only 1 failure
    expect(h.record("0xa", false)).toEqual({ kind: "alert", consecutiveFailures: 2 }); // 0xa reaches 2
  });

  it("defaults the threshold to 3", () => {
    const h = makeDeadManHealth();
    h.record("0xo", false);
    h.record("0xo", false);
    expect(h.record("0xo", false)).toEqual({ kind: "alert", consecutiveFailures: 3 });
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest deadMan -t makeDeadManHealth`
Expected: FAIL（`makeDeadManHealth` 未导出）。

- [ ] **Step 3: 在 `deadMan.ts` 新增 health 追踪器（放在 `makeDeadManBudget` 之后、`DeadManHeartbeatDeps` 之前）**

```ts
/** Consecutive unprotected heartbeats before raising an alert (~alertAfter × tick of no protection). */
export const DEADMAN_ALERT_AFTER = 3;

export type DeadManHealthEvent =
  | { kind: "none" }
  | { kind: "alert"; consecutiveFailures: number }
  | { kind: "recovered" };

export interface DeadManHealth {
  /** Record one heartbeat outcome for owner (armed = did we successfully arm/refresh this tick).
   *  Returns a transition event (alert on crossing the threshold, recovered on first success after an
   *  alert) or { kind: "none" } in steady state. */
  record(owner: string, armed: boolean): DeadManHealthEvent;
}

interface HealthState {
  failures: number;
  alerting: boolean;
}

export function makeDeadManHealth(alertAfter: number = DEADMAN_ALERT_AFTER): DeadManHealth {
  const state = new Map<string, HealthState>();
  return {
    record(owner: string, armed: boolean): DeadManHealthEvent {
      const s = state.get(owner) ?? { failures: 0, alerting: false };
      if (armed) {
        const wasAlerting = s.alerting;
        state.set(owner, { failures: 0, alerting: false });
        return wasAlerting ? { kind: "recovered" } : { kind: "none" };
      }
      const failures = s.failures + 1;
      if (!s.alerting && failures >= alertAfter) {
        state.set(owner, { failures, alerting: true });
        return { kind: "alert", consecutiveFailures: failures };
      }
      state.set(owner, { failures, alerting: s.alerting });
      return { kind: "none" };
    },
  };
}
```

- [ ] **Step 4: 运行确认 PASS + typecheck**

Run: `cd server && npx jest deadMan && npx tsc --noEmit`
Expected: 新增 health 测试 + 既有 deadMan 测试全绿；tsc 无错。

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/engine/deadMan.ts server/src/engine/deadMan.test.ts
git commit --no-verify -m "feat(server): dead-man health tracker (transition-only alert/recovered)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: 心跳集成 + `index.ts` 装配

**Files:**
- Modify: `server/src/engine/deadMan.ts`（`DeadManHeartbeatDeps` + 循环体）
- Test: `server/src/engine/deadMan.test.ts`（心跳集成测试）
- Modify: `server/src/index.ts`

依赖：Task 1（`DeadManHealth`/`makeDeadManHealth`/`DeadManHealthEvent`）。

### 背景（当前 deadMan.ts 心跳，:46-64）
```ts
export interface DeadManHeartbeatDeps {
  activeOwners(): string[];
  budget: DeadManBudget;
  executor: DeadManExecutor;
  now(): number;
  ttlMs: number;
}

export async function deadManHeartbeat(deps: DeadManHeartbeatDeps): Promise<void> {
  const now = deps.now();
  for (const owner of new Set(deps.activeOwners())) {
    const d = deps.budget.decide(owner, now, deps.ttlMs);
    if (d.skip) continue;
    if (await deps.executor.arm(owner, d.time)) deps.budget.record(owner, now, d.time, d.counts);
  }
}
```

### 背景（index.ts 当前 dead-man 装配，约 :91-124）
`makeDeadManBudget()`、`makeDeadManExecutor(...)`、`activeOwners`、`deadManEnabled` 已定义；心跳在 setInterval 内以 `void deadManHeartbeat({ activeOwners, budget: deadManBudget, executor: deadManExecutor, now, ttlMs: deadManTtlMs as number }).catch(...)` 调用。`makeDeadManHealth` 需要加到 `./engine/deadMan` 的 import。

- [ ] **Step 1: 追加心跳集成测试到 `server/src/engine/deadMan.test.ts`**

在 `describe("deadManHeartbeat", ...)` 内追加以下用例（沿用该 describe 已有的 `ttl`/`now` 常量与 fake 风格）：
```ts
  it("records a health failure and emits the event when arm fails", async () => {
    const events: Array<{ owner: string; kind: string }> = [];
    const executor = { arm: jest.fn(async () => false) };
    const health = makeDeadManHealth(1); // alert on first failure for a tight test
    await deadManHeartbeat({
      activeOwners: () => ["0xa"], budget: makeDeadManBudget(), executor,
      now: () => now, ttlMs: ttl, health,
      onHealthEvent: (owner, ev) => events.push({ owner, kind: ev.kind }),
    });
    expect(executor.arm).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ owner: "0xa", kind: "alert" }]);
  });

  it("counts a budget skip as an unprotected failure (no arm, health records false)", async () => {
    const events: Array<{ owner: string; kind: string }> = [];
    const executor = { arm: jest.fn(async () => true) };
    const budget = { decide: () => ({ skip: true as const }), record: jest.fn() };
    const health = makeDeadManHealth(1);
    await deadManHeartbeat({
      activeOwners: () => ["0xa"], budget, executor, now: () => now, ttlMs: ttl, health,
      onHealthEvent: (owner, ev) => events.push({ owner, kind: ev.kind }),
    });
    expect(executor.arm).not.toHaveBeenCalled();
    expect(events).toEqual([{ owner: "0xa", kind: "alert" }]);
  });

  it("records health success and emits recovered after an alert", async () => {
    const events: string[] = [];
    const health = makeDeadManHealth(1);
    // Prime an alert via a direct failure record, then a successful heartbeat recovers.
    health.record("0xa", false);
    const executor = { arm: jest.fn(async () => true) };
    await deadManHeartbeat({
      activeOwners: () => ["0xa"], budget: makeDeadManBudget(), executor,
      now: () => now, ttlMs: ttl, health,
      onHealthEvent: (_owner, ev) => events.push(ev.kind),
    });
    expect(events).toEqual(["recovered"]);
  });

  it("works without a health tracker (unchanged behavior)", async () => {
    const executor = { arm: jest.fn(async () => true) };
    await deadManHeartbeat({ activeOwners: () => ["0xa"], budget: makeDeadManBudget(), executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).toHaveBeenCalledWith("0xa", now + ttl);
  });
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest deadMan -t deadManHeartbeat`
Expected: FAIL（`DeadManHeartbeatDeps` 无 `health`/`onHealthEvent`，心跳未 record health）。

- [ ] **Step 3: 扩展 `DeadManHeartbeatDeps` + 心跳循环体（deadMan.ts:46-64）**

替换为：
```ts
export interface DeadManHeartbeatDeps {
  /** Owners with >=1 running strategy. Duplicates are de-duped internally. */
  activeOwners(): string[];
  budget: DeadManBudget;
  executor: DeadManExecutor;
  now(): number;
  ttlMs: number;
  /** Optional health tracker: records whether each owner was protected this tick. */
  health?: DeadManHealth;
  /** Optional sink for health transition events (e.g. a logger). */
  onHealthEvent?: (owner: string, event: DeadManHealthEvent) => void;
}

/** One heartbeat pass: for each active owner, arm/refresh scheduleCancel per the budget, recording
 *  only on a successful send. A budget skip or an arm failure both count as "unprotected this tick"
 *  for the optional health tracker, which surfaces transition events (alert/recovered). Sequential. */
export async function deadManHeartbeat(deps: DeadManHeartbeatDeps): Promise<void> {
  const now = deps.now();
  for (const owner of new Set(deps.activeOwners())) {
    const d = deps.budget.decide(owner, now, deps.ttlMs);
    let armed = false;
    if (!d.skip) {
      armed = await deps.executor.arm(owner, d.time);
      if (armed) deps.budget.record(owner, now, d.time, d.counts);
    }
    const ev = deps.health?.record(owner, armed);
    if (ev && ev.kind !== "none") deps.onHealthEvent?.(owner, ev);
  }
}
```

- [ ] **Step 4: 运行确认 PASS**

Run: `cd server && npx jest deadMan`
Expected: 心跳集成测试 + 既有全绿。

- [ ] **Step 5: 装配到 `index.ts`**

(a) 把 `./engine/deadMan` 的 import 扩展为包含 `makeDeadManHealth`：
把
```ts
import { makeDeadManBudget, deadManHeartbeat } from "./engine/deadMan";
```
改为
```ts
import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth } from "./engine/deadMan";
```
(b) 在 `const deadManBudget = makeDeadManBudget();` 之后加一行：
```ts
  const deadManHealth = makeDeadManHealth();
```
(c) 把 setInterval 内的心跳调用（当前形如 `void deadManHeartbeat({ activeOwners, budget: deadManBudget, executor: deadManExecutor, now, ttlMs: deadManTtlMs as number }).catch((e) => console.error("dead-man heartbeat failed", e));`）替换为：
```ts
      void deadManHeartbeat({
        activeOwners,
        budget: deadManBudget,
        executor: deadManExecutor,
        now,
        ttlMs: deadManTtlMs as number,
        health: deadManHealth,
        onHealthEvent: (owner, ev) => {
          if (ev.kind === "alert") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
          } else if (ev.kind === "recovered") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm recovered for ${owner}`);
          }
        },
      }).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("dead-man heartbeat failed", e),
      );
```

- [ ] **Step 6: 全量门禁**

Run:
```bash
cd server
npm run typecheck
npm test
```
Expected: typecheck 无错；全套件绿（含新增 health/心跳集成测试）。

- [ ] **Step 7: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/engine/deadMan.ts server/src/engine/deadMan.test.ts server/src/index.ts
git commit --no-verify -m "feat(server): heartbeat health signal + console alerting (dead-man failure)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd server && npm run typecheck && npm test
```

既有测试基线保持绿；新增覆盖：health 追踪器（阈值告警一次/不重复/恢复一次/复位/再告警/多 owner/默认 3）；心跳 arm 失败与 budget skip 均记 failure 并在跳变发 onHealthEvent；无 health 行为不变。
