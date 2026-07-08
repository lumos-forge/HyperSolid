# M10-agentic 撤单合并 + 挂单上限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 server/ gridLimit scheduler 增加撤单合并（批量 `cancelByCloid`）与 per-owner 挂单上限（entry 软闸），保护 HL 配额/限频。

**Architecture:** `restingExecutor` 把单发 `cancelCloid` 替换为批量分块 `cancelCloids`；`openOrdersReader` 把 `openCloids` 替换为 `openOrders`（含总挂单数）；`RiskLimits` 增 `maxOpenOrders`；`scheduler` drain 路径合并撤单、entry 放置前用总挂单数做 cap（reduce-only 退出不受限）；`index.ts` 加 `MAX_OPEN_ORDERS` env。

**Tech Stack:** TypeScript、Node、Jest（ts-jest）。gate：`cd server && npm run typecheck && npm test`。

---

## File Structure

- `server/src/agent/restingExecutor.ts` / `.test.ts` — `cancelCloid` → `cancelCloids`（批量+分块），`RestingExecutorDeps.maxCancelBatch?`。
- `server/src/agent/openOrdersReader.ts` / `.test.ts` — `openCloids` → `openOrders`（`{byCloid,total}`）。
- `server/src/risk/guards.ts` — `RiskLimits.maxOpenOrders?`。
- `server/src/engine/scheduler.ts` / `.test.ts` — drain 合并 + getOpen 缓存 total + entry cap；更新 fake。
- `server/src/index.ts` — `MAX_OPEN_ORDERS` env 传入 limits。

---

## Task 1: `restingExecutor` — `cancelCloids` 批量撤单

**Files:**
- Modify: `server/src/agent/restingExecutor.ts`
- Test: `server/src/agent/restingExecutor.test.ts`

依赖：无。

### 背景（当前代码）
`RestingExecutor` 接口（restingExecutor.ts:31-34）：
```ts
export interface RestingExecutor {
  placeLimit(req: PlaceLimitRequest): Promise<PlaceLimitResult>;
  cancelCloid(req: { owner: string; coin: string; cloid: string }): Promise<boolean>;
}
```
当前 `cancelCloid` 实现（restingExecutor.ts:98-113）单发 `client.cancelByCloid({ cancels: [{ assetIndex, cloid }] })`，catch→true（幂等），无 client→false。`RestingExecutorDeps`（:9-14）有 `clientFor`/`resolveAsset`/`shadowVerify`。测试 helper `deps(client, shadowVerify?)` 的 `resolveAsset` 恒返回 `{ assetIndex: 3, szDecimals: 2 }`。

- [ ] **Step 1: 替换 `restingExecutor.test.ts` 的 `describe("makeRestingExecutor.cancelCloid")` 块（第 37-54 行）为 `cancelCloids` 测试**

删除第 37-54 行整个 `describe("makeRestingExecutor.cancelCloid", ...)` 块，替换为：
```ts
describe("makeRestingExecutor.cancelCloids", () => {
  it("coalesces multiple cloids into a single cancelByCloid with one asset resolve", async () => {
    const calls: any[] = [];
    let resolves = 0;
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const d = { clientFor: () => client, resolveAsset: async () => { resolves++; return { assetIndex: 3, szDecimals: 2 }; } };
    const exec = makeRestingExecutor(d);
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xa", "0xb", "0xc"] })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ cancels: [{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }, { asset: 3, cloid: "0xc" }] });
    expect(resolves).toBe(1);
  });
  it("chunks by maxCancelBatch", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor({ clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }), maxCancelBatch: 2 });
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xa", "0xb", "0xc"] })).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].cancels).toEqual([{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }]);
    expect(calls[1].cancels).toEqual([{ asset: 3, cloid: "0xc" }]);
  });
  it("no-ops on empty cloids without calling the client", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: [] })).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("returns false with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xc"] })).toBe(false);
  });
  it("swallows a cancel error (already gone) and returns true", async () => {
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => { throw new Error("order not found"); } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xc"] })).toBe(true);
  });
  it("shadow-verifies the batched cancels, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xa", "0xb"] });
    expect(shadow).toHaveBeenCalledWith("cancelByCloid", { cancels: [{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }] });
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest restingExecutor -t cancelCloids`
Expected: FAIL/编译错误（`cancelCloids` 不存在于 RestingExecutor）。

- [ ] **Step 3: 在 `restingExecutor.ts` 改接口 + deps + 实现**

(a) `RestingExecutorDeps`（:9-14）加一行 `maxCancelBatch`：
```ts
export interface RestingExecutorDeps {
  clientFor(owner: string): RestingClientLike | undefined;
  resolveAsset(coin: string): Promise<{ assetIndex: number; szDecimals: number }>;
  /** Optional fire-and-forget shadow verifier (compares Go signer digest); never affects execution. */
  shadowVerify?: (kind: string, params: unknown) => void;
  /** Max cloids per cancelByCloid request; larger sets are chunked. Default 100. */
  maxCancelBatch?: number;
}
```
(b) `RestingExecutor` 接口（:31-34）把 `cancelCloid` 换成 `cancelCloids`：
```ts
export interface RestingExecutor {
  placeLimit(req: PlaceLimitRequest): Promise<PlaceLimitResult>;
  cancelCloids(req: { owner: string; coin: string; cloids: string[] }): Promise<boolean>;
}
```
(c) 把当前 `cancelCloid` 方法实现（:98-113）整体替换为：
```ts
    async cancelCloids(req: { owner: string; coin: string; cloids: string[] }): Promise<boolean> {
      if (req.cloids.length === 0) return true;
      const client = deps.clientFor(req.owner);
      if (!client) return false;
      const maxBatch = deps.maxCancelBatch && deps.maxCancelBatch > 0 ? deps.maxCancelBatch : 100;
      const { assetIndex } = await deps.resolveAsset(req.coin);
      for (let i = 0; i < req.cloids.length; i += maxBatch) {
        const cancels = req.cloids.slice(i, i + maxBatch).map((cloid) => ({ asset: assetIndex, cloid }));
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

- [ ] **Step 4: 运行确认 PASS**

Run: `cd server && npx jest restingExecutor && npx tsc --noEmit`
Expected: restingExecutor 全绿；tsc **会因 scheduler.ts 仍调用 `cancelCloid` 报错** —— 这是预期的（Task 3 修复 scheduler）。若只想验证本包，可先跑 `npx jest restingExecutor`（PASS）。**本 task 只提交 restingExecutor 两文件，tsc 全绿留到 Task 3。**

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/agent/restingExecutor.ts server/src/agent/restingExecutor.test.ts
git commit --no-verify -m "feat(server): cancelCloids batch cancel with chunking (replaces cancelCloid)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `openOrders` 总挂单数 + `RiskLimits.maxOpenOrders`

**Files:**
- Modify: `server/src/agent/openOrdersReader.ts`
- Test: `server/src/agent/openOrdersReader.test.ts`
- Modify: `server/src/risk/guards.ts`

依赖：无（与 Task 1 独立）。

### 背景（当前代码）
`OpenOrdersReader`（openOrdersReader.ts:13-15）：`openCloids(owner): Promise<Map<string, OpenOrderInfo>>`，实现（:26-44）读 `frontendOpenOrders`、丢弃无 cloid 的单。`RiskLimits`（guards.ts:6-12）有 maxNotionalUsdc/perCoinMaxNotionalUsdc/dailyMaxNotionalUsdc。

- [ ] **Step 1: 改 `openOrdersReader.test.ts` 断言 `openOrders`（含 total）**

先查看 `openOrdersReader.test.ts` 现有测试，把对 `openCloids` 的调用/断言改为 `openOrders`。若无该测试文件或结构不同，追加此测试块（放文件末尾；`makeOpenOrdersReader` 已在文件顶部 import，若无则加 `import { makeOpenOrdersReader } from "./openOrdersReader";`）：
```ts
describe("makeOpenOrdersReader.openOrders", () => {
  it("returns cloid map plus total open-order count (incl. non-cloid manual orders)", async () => {
    const raw = [
      { cloid: "0xa", oid: 1, coin: "BTC", side: "B", limitPx: "100" },
      { cloid: null, oid: 2, coin: "ETH", side: "A", limitPx: "50" }, // manual, no cloid
      { cloid: "0xb", oid: 3, coin: "BTC", side: "A", limitPx: "110" },
    ];
    const reader = makeOpenOrdersReader({ frontendOpenOrders: async () => raw });
    const { byCloid, total } = await reader.openOrders("0xo");
    expect(total).toBe(3); // ALL open orders (HL quota measure)
    expect([...byCloid.keys()].sort()).toEqual(["0xa", "0xb"]); // only cloid-tagged
    expect(byCloid.get("0xa")).toEqual({ oid: 1, coin: "BTC", side: "buy", px: 100 });
  });
  it("returns empty + zero for a non-array response", async () => {
    const reader = makeOpenOrdersReader({ frontendOpenOrders: async () => null });
    const { byCloid, total } = await reader.openOrders("0xo");
    expect(byCloid.size).toBe(0);
    expect(total).toBe(0);
  });
});
```
如果文件里已有断言 `openCloids` 的旧测试，删除或改写为上面的 `openOrders` 形式（`openCloids` 已被移除）。

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd server && npx jest openOrdersReader`
Expected: FAIL（`openOrders` 不存在）。

- [ ] **Step 3: 改 `openOrdersReader.ts` 接口 + 实现**

把接口（:13-15）与实现（:26-44）替换为：
```ts
export interface OpenOrdersReader {
  openOrders(owner: string): Promise<{ byCloid: Map<string, OpenOrderInfo>; total: number }>;
}
```
```ts
/** Poll a user's open orders: index cloid-tagged ones by cloid, and report the TOTAL open-order
 * count (including non-cloid manual orders) — the HL per-address quota measure. */
export function makeOpenOrdersReader(info: OpenOrdersInfoLike): OpenOrdersReader {
  return {
    async openOrders(owner: string): Promise<{ byCloid: Map<string, OpenOrderInfo>; total: number }> {
      const raw = await info.frontendOpenOrders({ user: owner });
      const byCloid = new Map<string, OpenOrderInfo>();
      if (!Array.isArray(raw)) return { byCloid, total: 0 };
      for (const o of raw as RawOpenOrder[]) {
        if (typeof o?.cloid !== "string") continue;
        byCloid.set(o.cloid, {
          oid: Number(o.oid ?? 0),
          coin: o.coin ?? "",
          side: o.side === "A" ? "sell" : "buy",
          px: Number(o.limitPx ?? 0),
        });
      }
      return { byCloid, total: raw.length };
    },
  };
}
```

- [ ] **Step 4: 给 `RiskLimits` 加 `maxOpenOrders`（guards.ts）**

把 `RiskLimits`（:6-12）替换为：
```ts
export interface RiskLimits {
  maxNotionalUsdc: number;
  /** Optional tighter per-coin notional cap; overrides the global cap for listed coins. */
  perCoinMaxNotionalUsdc?: Record<string, number>;
  /** Optional per-owner daily spend (notional) cap; enforced by the scheduler (needs spend state). */
  dailyMaxNotionalUsdc?: number;
  /** Optional per-owner open-order ceiling for NEW entries; undefined/<=0 = disabled (enforced by the scheduler). */
  maxOpenOrders?: number;
}
```
`withinCaps` 不改（不读取新字段）。

- [ ] **Step 5: 运行确认 PASS**

Run: `cd server && npx jest openOrdersReader guards 2>/dev/null; npx jest openOrdersReader`
Expected: openOrdersReader 测试全绿。（guards 若无独立测试文件则忽略。）tsc 仍会因 scheduler 使用旧 `openCloids` 报错 —— 留到 Task 3。

- [ ] **Step 6: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/agent/openOrdersReader.ts server/src/agent/openOrdersReader.test.ts server/src/risk/guards.ts
git commit --no-verify -m "feat(server): openOrders total count + RiskLimits.maxOpenOrders

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: scheduler 合并 + cap 装配

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`
- Modify: `server/src/index.ts`

依赖：Task 1（`cancelCloids`）+ Task 2（`openOrders`、`maxOpenOrders`）。

### 背景（当前代码）
`getOpen`（scheduler.ts:249-254）：
```ts
const openByOwner = new Map<string, Map<string, { side: "buy" | "sell"; px: number }>>();
const getOpen = async (owner: string) => {
  let m = openByOwner.get(owner);
  if (!m) { m = await ordersReader.openCloids(owner); openByOwner.set(owner, m); }
  return m;
};
```
drain 块（:271-286）逐 rung `await restingExec.cancelCloid({ owner, coin, cloid: c })`。`placeBuy`（:308-319）与 `placeShortEntry`（:320-330）在 `open.has(cloid)` 采纳后、`withinCaps` 前放置。测试 fake（scheduler.test.ts:440-452）：`fakeExec` 有 `cancels`+`cancelCloid`；`fakeReader(cloids)` 返回 `{ openCloids }`。drain 测试断言 `exec.cancels.map(c => c.cloid)`（:605/622/645）。

- [ ] **Step 1: 更新 scheduler.test.ts 的 fake（:440-452）**

把 `fakeExec` 的 `cancelCloid` 换成 `cancelCloids`（捕获批量 req），`fakeReader` 换成返回 `openOrders`（含可注入 total）：
```ts
function fakeExec(outcome?: (req: any) => any) {
  const calls: any[] = [];
  const cancels: any[] = [];
  let oid = 1000;
  return {
    calls, cancels,
    placeLimit: jest.fn(async (req: any) => { calls.push(req); return outcome ? outcome(req) : { ok: true, oid: oid++ }; }),
    cancelCloids: jest.fn(async (req: any) => { cancels.push(req); return true; }),
  };
}
function fakeReader(cloids: string[], total?: number) {
  return {
    openOrders: jest.fn(async () => ({
      byCloid: new Map(cloids.map((c) => [c, { oid: 1, coin: "BTC", side: "buy" as const, px: 100 }])),
      total: total ?? cloids.length,
    })),
  };
}
```

- [ ] **Step 2: 更新 3 处 drain 断言（:605/622/645）为合并形状 + 加合并断言**

- 第 605 行 `expect(exec.cancels.map((c) => c.cloid).sort()).toEqual(["0xB0", "0xS2"]);` 改为：
```ts
    expect(exec.cancels).toHaveLength(1); // both rungs coalesced into one cancelCloids call
    expect(exec.cancels[0].cloids.sort()).toEqual(["0xB0", "0xS2"]);
```
- 第 622 行 `expect(exec.cancels.map((c) => c.cloid)).toEqual(["0xB0"]);` 改为：
```ts
    expect(exec.cancels.flatMap((c: any) => c.cloids)).toEqual(["0xB0"]);
```
- 第 645 行 `expect(exec.cancels.map((c) => c.cloid)).toContain(orphan);` 改为：
```ts
    expect(exec.cancels.flatMap((c: any) => c.cloids)).toContain(orphan);
```

- [ ] **Step 3: 加合并 + cap 两个新测试（scheduler.test.ts，追加到 `describe("gridLimit tick (draining)")` 之后或文件末尾）**

需要 `glParams`（文件已用于其它 gridLimit 测试）、`MemoryStrategyStore`、`cloidForKey`（已 import）。cap 测试构造一个 running gridLimit，`total ≥ maxOpenOrders`，断言 entry 不下：
```ts
describe("gridLimit tick (open-order cap)", () => {
  it("skips new entry placements when the owner is at the open-order cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    // No open cloids for this owner, but total open orders (incl. manual) is already at the cap.
    await tick(store, {} as any, { maxNotionalUsdc: 1e9, maxOpenOrders: 5 }, false, 0, undefined, marks, exec as any, fakeReader([], 5) as any);
    const entries = exec.calls.filter((c: any) => !c.reduceOnly);
    expect(entries).toHaveLength(0); // entries blocked at cap
  });
  it("places entries when below the open-order cap", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams);
    const exec = fakeExec();
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9, maxOpenOrders: 100 }, false, 0, undefined, marks, exec as any, fakeReader([], 0) as any);
    const entries = exec.calls.filter((c: any) => !c.reduceOnly);
    expect(entries.length).toBeGreaterThan(0); // entries flow below cap
  });
});
```

> 说明：cap 只闸 entry（reduceOnly=false 的 placeBuy/placeShortEntry）。测试用 `exec.calls.filter(c => !c.reduceOnly)` 精确断言 **entry** 的有无，不依赖是否也发生 reduce-only 退出放置，更稳健。`glParams` 是既有 gridLimit 测试用的参数（longOnly 网格，现有 running 测试 :471 证明会 placeLimit 若干次 buy entry）。若 fresh 网格在 mark=150 下不产生任何 entry，改 `resolveMark` 或 glParams 使至少一个 rung 的 buy entry 落在触发区间。

- [ ] **Step 4: 运行确认 FAIL**

Run: `cd server && npx jest scheduler`
Expected: FAIL（scheduler 仍调用 `cancelCloid`/`openCloids`，且无 cap → 编译或断言失败）。

- [ ] **Step 5: 改 scheduler.ts — getOpen 缓存 total + getOpenCount（:249-254）**

替换为：
```ts
    const openByOwner = new Map<string, Map<string, { side: "buy" | "sell"; px: number }>>();
    const openCountByOwner = new Map<string, number>();
    const getOpen = async (owner: string) => {
      let m = openByOwner.get(owner);
      if (!m) {
        const r = await ordersReader.openOrders(owner);
        m = r.byCloid;
        openByOwner.set(owner, m);
        openCountByOwner.set(owner, r.total);
      }
      return m;
    };
    const getOpenCount = async (owner: string) => { await getOpen(owner); return openCountByOwner.get(owner) ?? 0; };
    const overOpenCap = async (owner: string) =>
      limits.maxOpenOrders !== undefined && limits.maxOpenOrders > 0 && (await getOpenCount(owner)) >= limits.maxOpenOrders;
```

- [ ] **Step 6: 改 scheduler.ts — drain 合并（:271-286）**

把 drain 块替换为（收集 cloids，循环后一次 `cancelCloids`）：
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

- [ ] **Step 7: 改 scheduler.ts — entry cap 闸门（placeBuy / placeShortEntry）**

在 `placeBuy`（:308-319）里，把：
```ts
        if (open.has(cloid)) { store.setGridLimitRung(s.id, { rung: i, state: "armed", side: "buy", cloid, px: rungBuyPrice(p, i), seq }); return; }
        if (!withinCaps({ notionalUsdc: p.perLevelUsdc, killSwitch, coin: p.coin }, limits).ok) return;
```
改为（在 withinCaps 前插入 cap 检查）：
```ts
        if (open.has(cloid)) { store.setGridLimitRung(s.id, { rung: i, state: "armed", side: "buy", cloid, px: rungBuyPrice(p, i), seq }); return; }
        if (await overOpenCap(s.owner)) return;
        if (!withinCaps({ notionalUsdc: p.perLevelUsdc, killSwitch, coin: p.coin }, limits).ok) return;
```
在 `placeShortEntry`（:320-330）里，把：
```ts
        if (open.has(cloid)) { store.setGridLimitRung(s.id, { rung: i, state: "armed", side: "sell", cloid, px: rungSellPrice(p, i), seq }); return; }
        if (!withinCaps({ notionalUsdc: p.perLevelUsdc, killSwitch, coin: p.coin }, limits).ok) return;
```
改为：
```ts
        if (open.has(cloid)) { store.setGridLimitRung(s.id, { rung: i, state: "armed", side: "sell", cloid, px: rungSellPrice(p, i), seq }); return; }
        if (await overOpenCap(s.owner)) return;
        if (!withinCaps({ notionalUsdc: p.perLevelUsdc, killSwitch, coin: p.coin }, limits).ok) return;
```
`placeSell`（:297-307）与 `placeTpBuy`（:331-338）**不动**（reduce-only 退出不受 cap）。

- [ ] **Step 8: 改 `index.ts` — MAX_OPEN_ORDERS env**

在 `index.ts` 第 59 行 `dailyMaxNotionalUsdc` 定义之后加：
```ts
  const maxOpenOrders = process.env.MAX_OPEN_ORDERS ? Number(process.env.MAX_OPEN_ORDERS) : undefined;
```
把传给 `tick` 的 limits（index.ts:92）：
```ts
      { maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc },
```
改为：
```ts
      { maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc, maxOpenOrders },
```

- [ ] **Step 9: 运行确认 PASS + 全量门禁**

Run: `cd server && npx jest scheduler restingExecutor openOrdersReader && npm run typecheck && npm test`
Expected: scheduler 合并/cap 新测试 + 更新的 drain 断言全绿；`npm run typecheck` 无错（scheduler 已改用 cancelCloids/openOrders）；`npm test` 全套件绿。

- [ ] **Step 10: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts server/src/index.ts
git commit --no-verify -m "feat(server): coalesce drain cancels + per-owner open-order cap (M10-agentic)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd server && npm run typecheck && npm test
```

既有测试基线保持绿；新增覆盖：cancelCloids 批量/分块/幂等、openOrders total、drain 合并（1 次批量）、entry cap（至上限不下、下方正常、reduce-only 不受限）。
