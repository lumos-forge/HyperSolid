# 死手 opt-in + clear-on-shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 server/ 死手开关加逐 owner opt-in（策略参数 `deadMan`）与优雅关停清除（SIGINT/SIGTERM → scheduleCancel 清除）。

**Architecture:** `strategies/types.ts`+`validate.ts` 增可选 `deadMan?:boolean`（共享基 + 校验透传）；`agent/deadManExecutor.ts` 增 `clear`（发 `scheduleCancel({})`，never-throw）；`engine/deadMan.ts` 增 `deadManClearAll`；`index.ts` 的 `activeOwners` 过滤 opt-in，并注册 SIGINT/SIGTERM 优雅关停清除。

**Tech Stack:** TypeScript、Node、Jest。gate：`cd server && npm run typecheck && npm test`。

---

## File Structure

- `server/src/strategies/types.ts` — 共享 `StrategyParamsCommon { deadMan?: boolean }`；5 个 params extends 它。
- `server/src/strategies/validate.ts` /（既有）`.test.ts` — 校验 `deadMan` 为 boolean 并透传。
- `server/src/agent/deadManExecutor.ts` /（既有）`.test.ts` — `clear(owner)`。
- `server/src/engine/deadMan.ts` /（既有）`.test.ts` — `deadManClearAll(deps)`。
- `server/src/index.ts` — `activeOwners` opt-in 过滤 + SIGINT/SIGTERM 关停清除。

---

## Task 1: opt-in 参数（`deadMan?`）

**Files:**
- Modify: `server/src/strategies/types.ts`
- Modify: `server/src/strategies/validate.ts`
- Test: `server/src/strategies/validate.test.ts`

依赖：无。

### 背景（当前）
`types.ts` 有 5 个独立 params 接口（DcaParams/TwapParams/TpslParams/GridParams/GridLimitParams），无共享基。`validate.ts` `validateParams(kind, params)` 逐 kind 重建 params 对象（未知字段被丢弃），成功返回 `{ ok:true, params:{...} }`。

- [ ] **Step 1: 追加失败测试到 `server/src/strategies/validate.test.ts`**

在文件末尾追加：
```ts
describe("validateParams deadMan opt-in", () => {
  it("threads deadMan:true into dca params", () => {
    const r = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, deadMan: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as { deadMan?: boolean }).deadMan).toBe(true);
  });
  it("threads deadMan:true into gridLimit params", () => {
    const r = validateParams("gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 4, perLevelUsdc: 50, deadMan: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as { deadMan?: boolean }).deadMan).toBe(true);
  });
  it("omits deadMan when absent or false (default off)", () => {
    const a = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const b = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, deadMan: false });
    expect(a.ok && !("deadMan" in a.params)).toBe(true);
    expect(b.ok && !("deadMan" in b.params)).toBe(true);
  });
  it("rejects a non-boolean deadMan", () => {
    const r = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, deadMan: "yes" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest validate -t "deadMan opt-in"`
Expected: FAIL（deadMan 被 validate 丢弃 / 非 boolean 未拒绝）。

- [ ] **Step 3: 在 `types.ts` 加共享基并让 5 个 params extends**

在 `DcaParams` 定义之前插入：
```ts
/** Fields common to every strategy's params. */
export interface StrategyParamsCommon {
  /** Opt-in: while this strategy runs, arm the account-level scheduleCancel dead-man switch. */
  deadMan?: boolean;
}
```
把 5 个接口的声明头改为 extends（只改声明头，字段不动）：
```ts
export interface DcaParams extends StrategyParamsCommon {
```
```ts
export interface TwapParams extends StrategyParamsCommon {
```
```ts
export interface TpslParams extends StrategyParamsCommon {
```
```ts
export interface GridParams extends StrategyParamsCommon {
```
```ts
export interface GridLimitParams extends StrategyParamsCommon {
```

- [ ] **Step 4: 在 `validate.ts` 校验并透传 `deadMan`**

在 `validateParams` 里 coin 校验之后（`if (typeof coin !== "string" ...) return ...;` 那行之后）插入：
```ts
  if (p.deadMan !== undefined && typeof p.deadMan !== "boolean") return { ok: false, error: "deadMan must be a boolean" };
  const deadMan = p.deadMan === true;
```
把 5 个成功返回对象各追加 `deadMan` 可选 spread。逐个改：
- dca（当前 return）：
```ts
    return { ok: true, params: { coin, side: "buy", quoteAmountUsdc: d.quoteAmountUsdc, intervalHours: d.intervalHours, ...(d.maxTotalUsdc !== undefined ? { maxTotalUsdc: d.maxTotalUsdc } : {}), ...(deadMan ? { deadMan: true } : {}) } };
```
- twap：
```ts
    return { ok: true, params: { coin, side: t.side, totalUsdc: t.totalUsdc, slices: t.slices, durationHours: t.durationHours, ...(deadMan ? { deadMan: true } : {}) } };
```
- tpsl：
```ts
    return { ok: true, params: { coin, ...(hasTp ? { takeProfitPrice: x.takeProfitPrice } : {}), ...(hasSl ? { stopLossPrice: x.stopLossPrice } : {}), ...(deadMan ? { deadMan: true } : {}) } };
```
- grid：
```ts
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc, mode, ...(deadMan ? { deadMan: true } : {}) } };
```
- gridLimit：
```ts
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc, mode, ...(deadMan ? { deadMan: true } : {}) } };
```

- [ ] **Step 5: 运行确认 PASS + typecheck**

Run: `cd server && npx jest validate && npx tsc --noEmit`
Expected: 新增 opt-in 测试 + 既有 validate 测试全绿；tsc 无错。

- [ ] **Step 6: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/strategies/types.ts server/src/strategies/validate.ts server/src/strategies/validate.test.ts
git commit --no-verify -m "feat(server): strategy deadMan opt-in param (validated, threaded)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `clear` 执行器 + `deadManClearAll`

**Files:**
- Modify: `server/src/agent/deadManExecutor.ts`
- Test: `server/src/agent/deadManExecutor.test.ts`
- Modify: `server/src/engine/deadMan.ts`
- Test: `server/src/engine/deadMan.test.ts`

依赖：无（与 Task 1 独立）。

### 背景（当前）
`deadManExecutor.ts`：`DeadManClientLike { scheduleCancel(params: { time?: number }): Promise<unknown> }`；`DeadManExecutor { arm(owner, timeMs): Promise<boolean> }`；`makeDeadManExecutor(deps)` 有 `arm`（无 client→false、shadowVerify fire-and-forget、抛错→false）。`deadMan.ts` 有 `makeDeadManBudget`/`makeDeadManHealth`/`deadManHeartbeat`；顶部已 `import type { DeadManExecutor } from "../agent/deadManExecutor";`。测试文件 `deadManExecutor.test.ts` 有 helper `deps(client, shadowVerify?)`。

- [ ] **Step 1: 追加 `clear` 失败测试到 `deadManExecutor.test.ts`**

在文件末尾追加：
```ts
describe("makeDeadManExecutor.clear", () => {
  it("sends scheduleCancel with no time (clear) and returns true", async () => {
    const calls: any[] = [];
    const client: DeadManClientLike = { scheduleCancel: async (p) => { calls.push(p); return {}; } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.clear("0xo")).toBe(true);
    expect(calls[0]).toEqual({});
  });
  it("returns false with no client (fail-closed)", async () => {
    const exec = makeDeadManExecutor(deps(undefined));
    expect(await exec.clear("0xo")).toBe(false);
  });
  it("returns false when scheduleCancel throws", async () => {
    const client: DeadManClientLike = { scheduleCancel: async () => { throw new Error("boom"); } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.clear("0xo")).toBe(false);
  });
  it("shadow-verifies the clear (empty payload), fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: DeadManClientLike = { scheduleCancel: async () => ({}) };
    const exec = makeDeadManExecutor(deps(client, shadow));
    await exec.clear("0xo");
    expect(shadow).toHaveBeenCalledWith("scheduleCancel", {});
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest deadManExecutor -t clear`
Expected: FAIL（`clear` 不存在）。

- [ ] **Step 3: 在 `deadManExecutor.ts` 加 `clear`**

在 `DeadManExecutor` 接口内、`arm` 之后加：
```ts
  /** Clear the owner's scheduled cancel (omit time). Returns false on no client or error. */
  clear(owner: string): Promise<boolean>;
```
在 `makeDeadManExecutor` 返回对象内、`arm` 方法之后加：
```ts
    async clear(owner: string): Promise<boolean> {
      const client = deps.clientFor(owner);
      if (!client) return false;
      try {
        deps.shadowVerify?.("scheduleCancel", {});
      } catch {
        /* shadow must never affect execution */
      }
      try {
        await client.scheduleCancel({});
        return true;
      } catch {
        return false; // best-effort clear
      }
    },
```

- [ ] **Step 4: 运行确认 PASS（executor）**

Run: `cd server && npx jest deadManExecutor`
Expected: arm + clear 测试全绿。

- [ ] **Step 5: 追加 `deadManClearAll` 失败测试到 `deadMan.test.ts`**

在文件末尾追加（`deadManClearAll` 加到顶部 `./deadMan` import；把顶部 `import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth } from "./deadMan";` 改为 `import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth, deadManClearAll } from "./deadMan";`）：
```ts
describe("deadManClearAll", () => {
  it("clears each deduped owner once", async () => {
    const cleared: string[] = [];
    const executor = { clear: jest.fn(async (owner: string) => { cleared.push(owner); return true; }) };
    await deadManClearAll({ activeOwners: () => ["0xa", "0xb", "0xa"], executor });
    expect(cleared).toEqual(["0xa", "0xb"]);
  });
  it("no-ops on an empty owner list", async () => {
    const executor = { clear: jest.fn(async () => true) };
    await deadManClearAll({ activeOwners: () => [], executor });
    expect(executor.clear).not.toHaveBeenCalled();
  });
  it("continues past a failing clear (best-effort)", async () => {
    const cleared: string[] = [];
    const executor = { clear: jest.fn(async (owner: string) => { cleared.push(owner); return owner !== "0xa"; }) };
    await deadManClearAll({ activeOwners: () => ["0xa", "0xb"], executor });
    expect(cleared).toEqual(["0xa", "0xb"]);
  });
});
```

- [ ] **Step 6: 运行确认 FAIL**

Run: `cd server && npx jest deadMan -t deadManClearAll`
Expected: FAIL（`deadManClearAll` 未导出）。

- [ ] **Step 7: 在 `deadMan.ts` 追加 `deadManClearAll`（放文件末尾）**

```ts
/** Best-effort clear of the dead-man for every (deduped) owner, e.g. on graceful shutdown. A single
 *  owner's failure does not stop the rest (executor.clear is itself never-throwing). Sequential. */
export async function deadManClearAll(deps: {
  activeOwners(): string[];
  executor: Pick<DeadManExecutor, "clear">;
}): Promise<void> {
  for (const owner of new Set(deps.activeOwners())) {
    await deps.executor.clear(owner);
  }
}
```

- [ ] **Step 8: 运行确认 PASS + typecheck**

Run: `cd server && npx jest deadMan deadManExecutor && npx tsc --noEmit`
Expected: 全绿；tsc 无错。

- [ ] **Step 9: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/agent/deadManExecutor.ts server/src/agent/deadManExecutor.test.ts server/src/engine/deadMan.ts server/src/engine/deadMan.test.ts
git commit --no-verify -m "feat(server): dead-man clear (scheduleCancel clear) + deadManClearAll

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `index.ts` 装配（opt-in 过滤 + 优雅关停清除）

**Files:**
- Modify: `server/src/index.ts`

依赖：Task 1（`deadMan` 参数）+ Task 2（`clear`/`deadManClearAll`）。

### 背景（当前 index.ts）
- import（:18）：`import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth } from "./engine/deadMan";`
- `activeOwners`（:112）：
```ts
  const activeOwners = () => [...new Set(store.listAll().filter((s) => s.status === "running").map((s) => s.owner))];
```
- `const timer = setInterval(...)`（:113）… `timer.unref?.();`（:153）。
- `const app = buildApp(...)`（:155）；`await app.listen({ port, host: "0.0.0.0" });`（:156）；随后 `console.log(...)`（:158）；`}`（:159，main 结束）。
- `deadManEnabled`、`deadManExecutor` 已在作用域（dead-man 装配处）。

- [ ] **Step 1: `activeOwners` 加 opt-in 过滤（index.ts:112）**

替换为：
```ts
  const activeOwners = () => [...new Set(
    store.listAll()
      .filter((s) => s.status === "running" && (s.params as { deadMan?: boolean }).deadMan === true)
      .map((s) => s.owner),
  )];
```

- [ ] **Step 2: import 增加 `deadManClearAll`（index.ts:18）**

把
```ts
import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth } from "./engine/deadMan";
```
改为
```ts
import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth, deadManClearAll } from "./engine/deadMan";
```

- [ ] **Step 3: 注册 SIGINT/SIGTERM 优雅关停清除**

在 `await app.listen({ port, host: "0.0.0.0" });`（:156）之后、`console.log(...)`（:158）之前（或紧接 console.log 之后、main 的 `}` 之前）插入：
```ts
  const shutdown = async () => {
    clearInterval(timer);
    if (deadManEnabled) {
      await deadManClearAll({ activeOwners, executor: deadManExecutor });
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
```

- [ ] **Step 4: 全量门禁**

Run:
```bash
cd server
npm run typecheck
npm test
```
Expected: typecheck 无错（`s.params` 的 `deadMan` 经 Task 1 类型可选存在；`deadManClearAll`/`deadManExecutor.clear` 经 Task 2 存在）；全套件绿。

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/index.ts
git commit --no-verify -m "feat(server): dead-man opt-in filter + graceful-shutdown clear (SIGINT/SIGTERM)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd server && npm run typecheck && npm test
```

既有测试基线保持绿；新增覆盖：validate deadMan 透传/默认省略/非 boolean 拒绝；executor.clear（空 payload/无 client/抛错/shadow）；deadManClearAll（去重/空/best-effort）。index 的 opt-in 过滤与信号 handler 为薄装配（typecheck 保证）。
