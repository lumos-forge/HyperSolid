# TWAP 再深：历史 + slice 明细 + WS 实时（Positions 内联）

- Status: Approved (brainstorm)
- Date: 2026-07-05
- Branch: `feat/twap-monitoring-deep`
- Extends: PR #9（TWAP monitoring + cancel，`mobile/src/lib/hyperliquid/twap.ts` + `services/twapData.ts` + PositionsScreen 活跃 TWAP 区）

## 1. 背景与目标

PR #9 在 Positions 标签轮询 `twapHistory`，只保留 `status==="activated"` 的原生 HL TWAP，显示进度%/已成交/取消。缺：历史/已完成、slice 成交明细、WS 实时。

本片**深化 TWAP 监控**（纯 mobile，Positions 标签，无 server 改动）：

1. **历史/已完成列表**：展示 `finished|terminated|error` 的 TWAP。
2. **slice 成交明细**：每个 TWAP 的逐 slice 成交（time · px · sz · $ntl），点行就地展开。
3. **WS 实时**：订阅 `userTwapSliceFills`，事件驱动明细追加 + 进度乐观更新 + 去抖重拉 `twapHistory` 对齐权威状态。

## 2. 非目标（Out of scope）

- server 策略引擎 TWAP（`server/src/strategies/twap.ts`）不动——本片只涉及 Trade 侧原生 HL TWAP 的监控。
- 不新增导航屏（内联在 Positions；采纳方案 A）。
- 不做 slice 级手续费/PnL 汇总分析；slice 行只显示 time/px/sz/ntl。
- 不引入通用 WS 重连框架；沿用 SDK `SubscriptionClient` 生命周期（镜像 TradeScreen 的 l2Book/trades 订阅）。

## 3. SDK 依据（`@nktkas/hyperliquid`）

- `info.twapHistory({ user })` → 条目含 `status.status ∈ {finished, activated, terminated, error}` + `state`（coin/side/sz/executedSz/executedNtl/minutes/reduceOnly/timestamp）。
- `info.userTwapSliceFills({ user })` → `{ fill: UserFill, twapId }[]`（一次返回该地址**所有** TWAP 的 slice 成交，各自带 twapId）。
- WS `subscription.userTwapSliceFills({ user }, cb)` → `{ twapSliceFills, isSnapshot }`。

## 4. 数据模型

三份状态（PositionsScreen 持有）：

- `activeTwaps: ActiveTwap[]` —— `status==="activated"`，**现有 `normalizeActiveTwaps` 不动**。
- `historyTwaps: TwapHistoryEntry[]` —— `finished|terminated|error`，新 `normalizeTwapHistory`。
- `sliceFillsByTwapId: Map<number, Fill[]>` —— 来自 `userTwapSliceFills`（Info 快照 + WS 事件合并）。

复用现有 `Fill` 类型（`lib/hyperliquid/types.ts`）与 `normalizeFills`（`lib/hyperliquid/history.ts`）——slice 的 `fill` 即标准 UserFill。

## 5. `lib/hyperliquid/twap.ts`（纯函数，好测）

新增（现有 `ActiveTwap`/`normalizeActiveTwaps`/`twapProgressPct` 保持不动）：

```ts
export type TwapStatus = "finished" | "terminated" | "error";

export interface TwapHistoryEntry {
  twapId: number | null;       // 历史条目可能无 numeric twapId（不可展开明细时为 null）
  coin: string;
  side: "buy" | "sell";
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  reduceOnly: boolean;
  startedAt: number;
  status: TwapStatus;
}

export interface TwapSliceFill {
  twapId: number;
  fill: Fill;                  // 复用现有 Fill（normalizeFills 规整）
}
```

- `normalizeTwapHistory(raw): TwapHistoryEntry[]`：保留 `status.status ∈ {finished,terminated,error}`，映射 `side "A"→sell`，按 `startedAt` 倒序，UI 上限 50。
- `normalizeSliceFills(raw): TwapSliceFill[]`：遍历 `{fill, twapId}[]`，仅保留 `twapId` 为 number 的项，`fill` 逐项规整为 `Fill`。为避免与数组级去重耦合，从现有 `normalizeFills` 抽出**单条** `normalizeFill(rawFill): Fill`（字段映射逻辑），`normalizeFills` 改为 `map(normalizeFill)` + tid 去重；`normalizeSliceFills` 用 `normalizeFill` 保持 twapId 配对。
- `groupSliceFillsByTwapId(list: TwapSliceFill[]): Map<number, Fill[]>`：按 twapId 分组，组内按 `fill.time` 倒序；用 `fill.tid` 去重（跨快照/WS 合并防重复）。

## 6. `services/twapData.ts`（`TwapService` 扩展）

- 构造注入 Info（`TwapInfoLike`）+ Subs（`TwapSubsLike`）；Subs 可选（不传则 `subscribeSliceFills` 抛错/no-op，便于纯 Info 测试）。
- `loadActive(addr)` —— 现有。
- `loadHistory(addr): Promise<TwapHistoryEntry[]>` = `normalizeTwapHistory(await info.twapHistory(addr))`。
- `loadSliceFills(addr): Promise<Map<number, Fill[]>>` = `groupSliceFillsByTwapId(normalizeSliceFills(await info.userTwapSliceFills(addr)))`。
- `subscribeSliceFills(addr, cb: (fills: TwapSliceFill[]) => void): { unsubscribe(): void }` —— WS；把事件里的 `twapSliceFills` 经 `normalizeSliceFills` 后回调。

## 7. `lib/hyperliquid/client.ts` + `types.ts`

- `TwapInfoLike` 加 `userTwapSliceFills(address: string): Promise<unknown>`；`createTwapInfoClient` 补该方法（`info.userTwapSliceFills({ user })`）。
- 新 `TwapSubsLike { userTwapSliceFills(address, listener): { unsubscribe(): void } | Promise<{ unsubscribe(): void }> }`。
- 新 `createTwapSubsClient(network): TwapSubsLike`，镜像 `createDetailSubsClient`（`SubscriptionClient` + `WebSocketTransport`）。

## 8. PositionsScreen UI

- **活跃 TWAP 区**（现有）：行改为可点开（`Pressable`，`expandedTwapId` 状态）；展开渲染该 twapId 的 slice 明细（`sliceFillsByTwapId.get(id)`，每行 time · px · sz · $ntl，倒序）；保留取消按钮。`testID="twap-slices-<id>"`、`twap-row-<id>`。
- **TWAP 历史区**（新）：标题 `t("positions.twapHistoryTitle")`；`TwapHistoryRow`（coin/side/总量/已成交ntl/状态 pill/开始时间；无取消；`twapId!=null` 时同样可点开 slice 明细）；空态 `t("positions.noTwapHistory")`。
- **WS 接线**：`useEffect`（依赖 walletAddress/mode/network）在有效钱包时 `subscribeSliceFills(addr, onSlice)`；`onSlice(fills)`：
  1. 合并进 `sliceFillsByTwapId`（按 twapId 追加 + `fill.tid` 去重 + 组内倒序）。
  2. 对每个 twapId 命中的活跃 TWAP，**乐观** bump `executedSz += fill.sz` / `executedNtl += fill.sz*fill.px`（仅 UI，capped 到 `sz`）。
  3. 触发**去抖(~1500ms 尾触发)** `loadActive`+`loadHistory` 重拉，对齐权威 executedSz 并捕获 finished/terminated。
  卸载/离焦/切钱包时 `unsubscribe` 并清理 debounce timer。镜像 TradeScreen 的 WS 生命周期。
- 初始加载：`runQuery` 追加 `loadHistory` + `loadSliceFills`（快照）。错误经现有 `classifyFetchError` → `twapError` 通道。

## 9. i18n（en + zh 对仗，`messages.test.ts` parity 必过）

新键（示例）：`positions.twapHistoryTitle`、`positions.noTwapHistory`、`positions.twapStatusFinished/Terminated/Error`、`positions.twapSliceHeader`（"time · px · sz · $"）、`positions.twapSlicesEmpty`。颜色仅取 `theme`/tokens；无 emoji、无硬编码 hex。

## 10. 测试

- **`twap.test.ts`**：`normalizeTwapHistory`（状态过滤/倒序/上限/side 映射）、`normalizeSliceFills`（twapId 非 number 丢弃、fill 规整）、`groupSliceFillsByTwapId`（分组/tid 去重/组内倒序）。
- **`twapData.test.ts`**：`loadHistory`/`loadSliceFills`（注入 fake Info）、`subscribeSliceFills`（注入 fake Subs，回调触发 + unsubscribe）。
- **PositionsScreen 测试**：历史行渲染 + 状态 pill；点开活跃/历史行显示 slice 明细；WS 事件（fake Subs）→ 明细追加 + 进度乐观 bump；去抖后触发重拉（fake timers）。

## 11. 验证闸门（Gates）

- `cd mobile && npx tsc --noEmit && npx jest`（≥ 基线 770）+ `npx jest noHardcodedColors` + `npx jest messages`。
- server / backend(Go)：本片不涉及。

## 12. 兼容性

- 活跃 TWAP 区行为向后兼容（新增可展开 + 内联明细，取消不变）。
- WS 不可用（离线/受限）时：订阅失败经 `twapError` 提示，Info 快照 + 手动刷新仍工作（优雅降级）。
