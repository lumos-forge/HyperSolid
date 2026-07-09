# scheduleCancel 死手开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 server/ 增加 HL scheduleCancel 死手开关：心跳周期刷新「到点撤全部挂单」，宕机超 TTL 自动撤单，并用 ≤10/日预算区分免费刷新与计数布防。

**Architecture:** `agent/deadManExecutor.ts` 经 agent-signed client 发 `scheduleCancel`（never-throw fail-closed）；`engine/deadMan.ts` 提供 armed-state ≤10/日预算（decide/record）与心跳驱动 `deadManHeartbeat`；`index.ts` 用 `DEADMAN_TTL_MS` env 启用、在现有 tick timer 里为每个有 running 策略的 owner 刷新。

**Tech Stack:** TypeScript、Node、Jest（ts-jest）。`@nktkas/hyperliquid` ExchangeClient 已内置 `scheduleCancel({ time? })`。gate：`cd server && npm run typecheck && npm test`。

---

## File Structure

- `server/src/agent/deadManExecutor.ts` /（新）`.test.ts` — `DeadManClientLike`、`DeadManExecutor.arm`（发 scheduleCancel，never-throw）。
- `server/src/engine/deadMan.ts` /（新）`.test.ts` — `makeDeadManBudget`（decide/record ≤10/日 armed-state）+ `deadManHeartbeat`（驱动）。
- `server/src/index.ts` — `DEADMAN_TTL_MS` env、装配 executor/budget/activeOwners、在现有 setInterval 内调 heartbeat。

---

## Task 1: `makeDeadManBudget` — ≤10/日 armed-state 预算

**Files:**
- Create: `server/src/engine/deadMan.ts`
- Test: `server/src/engine/deadMan.test.ts`

依赖：无。

- [ ] **Step 1: 写失败测试 `server/src/engine/deadMan.test.ts`**

```ts
import { makeDeadManBudget } from "./deadMan";

const DAY = 24 * 60 * 60 * 1000;

describe("makeDeadManBudget", () => {
  it("first arm counts; a refresh while still armed is free", () => {
    const b = makeDeadManBudget();
    const t0 = 1_000_000;
    const d1 = b.decide("0xo", t0, 60_000);
    expect(d1).toEqual({ skip: false, time: t0 + 60_000, counts: true });
    b.record("0xo", t0, d1.skip ? 0 : d1.time, d1.skip ? false : d1.counts);
    // 30s later, still armed (armedUntil = t0+60000 > t0+30000) -> free refresh
    const t1 = t0 + 30_000;
    const d2 = b.decide("0xo", t1, 60_000);
    expect(d2).toEqual({ skip: false, time: t1 + 60_000, counts: false });
  });

  it("skips a new arm once the daily budget of 10 is exhausted", () => {
    const b = makeDeadManBudget();
    let t = 1_000_000;
    // Force 10 counting arms by letting each expire before the next (arm -> jump past armedUntil).
    for (let i = 0; i < 10; i++) {
      const d = b.decide("0xo", t, 1_000); // ttl 1s
      expect(d.skip).toBe(false);
      if (!d.skip) {
        expect(d.counts).toBe(true);
        b.record("0xo", t, d.time, d.counts);
      }
      t += 2_000; // advance past armedUntil (t + 1000) so next decide is a NEW arm
    }
    // 11th new arm same day -> skip (budget exhausted)
    expect(b.decide("0xo", t, 1_000)).toEqual({ skip: true });
  });

  it("re-arms (counts) after the schedule expired", () => {
    const b = makeDeadManBudget();
    const t0 = 1_000_000;
    const d0 = b.decide("0xo", t0, 10_000);
    b.record("0xo", t0, (d0 as any).time, (d0 as any).counts); // armedUntil = t0+10000
    const t1 = t0 + 20_000; // past armedUntil -> expired
    expect(b.decide("0xo", t1, 10_000)).toEqual({ skip: false, time: t1 + 10_000, counts: true });
  });

  it("resets the daily count at the UTC day boundary but keeps an armed schedule free", () => {
    const b = makeDeadManBudget();
    const t0 = 5 * DAY + 1_000; // somewhere in day 5
    const d0 = b.decide("0xo", t0, 3 * DAY); // long ttl so it stays armed across midnight
    b.record("0xo", t0, (d0 as any).time, (d0 as any).counts); // count=1 day5, armedUntil = t0+3*DAY
    const t1 = 6 * DAY + 1_000; // day 6, still armed (armedUntil > t1)
    const d1 = b.decide("0xo", t1, 3 * DAY);
    expect(d1).toEqual({ skip: false, time: t1 + 3 * DAY, counts: false }); // free refresh across day roll
  });

  it("tracks owners independently", () => {
    const b = makeDeadManBudget();
    const t = 1_000_000;
    const da = b.decide("0xa", t, 60_000);
    b.record("0xa", t, (da as any).time, (da as any).counts);
    // A fresh owner still gets a counting first arm.
    expect(b.decide("0xb", t, 60_000)).toEqual({ skip: false, time: t + 60_000, counts: true });
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest deadMan`
Expected: FAIL（`makeDeadManBudget` 未定义）。

- [ ] **Step 3: 实现 `server/src/engine/deadMan.ts`（budget 部分）**

```ts
/** Max counting scheduleCancel arms per UTC day (HL dead-man limit). Refreshing a still-future
 *  armed schedule is free and does not count. */
export const DEADMAN_MAX_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DeadManDecision = { skip: true } | { skip: false; time: number; counts: boolean };

export interface DeadManBudget {
  /** Decide the action for owner at nowMs: a free refresh, a counting new-arm, or skip when the
   *  daily budget is exhausted and a new arm would be needed. Does NOT mutate state. */
  decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision;
  /** Commit a SUCCESSFUL send: set armedUntil=time; increment the day's counter iff counts. */
  record(owner: string, nowMs: number, time: number, counts: boolean): void;
}

interface OwnerState {
  day: number;
  count: number;
  armedUntil: number;
}

export function makeDeadManBudget(): DeadManBudget {
  const state = new Map<string, OwnerState>();
  return {
    decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision {
      const time = nowMs + ttlMs;
      const day = Math.floor(nowMs / DAY_MS);
      const prev = state.get(owner);
      const count = prev && prev.day === day ? prev.count : 0;
      const armedUntil = prev ? prev.armedUntil : 0;
      if (armedUntil > nowMs) return { skip: false, time, counts: false }; // still armed -> free refresh
      if (count >= DEADMAN_MAX_PER_DAY) return { skip: true }; // new arm needed but budget exhausted
      return { skip: false, time, counts: true };
    },
    record(owner: string, nowMs: number, time: number, counts: boolean): void {
      const day = Math.floor(nowMs / DAY_MS);
      const prev = state.get(owner);
      const base = prev && prev.day === day ? prev.count : 0;
      state.set(owner, { day, count: base + (counts ? 1 : 0), armedUntil: time });
    },
  };
}
```

- [ ] **Step 4: 运行确认 PASS**

Run: `cd server && npx jest deadMan && npx tsc --noEmit`
Expected: budget 测试全绿；tsc 无错（本文件自洽；heartbeat 在 Task 3 加）。

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/engine/deadMan.ts server/src/engine/deadMan.test.ts
git commit --no-verify -m "feat(server): dead-man budget (<=10/day armed-state, refresh-free)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `makeDeadManExecutor` — scheduleCancel 执行器

**Files:**
- Create: `server/src/agent/deadManExecutor.ts`
- Test: `server/src/agent/deadManExecutor.test.ts`

依赖：无（与 Task 1 独立）。

### 背景
`@nktkas/hyperliquid` ExchangeClient 有 `scheduleCancel(params: { time?: number }): Promise<...>`。参照现有 `restingExecutor.ts` 的执行器风格（clientFor 注入、shadowVerify fire-and-forget、catch 返回）。

- [ ] **Step 1: 写失败测试 `server/src/agent/deadManExecutor.test.ts`**

```ts
import { makeDeadManExecutor, type DeadManClientLike } from "./deadManExecutor";

function deps(client: DeadManClientLike | undefined, shadowVerify?: (kind: string, params: unknown) => void) {
  return { clientFor: () => client, shadowVerify };
}

describe("makeDeadManExecutor.arm", () => {
  it("sends scheduleCancel with the target time and returns true", async () => {
    const calls: any[] = [];
    const client: DeadManClientLike = { scheduleCancel: async (p) => { calls.push(p); return {}; } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(true);
    expect(calls[0]).toEqual({ time: 1_700_000_060_000 });
  });
  it("returns false with no client (fail-closed)", async () => {
    const exec = makeDeadManExecutor(deps(undefined));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(false);
  });
  it("returns false when scheduleCancel throws (fail-closed, no record)", async () => {
    const client: DeadManClientLike = { scheduleCancel: async () => { throw new Error("rate limited"); } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(false);
  });
  it("shadow-verifies the scheduleCancel time, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: DeadManClientLike = { scheduleCancel: async () => ({}) };
    const exec = makeDeadManExecutor(deps(client, shadow));
    await exec.arm("0xo", 1_700_000_060_000);
    expect(shadow).toHaveBeenCalledWith("scheduleCancel", { time: 1_700_000_060_000 });
  });
  it("a throwing shadowVerify never affects the arm", async () => {
    const client: DeadManClientLike = { scheduleCancel: async () => ({}) };
    const exec = makeDeadManExecutor(deps(client, () => { throw new Error("shadow boom"); }));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest deadManExecutor`
Expected: FAIL（`makeDeadManExecutor` 未定义）。

- [ ] **Step 3: 实现 `server/src/agent/deadManExecutor.ts`**

```ts
/** Narrow agent-signed client surface for the dead-man switch. @nktkas ExchangeClient satisfies it. */
export interface DeadManClientLike {
  scheduleCancel(params: { time?: number }): Promise<unknown>;
}

export interface DeadManExecutorDeps {
  clientFor(owner: string): DeadManClientLike | undefined;
  /** Optional fire-and-forget shadow verifier (compares Go signer digest); never affects execution. */
  shadowVerify?: (kind: string, params: unknown) => void;
}

export interface DeadManExecutor {
  /** Arm (or refresh) the owner's scheduleCancel to fire at timeMs. Returns false on no client or error. */
  arm(owner: string, timeMs: number): Promise<boolean>;
}

/**
 * Build the dead-man executor on an agent-signed client. Each arm sends a scheduleCancel with the
 * target fire time (ms). Fails closed: no client or a thrown error returns false so the heartbeat
 * does NOT mark the owner armed and retries next tick.
 */
export function makeDeadManExecutor(deps: DeadManExecutorDeps): DeadManExecutor {
  return {
    async arm(owner: string, timeMs: number): Promise<boolean> {
      const client = deps.clientFor(owner);
      if (!client) return false;
      try {
        deps.shadowVerify?.("scheduleCancel", { time: timeMs });
      } catch {
        /* shadow must never affect execution */
      }
      try {
        await client.scheduleCancel({ time: timeMs });
        return true;
      } catch {
        return false; // fail-closed: not armed this tick; heartbeat retries
      }
    },
  };
}
```

- [ ] **Step 4: 运行确认 PASS**

Run: `cd server && npx jest deadManExecutor && npx tsc --noEmit`
Expected: 全绿；tsc 无错。

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/agent/deadManExecutor.ts server/src/agent/deadManExecutor.test.ts
git commit --no-verify -m "feat(server): dead-man executor (scheduleCancel, never-throw fail-closed)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `deadManHeartbeat` + `index.ts` 装配

**Files:**
- Modify: `server/src/engine/deadMan.ts`（追加 heartbeat 导出）
- Test: `server/src/engine/deadMan.test.ts`（追加 heartbeat 测试）
- Modify: `server/src/index.ts`

依赖：Task 1（budget）+ Task 2（executor）。

### 背景（index.ts 当前，:88-106）
```ts
  const killSwitch = process.env.GLOBAL_KILL === "1";
  const timer = setInterval(() => {
    void tick(
      store, placer,
      { maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc, maxOpenOrders },
      killSwitch, now(), activity,
      { resolveMark: resolvers.resolvePrice, resolvePosition: resolvers.resolvePosition },
      restingExec, ordersReader, userFillsReader,
    ).catch((e) => console.error("scheduler tick failed", e));
  }, tickMs);
  timer.unref?.();
```
`clientFor`、`shadowVerify`、`store`、`now` 均已在 index.ts 作用域（现有 placer/restingExec 装配已用）。`store.listAll()` 返回策略列表，元素有 `.owner` 与 `.status`（"running" 等）。

- [ ] **Step 1: 追加 heartbeat 失败测试到 `server/src/engine/deadMan.test.ts`**

在文件末尾追加 heartbeat 测试。并把文件顶部的 `import { makeDeadManBudget } from "./deadMan";` 改为 `import { makeDeadManBudget, deadManHeartbeat } from "./deadMan";`（合并，避免重复 import）：
```ts
describe("deadManHeartbeat", () => {
  const ttl = 60_000;
  const now = 2_000_000;

  it("arms and records each active owner once", async () => {
    const armed: Array<{ owner: string; time: number }> = [];
    const executor = { arm: jest.fn(async (owner: string, time: number) => { armed.push({ owner, time }); return true; }) };
    const budget = makeDeadManBudget();
    await deadManHeartbeat({ activeOwners: () => ["0xa", "0xb"], budget, executor, now: () => now, ttlMs: ttl });
    expect(armed).toEqual([{ owner: "0xa", time: now + ttl }, { owner: "0xb", time: now + ttl }]);
    // Recorded: an immediate second heartbeat at the same time is a free refresh (still counts:false, still arms).
    expect(executor.arm).toHaveBeenCalledTimes(2);
  });

  it("dedups repeated owners", async () => {
    const executor = { arm: jest.fn(async () => true) };
    await deadManHeartbeat({ activeOwners: () => ["0xa", "0xa", "0xa"], budget: makeDeadManBudget(), executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).toHaveBeenCalledTimes(1);
  });

  it("does not arm when the budget says skip", async () => {
    const executor = { arm: jest.fn(async () => true) };
    const budget = { decide: () => ({ skip: true as const }), record: jest.fn() };
    await deadManHeartbeat({ activeOwners: () => ["0xa"], budget, executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).not.toHaveBeenCalled();
  });

  it("does not record when arm fails (retry next tick)", async () => {
    const executor = { arm: jest.fn(async () => false) };
    const record = jest.fn();
    const budget = { decide: () => ({ skip: false as const, time: now + ttl, counts: true }), record };
    await deadManHeartbeat({ activeOwners: () => ["0xa"], budget, executor, now: () => now, ttlMs: ttl });
    expect(executor.arm).toHaveBeenCalledWith("0xa", now + ttl);
    expect(record).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest deadMan -t deadManHeartbeat`
Expected: FAIL（`deadManHeartbeat` 未导出）。

- [ ] **Step 3: 在 `server/src/engine/deadMan.ts` 追加 heartbeat**

在文件末尾追加（import 执行器与预算类型；`DeadManExecutor` 来自 agent 层）：
```ts
import type { DeadManExecutor } from "../agent/deadManExecutor";

export interface DeadManHeartbeatDeps {
  /** Owners with >=1 running strategy. Duplicates are de-duped internally. */
  activeOwners(): string[];
  budget: DeadManBudget;
  executor: DeadManExecutor;
  now(): number;
  ttlMs: number;
}

/** One heartbeat pass: for each active owner, arm/refresh scheduleCancel per the budget, recording
 *  only on a successful send. Sequential (no concurrency). Never throws for a single owner. */
export async function deadManHeartbeat(deps: DeadManHeartbeatDeps): Promise<void> {
  const now = deps.now();
  for (const owner of new Set(deps.activeOwners())) {
    const d = deps.budget.decide(owner, now, deps.ttlMs);
    if (d.skip) continue;
    if (await deps.executor.arm(owner, d.time)) deps.budget.record(owner, now, d.time, d.counts);
  }
}
```

- [ ] **Step 4: 运行确认 PASS**

Run: `cd server && npx jest deadMan`
Expected: budget + heartbeat 测试全绿。

- [ ] **Step 5: 装配到 `index.ts`**

(a) 在 import 区加（与其它 agent/engine import 同组）：
```ts
import { makeDeadManExecutor } from "./agent/deadManExecutor";
import { makeDeadManBudget, deadManHeartbeat } from "./engine/deadMan";
```
(b) 在 `const killSwitch = ...`（:88）之前或之后、`setInterval` 之前，加装配：
```ts
  const deadManTtlMs = process.env.DEADMAN_TTL_MS ? Number(process.env.DEADMAN_TTL_MS) : undefined;
  const deadManEnabled = deadManTtlMs !== undefined && Number.isFinite(deadManTtlMs) && deadManTtlMs >= 10_000;
  const deadManExecutor = makeDeadManExecutor({ clientFor, shadowVerify });
  const deadManBudget = makeDeadManBudget();
  const activeOwners = () => [...new Set(store.listAll().filter((s) => s.status === "running").map((s) => s.owner))];
```
(c) 在 `setInterval` 回调内、`void tick(...).catch(...)` 之后追加：
```ts
    if (deadManEnabled) {
      void deadManHeartbeat({
        activeOwners,
        budget: deadManBudget,
        executor: deadManExecutor,
        now,
        ttlMs: deadManTtlMs as number,
      }).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("dead-man heartbeat failed", e),
      );
    }
```

> 注：若 `shadowVerify` 在 index.ts 中的变量名不同（如它是从某处解构），据实对齐；它已被 `makeRestingExecutor({ clientFor, ..., shadowVerify })` 使用，故同名可用。`clientFor` 同理已在作用域。

- [ ] **Step 6: 全量门禁**

Run:
```bash
cd server
npm run typecheck
npm test
```
Expected: typecheck 无错；全套件绿（含新增 deadMan / deadManExecutor 测试）。

- [ ] **Step 7: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/engine/deadMan.ts server/src/engine/deadMan.test.ts server/src/index.ts
git commit --no-verify -m "feat(server): dead-man heartbeat + DEADMAN_TTL_MS wiring (scheduleCancel)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd server && npm run typecheck && npm test
```

既有测试基线保持绿；新增覆盖：budget 免费刷新/计数布防/≤10 skip/跨日重置/过期重布防；executor arm/无 client/抛错/shadow；heartbeat 布防+record/dedup/skip/失败不 record。
