# TWAP slice fills 时间窗分页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 mobile 的 `TwapService` 加时间窗分页 `loadSliceFillsByTime`（经 `userTwapSliceFillsByTime` 向前分页取全 slice fills，空页即止），并把 `PositionsScreen` 初始 slice-fills 加载切到分页变体（窗口由已加载 TWAP 的最早 `startedAt` 推导）。

**Architecture:** `TwapInfoLike` 加 `userTwapSliceFillsByTime`（client 薄包装 `@nktkas` 同名方法）；`TwapService.loadSliceFillsByTime(address, startMs, endMs?)` 循环分页、`normalizeSliceFills` + `groupSliceFillsByTwapId`（按 tid 去重）；`PositionsScreen` 在 `loadActiveAndHistory` 解析后据最早 `startedAt` 算 `startMs` 再调分页。

**Tech Stack:** TypeScript + React Native（Expo）；jest-expo；`@nktkas/hyperliquid`（已含 `userTwapSliceFillsByTime`）；注入式 `TwapInfoLike`（测试用 fake，不触网）。

---

## File Structure

- `mobile/src/lib/hyperliquid/twap.ts` — `TwapInfoLike` 加方法。（Task 1）
- `mobile/src/lib/hyperliquid/client.ts` — `createTwapInfoClient` 包装。（Task 1）
- `mobile/src/services/twapData.ts` — `loadSliceFillsByTime` + `SLICE_FILLS_MAX_PAGES`。（Task 1）
- `mobile/src/services/twapData.test.ts` — 分页单测 + 补既有 6 个 fake。（Task 1）
- `mobile/src/screens/PositionsScreen.tsx` — 接线分页变体。（Task 2）
- `mobile/src/screens/PositionsScreen.test.tsx` — twap mock 补 `loadSliceFillsByTime`。（Task 2）

> 约定：`TwapInfoLike` 注入式；复用 `normalizeSliceFills`/`groupSliceFillsByTwapId`（`twap.ts`）；`Fill` 有 `.time`/`.tid`；`ActiveTwap` 与 `TwapHistoryEntry` 都有 `startedAt: number`（ms）。提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: 数据层 —— `loadSliceFillsByTime` + client 方法

**Files:**
- Modify: `mobile/src/lib/hyperliquid/twap.ts`
- Modify: `mobile/src/lib/hyperliquid/client.ts`
- Modify: `mobile/src/services/twapData.ts`
- Modify: `mobile/src/services/twapData.test.ts`

- [ ] **Step 1: 写失败测试（jest 层 RED）**

在 `mobile/src/services/twapData.test.ts` 末尾追加一个新 describe（fake 的 `userTwapSliceFillsByTime` 编排多页；`f(coin, tid, time, twapId)` 造 raw slice fill）：
```ts
describe("TwapService.loadSliceFillsByTime", () => {
  const raw = (twapId: number, tid: number, time: number) => ({
    twapId,
    fill: { coin: "ETH", px: "3000", sz: "0.5", side: "A", time, startPosition: "0", dir: "Close Long", closedPnl: "1", hash: "0x", oid: 1, crossed: true, fee: "0.1", tid, feeToken: "USDC", twapId },
  });

  it("pages forward until an empty page and groups by twapId, deduped by tid", async () => {
    const page1 = [raw(8, 1, 100), raw(8, 2, 200)];
    const page2 = [raw(8, 2, 200), raw(9, 3, 300)]; // tid 2 overlaps the boundary; must dedupe
    const byTime = jest
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]); // empty → stop
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn(), userTwapSliceFillsByTime: byTime };
    const svc = new TwapService(info);

    const map = await svc.loadSliceFillsByTime("0xabc", 0, 1000);
    // page1: cursor 0 → maxTime 200 → next cursor 201; page2 from 201 → maxTime 300 → 301; page3 empty.
    expect(byTime).toHaveBeenNthCalledWith(1, "0xabc", 0, 1000);
    expect(byTime).toHaveBeenNthCalledWith(2, "0xabc", 201, 1000);
    expect(byTime).toHaveBeenNthCalledWith(3, "0xabc", 301, 1000);
    expect(map.get(8)!.map((f) => f.tid)).toEqual([2, 1]); // newest first, tid 2 once
    expect(map.get(9)!.map((f) => f.tid)).toEqual([3]);
  });

  it("returns an empty map for an empty window", async () => {
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn(), userTwapSliceFillsByTime: jest.fn().mockResolvedValue([]) };
    const map = await new TwapService(info).loadSliceFillsByTime("0xabc", 0, 1000);
    expect(map.size).toBe(0);
  });

  it("stops at SLICE_FILLS_MAX_PAGES when every page is full and advancing", async () => {
    let t = 1;
    const byTime = jest.fn(async () => [raw(8, t, t++ * 1000)]); // always non-empty, always advancing
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn(), userTwapSliceFillsByTime: byTime };
    await new TwapService(info).loadSliceFillsByTime("0xabc", 0);
    expect(byTime.mock.calls.length).toBe(25); // SLICE_FILLS_MAX_PAGES
  });

  it("does not loop forever when a page does not advance the cursor", async () => {
    const byTime = jest.fn(async () => [raw(8, 1, 100)]); // same time forever → cursor can't advance past
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn(), userTwapSliceFillsByTime: byTime };
    const map = await new TwapService(info).loadSliceFillsByTime("0xabc", 500); // startMs 500 > fill time 100
    // cursor stays 500 (maxTime+1 = 101 <= 500) → break after first page.
    expect(byTime.mock.calls.length).toBe(1);
    expect(map.get(8)!.map((f) => f.tid)).toEqual([1]);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd mobile && npx jest twapData -t loadSliceFillsByTime`
Expected: FAIL —— `svc.loadSliceFillsByTime is not a function`（方法未实现；jest 走 babel 不受 tsc 影响）。

- [ ] **Step 3: 实现接口 + client + 方法 + 补既有 fake**

(a) `mobile/src/lib/hyperliquid/twap.ts`，`TwapInfoLike` 加第三个方法：
```ts
export interface TwapInfoLike {
  twapHistory(address: string): Promise<unknown>;
  userTwapSliceFills(address: string): Promise<unknown>;
  userTwapSliceFillsByTime(address: string, startTime: number, endTime: number): Promise<unknown>;
}
```

(b) `mobile/src/lib/hyperliquid/client.ts`，`createTwapInfoClient` 的内联 client 类型加一行、返回对象加包装：
把
```ts
  }) as unknown as {
    twapHistory(args: { user: string }): Promise<unknown>;
    userTwapSliceFills(args: { user: string }): Promise<unknown>;
  };
  return {
    twapHistory: (address) => info.twapHistory({ user: address }) as never,
    userTwapSliceFills: (address) => info.userTwapSliceFills({ user: address }) as never,
  };
```
改为
```ts
  }) as unknown as {
    twapHistory(args: { user: string }): Promise<unknown>;
    userTwapSliceFills(args: { user: string }): Promise<unknown>;
    userTwapSliceFillsByTime(args: { user: string; startTime: number; endTime: number }): Promise<unknown>;
  };
  return {
    twapHistory: (address) => info.twapHistory({ user: address }) as never,
    userTwapSliceFills: (address) => info.userTwapSliceFills({ user: address }) as never,
    userTwapSliceFillsByTime: (address, startTime, endTime) =>
      info.userTwapSliceFillsByTime({ user: address, startTime, endTime }) as never,
  };
```

(c) `mobile/src/services/twapData.ts`，在 `class TwapService` 内（`loadSliceFills` 之后）加方法，并在类上方加常量：
在文件的 import 之后、`export class TwapService` 之前加：
```ts
/** HL caps *ByTime pages; we page forward until an empty page (cap-independent). */
const SLICE_FILLS_MAX_PAGES = 25;
```
在 `loadSliceFills` 方法之后插入：
```ts
  /**
   * All slice fills in [startMs, endMs], paginated via userTwapSliceFillsByTime and
   * grouped by twapId (deduped by tid). Pages forward until an empty page, no cursor
   * progress, or SLICE_FILLS_MAX_PAGES — no dependency on HL's exact per-call cap.
   */
  async loadSliceFillsByTime(address: string, startMs: number, endMs = Date.now()): Promise<Map<number, Fill[]>> {
    const all: TwapSliceFill[] = [];
    let cursor = startMs;
    for (let page = 0; page < SLICE_FILLS_MAX_PAGES; page++) {
      const norm = normalizeSliceFills(await this.info.userTwapSliceFillsByTime(address, cursor, endMs));
      if (norm.length === 0) break;
      all.push(...norm);
      const maxTime = Math.max(...norm.map((f) => f.fill.time));
      if (maxTime + 1 <= cursor) break; // no progress (defensive: a full page all at one ms)
      cursor = maxTime + 1;
    }
    return groupSliceFillsByTwapId(all);
  }
```
（`normalizeSliceFills`/`groupSliceFillsByTwapId`/`TwapSliceFill`/`Fill` 均已在 twapData.ts 顶部 import；无需新增 import。）

(d) `mobile/src/services/twapData.test.ts`：给**每一个**构造 `new TwapService(info)` 的 `info` fake 对象补 `userTwapSliceFillsByTime: jest.fn()`（既有 6 处，用 grep 找全：`grep -n 'userTwapSliceFills: jest.fn' mobile/src/services/twapData.test.ts`——在每个既有 `info = { twapHistory: ..., userTwapSliceFills: ... }` 里追加 `userTwapSliceFillsByTime: jest.fn()`）。这是让 tsc 满足新接口；新 describe 里的 fake 已含该方法。

- [ ] **Step 4: 运行验证通过 + tsc**

Run: `cd mobile && npx jest twapData`
Expected: PASS —— 新 `loadSliceFillsByTime` 4 用例 + 既有 twapData 用例全过。
Run: `cd mobile && npx tsc --noEmit`
Expected: 零错（既有 fake 已补方法，接口满足）。

- [ ] **Step 5: 提交**

```bash
git add mobile/src/lib/hyperliquid/twap.ts mobile/src/lib/hyperliquid/client.ts mobile/src/services/twapData.ts mobile/src/services/twapData.test.ts
git commit --no-verify -m "feat(mobile): TwapService.loadSliceFillsByTime (time-window pagination)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `PositionsScreen` 接线分页变体

**Files:**
- Modify: `mobile/src/screens/PositionsScreen.tsx`
- Modify: `mobile/src/screens/PositionsScreen.test.tsx`

- [ ] **Step 1: 接线 PositionsScreen**

在 `mobile/src/screens/PositionsScreen.tsx` 中，找到 TWAP 加载块：
```ts
      void services.twap
        .loadActiveAndHistory(addr)
        .then(({ active, history }) => { setActiveTwaps(active); setTwapHistory(history); })
        .catch((e) => setTwapError(classifyFetchError(e)));
      void services.twap.loadSliceFills(addr).then(setSliceFills).catch(() => {});
```
替换为（把 slice-fills 加载串到 active/history 解析之后，据最早 `startedAt` 推导窗口；保留原有错误语义：active/history 失败→setTwapError，slice-fills 失败→吞掉）：
```ts
      void services.twap
        .loadActiveAndHistory(addr)
        .then(({ active, history }) => {
          setActiveTwaps(active);
          setTwapHistory(history);
          const starts = [...active, ...history].map((t) => t.startedAt).filter((n) => n > 0);
          const startMs = starts.length ? Math.min(...starts) - 60_000 : Date.now() - 7 * 24 * 3600 * 1000;
          void services.twap.loadSliceFillsByTime(addr, startMs).then(setSliceFills).catch(() => {});
        })
        .catch((e) => setTwapError(classifyFetchError(e)));
```

- [ ] **Step 2: 补 screen-test 的 twap mock**

在 `mobile/src/screens/PositionsScreen.test.tsx` 中，给**每一个** twap mock 对象补 `loadSliceFillsByTime`（因 screen 现调它而非 `loadSliceFills`；mock 用 `as unknown as TwapService` 转型，tsc 不拦，但运行时缺该方法会抛）。用 grep 找全 twap mock：`grep -n 'loadSliceFills\|loadActiveAndHistory' mobile/src/screens/PositionsScreen.test.tsx`。规则：凡是含 `loadSliceFills: jest.fn(async () => X)` 的 twap mock，在其后追加 `loadSliceFillsByTime: jest.fn(async () => X),`（X 用同一返回值——主 mock 用 `sliceFillsByTwapId`，其它用 `new Map()`）。保留既有 `loadSliceFills` 桩（无害）。

- [ ] **Step 3: 修正引用 loadSliceFills 的断言/清理（若有）**

`grep -n 'loadSliceFills\b' mobile/src/screens/PositionsScreen.test.tsx`：若有 `mockClear()`/`toHaveBeenCalled` 断言针对 `loadSliceFills`（screen 已不再调用它），改成 `loadSliceFillsByTime`；仅 `mockClear` 的行可保留或一并改为 `loadSliceFillsByTime`（避免误导）。若无断言（只 mockClear），无需改动断言逻辑，但把该 `mockClear(loadSliceFills)` 一并改为 `loadSliceFillsByTime` 以对齐现实。

- [ ] **Step 4: 全量校验**

Run: `cd mobile && npx tsc --noEmit`
Expected: 零错。
Run: `cd mobile && npx jest`
Expected: PASS —— PositionsScreen 用例（含 slice-fills 展示）全过，套件 ≥ 基线。
Run: `cd mobile && npx jest noHardcodedColors`
Expected: PASS（本片未引入硬编码色）。

- [ ] **Step 5: 提交**

```bash
git add mobile/src/screens/PositionsScreen.tsx mobile/src/screens/PositionsScreen.test.tsx
git commit --no-verify -m "feat(mobile): PositionsScreen loads complete TWAP slice fills via pagination

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd mobile && npx tsc --noEmit` 零错。
- `cd mobile && npx jest`（≥ 基线，728+）全绿。
- `cd mobile && npx jest noHardcodedColors` 通过。
- `git diff --stat main...HEAD` 仅改 `mobile/src/lib/hyperliquid/{twap.ts,client.ts}`、`mobile/src/services/twapData.{ts,test.ts}`、`mobile/src/screens/PositionsScreen.{tsx,test.tsx}` + 两份 docs。不动 server/、Go 后端、i18n。

## 备注

- 空页即止的分页不依赖 HL 具体每页上限；`cursor=maxTime+1` + `groupSliceFillsByTwapId` 按 tid 去重保证页间无重复计数。
- `startMs` 由最早 `startedAt`（active+history）减 60s 缓冲；无 TWAP 时回退 7 天窗口。
- 保留单次 `loadSliceFills`（快速近期取）；本片新增分页变体并让 screen 用之。
