# gridLimit 对称双边（sub-project 2a · server）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `gridLimit` 加 `mode: "longOnly" | "symmetric"`：symmetric 下每个 rung 按 `rungCenter` vs mark 取方向——长 rung 挂 maker 买开多 + reduce-only TP 卖；短 rung 挂 maker 卖开空 + reduce-only TP 买。默认 longOnly 向后兼容。

**Architecture:** `gridLimit.ts` 加短仓纯 helper（rungCenter/rungIsShort/armableShort/rungShortSizeCoin）；`scheduler.ts` gridLimit reconcile 增两个 place 函数（placeShortEntry 过 caps、placeTpBuy reduce-only）并把 arming/成交检测/holding 重试改为方向感知（方向由 `(state, side)` 推导，不改 schema）。只 gate 开仓；净敞口由几何有界。

**Tech Stack:** TypeScript（Node/Fastify strategy 引擎）；jest（ts-jest）；`server/` 现有 `MemoryStrategyStore`、`tick(...)` 调度、`fakeExec/fakeReader/fakeFills` 测试夹具。

---

## File Structure

- `server/src/strategies/types.ts` — `GridLimitParams` 加 `mode`。（Task 1）
- `server/src/strategies/validate.ts` — gridLimit 校验 mode。（Task 1）
- `server/src/strategies/gridLimit.ts` — 短仓 helper。（Task 1）
- `server/src/strategies/gridLimit.test.ts` — helper 单测。（Task 1）
- `server/src/strategies/validate.test.ts` — mode 校验。（Task 1）
- `server/src/engine/scheduler.ts` — 对称 reconcile。（Task 2）
- `server/src/engine/scheduler.test.ts` — 对称调度测试。（Task 2）

> 约定：`GridParams` 已有同款 `mode`（grid 对称），逐一镜像。params 以 JSON blob 持久化，`mode` 无需改 sqlite schema。`glParams`（测试）：lines 100,120,140,160,180,200；rungs 0..4（buy@line[i]/sell@line[i+1]，center=中点）。提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: `mode` 参数 + 短仓 helper

**Files:**
- Modify: `server/src/strategies/types.ts`
- Modify: `server/src/strategies/validate.ts`
- Modify: `server/src/strategies/gridLimit.ts`
- Test: `server/src/strategies/gridLimit.test.ts`, `server/src/strategies/validate.test.ts`

- [ ] **Step 1: 写失败测试**

在 `server/src/strategies/gridLimit.test.ts` 顶部 import 加入新 helper：把
```ts
import { gridLimitStep, gridLimitLine, rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable } from "./gridLimit";
```
改为
```ts
import { gridLimitStep, gridLimitLine, rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable, rungCenter, rungIsShort, armableShort, rungShortSizeCoin } from "./gridLimit";
```
并在文件末尾追加：
```ts
describe("grid-limit symmetric geometry", () => {
  it("computes rung center as the midpoint of its buy/sell lines", () => {
    expect(rungCenter(P, 2)).toBe(150); // (140+160)/2
    expect(rungCenter(P, 0)).toBe(110); // (100+120)/2
  });
  it("marks a rung short when its center is at/above the mark", () => {
    expect(rungIsShort(P, 2, 150)).toBe(true);  // center 150 >= 150
    expect(rungIsShort(P, 1, 150)).toBe(false); // center 130 < 150
    expect(rungIsShort(P, 3, 150)).toBe(true);  // center 170 >= 150
  });
  it("arms a maker sell only when the sell line is strictly above the mark", () => {
    expect(armableShort(P, 2, 150)).toBe(true);  // sell 160 > 150
    expect(armableShort(P, 2, 160)).toBe(false); // sell 160 not > 160
  });
  it("sizes a short rung in coin = perLevelUsdc / sellPrice", () => {
    expect(rungShortSizeCoin(P, 2)).toBeCloseTo(50 / 160, 9); // sell line[3]=160
  });
});
```

在 `server/src/strategies/validate.test.ts` 追加 gridLimit mode 用例（该文件 `import { validateParams } from "./validate";`）：
```ts
describe("validateParams gridLimit mode", () => {
  const base = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
  it("defaults mode to longOnly when omitted", () => {
    const r = validateParams("gridLimit", base);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as any).mode).toBe("longOnly");
  });
  it("accepts symmetric", () => {
    const r = validateParams("gridLimit", { ...base, mode: "symmetric" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as any).mode).toBe("symmetric");
  });
  it("rejects an unknown mode", () => {
    const r = validateParams("gridLimit", { ...base, mode: "wat" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd server && npx jest gridLimit validate 2>&1 | tail -20`
Expected: FAIL —— `rungCenter`/`rungIsShort`/`armableShort`/`rungShortSizeCoin` 未导出；gridLimit mode 未落 params。

- [ ] **Step 3: 实现 types + validate + helpers**

(a) `server/src/strategies/types.ts`，`GridLimitParams` 末尾加（`}` 前）：
```ts
  /** longOnly (default): resting long grid. symmetric: two-sided long/short resting grid. */
  mode?: "longOnly" | "symmetric";
```

(b) `server/src/strategies/validate.ts` 的 gridLimit 块（`if (kind === "gridLimit") { ... }`），把最后的 return 前两行替换。找到：
```ts
    if (!positiveNumber(g.perLevelUsdc)) return { ok: false, error: "perLevelUsdc must be > 0" };
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc } };
```
替换为：
```ts
    if (!positiveNumber(g.perLevelUsdc)) return { ok: false, error: "perLevelUsdc must be > 0" };
    const mode = g.mode ?? "longOnly";
    if (mode !== "longOnly" && mode !== "symmetric") return { ok: false, error: "mode must be longOnly or symmetric" };
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc, mode } };
```

(c) `server/src/strategies/gridLimit.ts` 末尾追加：
```ts
/** Rung geometric center = midpoint of its buy/sell lines. */
export function rungCenter(p: GridLimitParams, i: number): number {
  return (rungBuyPrice(p, i) + rungSellPrice(p, i)) / 2;
}

/** In symmetric mode a rung whose center is at/above the mark runs SHORT (sell to open above, TP buy below). */
export function rungIsShort(p: GridLimitParams, i: number, mark: number): boolean {
  return rungCenter(p, i) >= mark;
}

/** A rung can rest a maker SELL-to-open only when its sell line is strictly above the mark. */
export function armableShort(p: GridLimitParams, i: number, mark: number): boolean {
  return rungSellPrice(p, i) > mark;
}

/** Coin size for a short rung `i` = perLevelUsdc valued at the sell (entry) line. */
export function rungShortSizeCoin(p: GridLimitParams, i: number): number {
  const px = rungSellPrice(p, i);
  return px > 0 ? p.perLevelUsdc / px : 0;
}
```

- [ ] **Step 4: 运行验证通过 + typecheck**

Run: `cd server && npx jest gridLimit validate 2>&1 | tail -15`
Expected: PASS（新 helper 单测 + mode 校验 + 既有 gridLimit/validate 用例全过）。
Run: `cd server && npm run typecheck`
Expected: 零错。

- [ ] **Step 5: 提交**

```bash
git add server/src/strategies/types.ts server/src/strategies/validate.ts server/src/strategies/gridLimit.ts server/src/strategies/gridLimit.test.ts server/src/strategies/validate.test.ts
git commit --no-verify -m "feat(server): gridLimit mode param + symmetric geometry helpers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: scheduler 对称 reconcile

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: 写失败测试**

在 `server/src/engine/scheduler.test.ts` 末尾追加（复用既有 `fakeExec`/`fakeReader`/`fakeFills`/`glParams`/`cloidForKey`/`MemoryStrategyStore`；symmetric 参数 = `{ ...glParams, mode: "symmetric" }`）：
```ts
describe("gridLimit tick (symmetric)", () => {
  const symParams = { ...glParams, mode: "symmetric" as const };

  it("arms long buys below the mark and short sells above it, partitioned by rung center", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", symParams);
    const exec = fakeExec();
    // mark 150: centers 110,130 (long) -> buy@100,120; centers 150,170,190 (short) -> sell@160,180,200.
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    const buys = exec.calls.filter((c: any) => c.side === "buy").map((c: any) => c.price).sort((a: number, b: number) => a - b);
    const sells = exec.calls.filter((c: any) => c.side === "sell").map((c: any) => c.price).sort((a: number, b: number) => a - b);
    expect(buys).toEqual([100, 120]);
    expect(sells).toEqual([160, 180, 200]);
    // short entries are NOT reduce-only (they open shorts).
    expect(exec.calls.filter((c: any) => c.side === "sell").every((c: any) => c.reduceOnly === false)).toBe(true);
  });

  it("runs a short rung through open -> reduce-only TP buy -> close", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", symParams);
    // rung 3: sell@180 (short entry) resting under cloid 0xSH; it just filled (gone from book).
    store.setGridLimitRung(s.id, { rung: 3, state: "armed", side: "sell", cloid: "0xSH", px: 180, seq: 1 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({ "0xSH": { sz: 50 / 180, px: 180, closedPnl: 0 } });
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any, fills as any);
    // entry fill recorded as a sell; a reduce-only TP BUY placed at the buy line (160).
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", px: 180 }));
    // isolate rung 3's TP: only the short TP is a reduce-only BUY (long entries this tick are reduceOnly:false).
    const tp = exec.calls.find((c: any) => c.side === "buy" && c.reduceOnly === true);
    expect(tp).toMatchObject({ price: 160, reduceOnly: true });
    const r3 = store.gridLimitRungs(s.id).find((r) => r.rung === 3)!;
    expect(r3).toMatchObject({ state: "holding", side: "buy" });

    // Now the TP buy (cloid on r3) fills -> realized pnl booked, rung back to idle.
    const exec2 = fakeExec();
    const fills2 = fakeFills({ [r3.cloid!]: { sz: 50 / 180, px: 160, closedPnl: 6.1 } });
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec2 as any, fakeReader([]) as any, fills2 as any);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", px: 160 }));
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo(6.1, 6);
    expect(store.gridLimitRungs(s.id).find((r) => r.rung === 3)).toMatchObject({ state: "idle", side: null, cloid: null });
  });

  it("gates a short entry behind caps (does not place a sell when over cap)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", symParams);
    const exec = fakeExec();
    // perLevelUsdc 50 > maxNotionalUsdc 10 -> every opening order gated; no sells (and no buys).
    await tick(store, {} as any, { maxNotionalUsdc: 10 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    expect(exec.calls.filter((c: any) => c.side === "sell")).toHaveLength(0);
  });

  it("leaves longOnly behavior unchanged (default mode: buys below mark, no sells)", async () => {
    const store = new MemoryStrategyStore(() => 0);
    store.create("0xo", "gridLimit", glParams); // no mode -> longOnly
    const exec = fakeExec();
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, undefined, { resolveMark: async () => 150, resolvePosition: async () => undefined }, exec as any, fakeReader([]) as any);
    const buys = exec.calls.filter((c: any) => c.side === "buy").map((c: any) => c.price).sort((a: number, b: number) => a - b);
    expect(buys).toEqual([100, 120, 140]); // buy lines strictly below 150
    expect(exec.calls.filter((c: any) => c.side === "sell")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd server && npx jest scheduler -t symmetric 2>&1 | tail -25`
Expected: FAIL —— symmetric 未实现（短 rung 不挂卖 / TP 买 / caps）。

- [ ] **Step 3: 实现 scheduler 对称 reconcile**

在 `server/src/engine/scheduler.ts` gridLimit **running** 分支内：

(a) 在 `const mark = await marks.resolveMark(p.coin);` 那段之后、`const placeSell = ...` 之前，加一行 mode：
```ts
      const mode = p.mode ?? "longOnly";
```

(b) 在 `placeBuy` 定义（以 `};` 结束）之后、`for (let i = 0; ...)` 之前，插入两个新 place 函数：
```ts
      const placeShortEntry = async (i: number, prev: RungState) => {
        const seq = prev.seq + 1;
        const cloid = cloidForKey(s.id, `gl:${i}:${seq}`);
        if (open.has(cloid)) { store.setGridLimitRung(s.id, { rung: i, state: "armed", side: "sell", cloid, px: rungSellPrice(p, i), seq }); return; }
        if (!withinCaps({ notionalUsdc: p.perLevelUsdc, killSwitch, coin: p.coin }, limits).ok) return;
        if (limits.dailyMaxNotionalUsdc !== undefined && activity?.notionalSince) {
          if (activity.notionalSince(s.owner, dayStartUtcMs(now)) + p.perLevelUsdc > limits.dailyMaxNotionalUsdc) return;
        }
        const res = await restingExec.placeLimit({ owner: s.owner, coin: p.coin, price: rungSellPrice(p, i), sizeCoin: rungShortSizeCoin(p, i), side: "sell", reduceOnly: false, cloid });
        if (res.ok && "oid" in res) store.setGridLimitRung(s.id, { rung: i, state: "armed", side: "sell", cloid, px: rungSellPrice(p, i), seq });
      };
      const placeTpBuy = async (i: number, prev: RungState) => {
        const seq = prev.seq + 1;
        const cloid = cloidForKey(s.id, `gl:${i}:${seq}`);
        if (open.has(cloid)) { store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "buy", cloid, px: rungBuyPrice(p, i), seq }); return; }
        const res = await restingExec.placeLimit({ owner: s.owner, coin: p.coin, price: rungBuyPrice(p, i), sizeCoin: rungShortSizeCoin(p, i), side: "buy", reduceOnly: true, cloid });
        if (res.ok && "oid" in res) store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "buy", cloid, px: rungBuyPrice(p, i), seq });
        else store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "buy", cloid: null, px: rungBuyPrice(p, i), seq: prev.seq });
      };
```

(c) 把整个 reconcile for-loop（当前从 `for (let i = 0; i < rungCount(p); i++) {` 到该分支闭合、包含 fill 检测 + holding + arming）替换为方向感知版本：
```ts
      for (let i = 0; i < rungCount(p); i++) {
        let r = rungAt(i);

        // fill detection: a tracked resting order that vanished from open orders filled.
        if ((r.state === "armed" || r.state === "holding") && r.cloid && !open.has(r.cloid)) {
          const fill = userFillsReader ? (await getFills(s.owner)).get(r.cloid) : undefined;
          const sz = fill?.sz ?? rungSizeCoin(p, i);
          const px = fill?.px ?? r.px ?? rungBuyPrice(p, i);
          if (r.state === "armed") {
            // entry filled. direction from side: buy = long entry (TP sell), sell = short entry (TP buy).
            const entrySide = r.side ?? "buy";
            if (activity) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: entrySide, sz, px });
            if (entrySide === "buy") await placeSell(i, r);
            else await placeTpBuy(i, r);
            continue;
          }
          // holding filled = TP closed. direction from side: sell = long TP, buy = short TP.
          const tpSide = r.side ?? "sell";
          if (activity) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: tpSide, sz, px });
          store.addFilledUsdc(s.id, fill ? fill.closedPnl : Math.max(0, (rungSellPrice(p, i) - rungBuyPrice(p, i)) * rungSizeCoin(p, i)));
          store.setGridLimitRung(s.id, { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq });
          r = { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq };
        }

        if (r.state === "holding") {
          if (!r.cloid) await (r.side === "buy" ? placeTpBuy : placeSell)(i, r); // retry a failed TP placement
          continue;
        }
        if (r.state === "armed" && r.cloid && open.has(r.cloid)) continue; // already resting
        // idle -> pick direction and arm.
        if (mode === "symmetric" && rungIsShort(p, i, mark)) {
          if (armableShort(p, i, mark)) await placeShortEntry(i, r);
        } else {
          if (armable(p, i, mark)) await placeBuy(i, r);
        }
      }
```

(d) 在文件顶部 `import { rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable, type RungState } from "../strategies/gridLimit";` 补入新 helper：
```ts
import { rungCount, rungBuyPrice, rungSellPrice, rungSizeCoin, armable, rungIsShort, armableShort, rungShortSizeCoin, type RungState } from "../strategies/gridLimit";
```

- [ ] **Step 4: 运行验证通过 + 全量 + typecheck**

Run: `cd server && npx jest scheduler 2>&1 | tail -20`
Expected: PASS —— 新 symmetric 4 用例 + 既有 gridLimit/grid/其它 scheduler 用例全过（longOnly 回归不变）。
Run: `cd server && npm run typecheck && npm test 2>&1 | tail -8`
Expected: 零错；全量 ≥ 基线 225 全绿。

- [ ] **Step 5: 提交**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(server): symmetric two-sided gridLimit reconcile (short rungs)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd server && npm run typecheck` 零错。
- `cd server && npm test`（≥ 基线 225）全绿。
- `git diff --stat main...HEAD` 仅改 `server/src/strategies/{types.ts,validate.ts,gridLimit.ts,gridLimit.test.ts,validate.test.ts}`、`server/src/engine/scheduler.{ts,test.ts}` + 两份 docs。不动 mobile、Go 后端。

## 备注

- 方向由 `(state, side)` 推导：armed+buy=长入场、armed+sell=短入场、holding+sell=长 TP、holding+buy=短 TP——无需改 `RungState`/sqlite 表。
- 只 gate 开仓（长买/短卖）；TP reduce-only 不 gate；净敞口由 rung 数 × perLevelUsdc 几何有界。
- 默认/显式 `longOnly` 逻辑不变（symmetric 分支只在 `mode === "symmetric"` 生效）。
- 2b（mobile 模板开关）据本 `mode` 契约后做。
