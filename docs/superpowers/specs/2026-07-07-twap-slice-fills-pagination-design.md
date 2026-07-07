# TWAP slice fills 时间窗分页设计

> 独立子项目 1（mobile）。给 TWAP slice fills 加时间窗分页，取全长跑 TWAP 的历史成交（当前单次 `userTwapSliceFills` 受 HL 条数上限所限会丢旧 fills）。

## 背景与目标

`mobile/src/services/twapData.ts` 的 `TwapService.loadSliceFills(address)` 只调用一次 `info.userTwapSliceFills(address)`，HL 对该端点有条数上限，长时间运行、成交很多的 TWAP 会丢失较旧的 slice fills（PositionsScreen 展示不全）。

HL 提供 `userTwapSliceFillsByTime(user, startTime, endTime?, aggregateByTime?)`（`@nktkas/hyperliquid` 已含，响应与 `userTwapSliceFills` 同形 `{twapId, fill}[]`）。本子项目用它按**时间窗向前分页**，取全某地址在窗口内的全部 slice fills，再按 twapId 分组。镜像 `mobile/src/services/fillsData.ts` 的 `userFillsByTime` 用法与 mobile 既有约定。

## 范围

- `lib/hyperliquid/twap.ts`：`TwapInfoLike` 加 `userTwapSliceFillsByTime`。
- `lib/hyperliquid/client.ts`：`createTwapInfoClient` 包装该方法。
- `services/twapData.ts`：`TwapService.loadSliceFillsByTime(address, startMs, endMs?)` 分页循环（核心，可单测）；保留现有 `loadSliceFills`。
- `screens/PositionsScreen.tsx`：初始 slice-fills 加载改用分页变体，窗口由已加载 TWAP 推导。

**非目标**：不改 live 订阅路径（`subscribeSliceFills` 照旧）、不改 UI 布局/样式、大概率不动 i18n 文案。

## 组件

### 1. `TwapInfoLike`（`lib/hyperliquid/twap.ts`）

```ts
export interface TwapInfoLike {
  twapHistory(address: string): Promise<unknown>;
  userTwapSliceFills(address: string): Promise<unknown>;
  userTwapSliceFillsByTime(address: string, startTime: number, endTime: number): Promise<unknown>;
}
```

### 2. `client.ts` `createTwapInfoClient`

原始 client 内联类型加 `userTwapSliceFillsByTime(args: { user: string; startTime: number; endTime: number }): Promise<unknown>;`，包装：
```ts
userTwapSliceFillsByTime: (address, startTime, endTime) =>
  info.userTwapSliceFillsByTime({ user: address, startTime, endTime }) as never,
```

### 3. `TwapService.loadSliceFillsByTime`（分页核心）

```ts
/** HL caps *ByTime pages; we page forward until an empty page (cap-independent). */
const SLICE_FILLS_MAX_PAGES = 25;

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

**不变量**：
- **空页即止**——不猜 HL 每页上限，避免猜错导致漏取或死循环。
- **cursor = maxTime + 1**——跨过本页最新 fill，页间几乎无重叠；残余重叠由 `groupSliceFillsByTwapId`（按 `tid` 去重）消化。
- **`maxTime + 1 <= cursor` 防御**——极端「一页全同 ms」时不推进则退出（TWAP 分片间隔为秒级，实际不触发）。
- **`SLICE_FILLS_MAX_PAGES` 上界**——防跑飞。

保留现有 `loadSliceFills(address)`（单次近期取，供快速路径/兼容）。

### 4. `PositionsScreen.tsx` 接线

初始加载把 `services.twap.loadSliceFills(addr)` 换成 `services.twap.loadSliceFillsByTime(addr, startMs)`：`startMs` 由**当前已加载的 active + history TWAP** 的最早 `startedAt`（两者都含该字段，ms）取 min 再减一个小缓冲；无 TWAP 时回退 `Date.now() - 7*24*3600*1000`。live 订阅合并新 fill 的逻辑不变。

> 时序：PositionsScreen 已先 `loadActiveAndHistory`（拿到 active+history），据此算 `startMs` 再 `loadSliceFillsByTime`。

## 测试

- `services/twapData.test.ts`（fake `TwapInfoLike` 返回可编排的多页）：
  - 两页（第一页满、第二页含剩余、第三页空）→ 断言取全、按 tid 去重、cursor 前进；
  - 单页（首页后空页）→ 取全；
  - 空窗口（首页即空）→ 空 Map；
  - 跨 twapId → 正确分组、每组按 time 倒序；
  - `MAX_PAGES` 上界：持续满页时调用次数不超过上界；
  - 「一页全同 ms」→ 不死循环（防御分支）。
- `lib/hyperliquid/twap.test.ts` 已覆盖 `normalizeSliceFills`/`groupSliceFillsByTwapId`，无需重复。

## 验证门

- `cd mobile && npx tsc --noEmit` 零错。
- `cd mobile && npx jest`（≥ 现基线，728+）。
- `cd mobile && npx jest noHardcodedColors`（本片不引入硬编码色）。
- 若动了 i18n：`npx jest messages`（预计不动文案，故不涉及）。

## 备注

- 镜像既有约定：`TwapInfoLike` 注入式（测试用 fake，不触网）、`normalizeSliceFills`/`groupSliceFillsByTwapId` 复用、client 层薄包装（同 `userFillsByTime`）。
- `endMs` 默认 `Date.now()`；窗口用 ms epoch，与 `Fill.time`/`startedAt` 一致。
- 不改服务端、不改 Go 后端；纯 mobile 数据层 + 一处 screen 接线。
