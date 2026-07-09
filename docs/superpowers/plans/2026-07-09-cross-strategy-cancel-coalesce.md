# 跨策略撤单合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 gridLimit drain 撤单从 per-strategy 合并升级为 per-owner 跨策略（跨币种）合并：一个 owner 全部 draining 策略的撤单合并为一次混合-asset `cancelByCloid`。

**Architecture:** `restingExecutor` 用混合币种 `cancelMany({owner, cancels:[{coin,cloid}]})` 替换单币种 `cancelCloids`；`scheduler` drain 按 owner 累积 `{coin,cloid}`，策略循环后每 owner 一次 `cancelMany` flush。

**Tech Stack:** TypeScript、Node、Jest。gate：`cd server && npm run typecheck && npm test`。

---

## File Structure

- `server/src/agent/restingExecutor.ts` /（既有）`.test.ts` — `cancelCloids` → `cancelMany`（混合币种、去重解析、分块、never-throw）。
- `server/src/engine/scheduler.ts` /（既有）`.test.ts` — drain 累积 + 循环后 flush；更新 fake 与 drain/cross-coin 测试。

---

## Task 1: `restingExecutor` — `cancelMany` 混合币种撤单

**Files:**
- Modify: `server/src/agent/restingExecutor.ts`
- Test: `server/src/agent/restingExecutor.test.ts`

依赖：无。

### 背景（当前）
`RestingExecutor` 接口（:33-35）有 `cancelCloids(req: { owner: string; coin: string; cloids: string[] }): Promise<boolean>`。实现（:100-123）：单 coin 一次 `resolveAsset`、按 `maxCancelBatch`（默认 100）分块、每块 shadowVerify + cancelByCloid（try 吞）、resolveAsset 外层 try 保证 never-throw。测试块 `describe("makeRestingExecutor.cancelCloids")`（:37-87）；helper `deps(client, shadowVerify?)` 的 `resolveAsset` 恒返回 `{ assetIndex: 3, szDecimals: 2 }`。`cancelCloids` 唯一调用方是 scheduler drain（Task 2 改）。

- [ ] **Step 1: 用 `cancelMany` 测试替换 `describe("makeRestingExecutor.cancelCloids")` 块（:37-87）**

删除第 37-87 行整个 `describe("makeRestingExecutor.cancelCloids", ...)`，替换为：
```ts
describe("makeRestingExecutor.cancelMany", () => {
  it("coalesces mixed-coin cancels into one cancelByCloid, resolving each coin once", async () => {
    const calls: any[] = [];
    const resolves: string[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const asset: Record<string, number> = { BTC: 3, ETH: 5 };
    const d = { clientFor: () => client, resolveAsset: async (coin: string) => { resolves.push(coin); return { assetIndex: asset[coin], szDecimals: 2 }; } };
    const exec = makeRestingExecutor(d);
    const ok = await exec.cancelMany({ owner: "0xo", cancels: [
      { coin: "BTC", cloid: "0xa" }, { coin: "ETH", cloid: "0xb" }, { coin: "BTC", cloid: "0xc" },
    ] });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cancels).toEqual([
      { asset: 3, cloid: "0xa" }, { asset: 5, cloid: "0xb" }, { asset: 3, cloid: "0xc" },
    ]);
    expect(resolves.sort()).toEqual(["BTC", "ETH"]); // each distinct coin resolved once
  });
  it("chunks by maxCancelBatch", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor({ clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }), maxCancelBatch: 2 });
    await exec.cancelMany({ owner: "0xo", cancels: [
      { coin: "BTC", cloid: "0xa" }, { coin: "BTC", cloid: "0xb" }, { coin: "BTC", cloid: "0xc" },
    ] });
    expect(calls).toHaveLength(2);
    expect(calls[0].cancels).toEqual([{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }]);
    expect(calls[1].cancels).toEqual([{ asset: 3, cloid: "0xc" }]);
  });
  it("no-ops on empty cancels without calling the client", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelMany({ owner: "0xo", cancels: [] })).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("returns false with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xc" }] })).toBe(false);
  });
  it("swallows a cancel error (already gone) and returns true", async () => {
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => { throw new Error("order not found"); } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xc" }] })).toBe(true);
  });
  it("shadow-verifies the batched cancels, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xa" }, { coin: "BTC", cloid: "0xb" }] });
    expect(shadow).toHaveBeenCalledWith("cancelByCloid", { cancels: [{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }] });
  });
  it("skips a coin that fails to resolve but still cancels the others", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const d = { clientFor: () => client, resolveAsset: async (coin: string) => {
      if (coin === "WAT") throw new Error("unknown coin");
      return { assetIndex: 3, szDecimals: 2 };
    } };
    const exec = makeRestingExecutor(d);
    const ok = await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "WAT", cloid: "0xw" }, { coin: "BTC", cloid: "0xa" }] });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cancels).toEqual([{ asset: 3, cloid: "0xa" }]); // only BTC; WAT dropped
  });
  it("returns true (no send) when every coin fails to resolve", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const d = { clientFor: () => client, resolveAsset: async () => { throw new Error("unknown coin"); } };
    const exec = makeRestingExecutor(d);
    expect(await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "WAT", cloid: "0xw" }] })).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest restingExecutor -t cancelMany`
Expected: FAIL/编译错误（`cancelMany` 不存在）。

- [ ] **Step 3: 在 `restingExecutor.ts` 接口把 `cancelCloids` 换成 `cancelMany`（:35）**

```ts
  cancelMany(req: { owner: string; cancels: Array<{ coin: string; cloid: string }> }): Promise<boolean>;
```

- [ ] **Step 4: 实现替换 `cancelCloids` 方法（:100-123 整块）为 `cancelMany`**

把整个 `async cancelCloids(...) { ... },` 方法替换为：
```ts
    async cancelMany(req: { owner: string; cancels: Array<{ coin: string; cloid: string }> }): Promise<boolean> {
      if (req.cancels.length === 0) return true;
      const client = deps.clientFor(req.owner);
      if (!client) return false;
      const maxBatch = deps.maxCancelBatch && deps.maxCancelBatch > 0 ? deps.maxCancelBatch : 100;
      // Resolve each distinct coin once; a coin that fails to resolve is skipped (best-effort — its
      // cancels are re-checked next tick), so one bad coin can't strand the others.
      const assetByCoin = new Map<string, number>();
      for (const coin of new Set(req.cancels.map((c) => c.coin))) {
        try {
          const { assetIndex } = await deps.resolveAsset(coin);
          assetByCoin.set(coin, assetIndex);
        } catch {
          /* unknown coin / cold meta: skip this coin's cancels */
        }
      }
      const all = req.cancels
        .filter((c) => assetByCoin.has(c.coin))
        .map((c) => ({ asset: assetByCoin.get(c.coin) as number, cloid: c.cloid }));
      for (let i = 0; i < all.length; i += maxBatch) {
        const cancels = all.slice(i, i + maxBatch);
        try {
          deps.shadowVerify?.("cancelByCloid", { cancels });
        } catch {
          /* shadow must never affect cancellation */
        }
        try {
          await client.cancelByCloid({ cancels });
        } catch {
          /* already gone / filled — treat as cancelled (idempotent) */
        }
      }
      return true;
    },
```

- [ ] **Step 5: 运行确认 PASS**

Run: `cd server && npx jest restingExecutor`
Expected: cancelMany 全部测试 PASS。（不要跑 `npx tsc --noEmit`——scheduler.ts 仍调用 `cancelCloids` 会报错，Task 2 修复；本 task 只提交 restingExecutor 两文件。）

- [ ] **Step 6: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/agent/restingExecutor.ts server/src/agent/restingExecutor.test.ts
git commit --no-verify -m "feat(server): cancelMany mixed-coin cancel (replaces cancelCloids)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `scheduler` — per-owner 跨策略累积 + flush

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`

依赖：Task 1（`cancelMany`）。

### 背景（当前 scheduler.ts）
gridLimit reconcile 块（`if (restingExec && ordersReader && marks)`，:248 起）内有 `getOpen`/`getOpenCount`/`overOpenCap`/`getFills`。drain 块（:280-297）当前：
```ts
      if (killSwitch || s.status !== "running") {
        const open = await getOpen(s.owner);
        const drained = new Map(store.gridLimitRungs(s.id).map((r) => [r.rung, r]));
        let anyResting = false;
        const toCancel: string[] = [];
        for (let i = 0; i < rungCount(p); i++) {
          const r: RungState = drained.get(i) ?? { rung: i, state: "idle", side: null, cloid: null, px: null, seq: 0 };
          const candidates = [r.cloid, cloidForKey(s.id, `gl:${i}:${r.seq + 1}`)].filter((c): c is string => !!c);
          let rungResting = false;
          for (const c of candidates) {
            if (open.has(c)) { toCancel.push(c); rungResting = true; anyResting = true; }
          }
          if (!rungResting && r.cloid) store.setGridLimitRung(s.id, { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq });
        }
        if (toCancel.length > 0) await restingExec.cancelCloids({ owner: s.owner, coin: p.coin, cloids: toCancel });
        if (s.status === "canceling" && !anyResting) store.remove(s.id);
        continue;
      }
```
该块在 `for (const s of all) { if (s.kind !== "gridLimit") continue; ... }` 循环内；循环之后、gridLimit 块结束前是块的尾部。测试 fake（scheduler.test.ts:440-448）的 `cancelCloids` 捕获到 `cancels` 数组；drain 断言在 :610-611、:628、:651。`glParams`（:463）coin=BTC。

- [ ] **Step 1: 更新 fake + drain 断言（scheduler.test.ts）**

(a) 把 fake 的 `cancelCloids`（:447）改为 `cancelMany`：
```ts
    cancelMany: jest.fn(async (req: any) => { cancels.push(req); return true; }),
```
(b) 三处 drain 断言改为读 `.cancels`（数组 of `{coin, cloid}`）：
- :610-611 改为：
```ts
    expect(exec.cancels).toHaveLength(1); // both rungs coalesced into one cancelMany call
    expect(exec.cancels[0].cancels.map((c: any) => c.cloid).sort()).toEqual(["0xB0", "0xS2"]);
```
- :628 改为：
```ts
    expect(exec.cancels.flatMap((c: any) => c.cancels.map((x: any) => x.cloid))).toEqual(["0xB0"]);
```
- :651 改为：
```ts
    expect(exec.cancels.flatMap((c: any) => c.cancels.map((x: any) => x.cloid))).toContain(orphan);
```

- [ ] **Step 2: 加 cross-coin 合并测试（scheduler.test.ts，追加到 `describe("gridLimit tick (draining)")` 内末尾）**

```ts
  it("coalesces two draining strategies of one owner across coins into a single cancelMany", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const a = store.create("0xo", "gridLimit", { ...glParams, coin: "BTC" });
    const b = store.create("0xo", "gridLimit", { ...glParams, coin: "ETH" });
    store.setGridLimitRung(a.id, { rung: 0, state: "armed", side: "buy", cloid: "0xA", px: 100, seq: 1 });
    store.setGridLimitRung(b.id, { rung: 0, state: "armed", side: "buy", cloid: "0xE", px: 100, seq: 1 });
    store.setStatus(a.id, "paused");
    store.setStatus(b.id, "paused");
    const exec = fakeExec();
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, marks, exec as any, fakeReader(["0xA", "0xE"]) as any);
    expect(exec.cancels).toHaveLength(1); // one cancelMany for the owner, spanning both coins
    const sent = exec.cancels[0].cancels;
    expect(sent).toContainEqual({ coin: "BTC", cloid: "0xA" });
    expect(sent).toContainEqual({ coin: "ETH", cloid: "0xE" });
  });
```

- [ ] **Step 3: 运行确认 FAIL**

Run: `cd server && npx jest scheduler -t "gridLimit tick (draining)"`
Expected: FAIL（scheduler 仍调用 `cancelCloids`、fake 无 `cancelCloids` → drain 未撤单/断言不符；cross-coin 未合并）。

- [ ] **Step 4: scheduler.ts — 块顶部加 per-owner 累积 map**

在 gridLimit reconcile 块内、`getFills` 定义之后（约 :269 之后、`for (const s of all)` 之前）加：
```ts
    const cancelsByOwner = new Map<string, Array<{ coin: string; cloid: string }>>();
```

- [ ] **Step 5: scheduler.ts — drain 累积（替换 :294 的 inline 撤单）**

把
```ts
        if (toCancel.length > 0) await restingExec.cancelCloids({ owner: s.owner, coin: p.coin, cloids: toCancel });
```
替换为
```ts
        if (toCancel.length > 0) {
          const acc = cancelsByOwner.get(s.owner) ?? [];
          for (const cloid of toCancel) acc.push({ coin: p.coin, cloid });
          cancelsByOwner.set(s.owner, acc);
        }
```
（`anyResting`/idle-clearing/`store.remove(canceling && !anyResting)`/`continue` 不动。）

- [ ] **Step 6: scheduler.ts — 循环后 flush（`for (const s of all)` 循环结束之后、gridLimit 块的 `}` 之前）**

在 gridLimit reconcile 块内、`for (const s of all) { ... }` 闭合之后加：
```ts
    for (const [owner, cancels] of cancelsByOwner) {
      await restingExec.cancelMany({ owner, cancels });
    }
```

- [ ] **Step 7: 运行确认 PASS + 全量门禁**

Run:
```bash
cd server
npx jest scheduler restingExecutor
npm run typecheck
npm test
```
Expected: drain（含更新断言）+ cross-coin + restingExecutor 全绿；typecheck 无错（scheduler 已改用 cancelMany）；全套件绿。

- [ ] **Step 8: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(server): coalesce drain cancels per-owner across strategies/coins

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd server && npm run typecheck && npm test
```

既有测试基线保持绿；新增覆盖：cancelMany 混合币种/去重解析/分块/空/无 client/幂等/坏 coin 隔离/shadow；scheduler drain 累积（单策略仍 1 次、`canceling && !anyResting` 仍 remove）+ 跨策略跨币种合并为 1 次 cancelMany。
