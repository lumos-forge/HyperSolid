# gridLimit 监控再深：逐 rung 明细 + userFills 精确盈亏

- Status: Approved (brainstorm)
- Date: 2026-07-06
- Branch: `feat/grid-limit-monitoring`
- 关联：深化 `docs/superpowers/specs/2026-07-05-grid-limit-resting-design.md`（gridLimit resting 网格）

## 1. 背景与目标

gridLimit 现状：`grid_orders` 逐档存 state/side/cloid/px；GET /strategies 只下发 `armedCount/holdingCount` 摘要（mobile 无逐档数据）；对账用 `r.px`（档位限价）近似记 activity，已实现盈亏 = `(sellPx−buyPx)·size`（忽略手续费）。

本片深化监控两处（server + mobile）：
1. **逐 rung 明细**：新端点 `GET /strategies/:id/rungs` 下发档梯；Agent 行内联展开显示。
2. **精确已实现盈亏**：对账用 `userFills` 的 `closedPnl`（HL 已扣费精确值）+ 真实 fill px/sz，userFills 未传播时回退现近似。

**关键洞察**：resting maker 限价单成交价＝其限价，故 px 近似本已精确；`userFills` 的增值主要在 `closedPnl`（准确盈亏，含手续费）与部分成交的精确 sz。

## 2. 非目标（Out of scope）

- 逐笔 fee/closedPnl 落 activity 流水（需 activity 表加列迁移）——后续。
- 对称 resting 网格——另片。
- 独立策略详情屏/导航（采纳内联展开）。
- 改动 gridLimit 的下单/对账状态机（仅在成交检测处丰富 activity/pnl 数据源）。

## 3. `UserFillsReader`（server，新，`server/src/agent/userFillsReader.ts`）

Info（非签名）读者，镜像 `openOrdersReader`：

```ts
export interface CloidFill { sz: number; px: number; closedPnl: number }
export interface UserFillsInfoLike { userFills(args: { user: string }): Promise<unknown> }
export interface UserFillsReader { fillsByCloid(owner: string): Promise<Map<string, CloidFill>> }
export function makeUserFillsReader(info: UserFillsInfoLike): UserFillsReader
```

`fillsByCloid(owner)`：`userFills({ user: owner })` → 仅取带 `cloid` 的 fill，**按 cloid 聚合**（同一 cloid 的多笔部分成交）：`sz = Σsz`，`closedPnl = Σclosedpnl`，`px = Σ(px·sz)/Σsz`（sz 加权均价）；side/coin 不需要。非数组 → 空 Map。

## 4. 精确盈亏（server，`scheduler.ts`）

`tick()` 新增可选依赖 `userFillsReader?: UserFillsReader`。仅在 gridLimit 分支（已有 `restingExec && ordersReader && marks` 守卫）内使用；`getFills(owner)` **惰性**拉取并按 owner 缓存——**仅在检测到成交时首次调用**（无成交的 tick 不 poll userFills），镜像 `getOpen` 的缓存但按需触发。

在成交检测处（一个 rung 的 `cloid` 从开放订单消失即成交），按 **vanished cloid** 查 fills 丰富记录：

- 令 `f = fills.get(r.cloid)`（可能 undefined，因 userFills 传播滞后）。
- **买成交**：`activity.record({ ..., side:"buy", sz: f?.sz ?? rungSizeCoin(p,i), px: f?.px ?? r.px })`（买单 closedPnl≈0，不入 filled）。
- **卖成交**：`activity.record({ ..., side:"sell", sz: f?.sz ?? rungSizeCoin(p,i), px: f?.px ?? r.px })`；`store.addFilledUsdc(s.id, f ? f.closedPnl : Math.max(0, (rungSellPrice(p,i)-rungBuyPrice(p,i))*rungSizeCoin(p,i)))`。

即 userFills 命中 → 用精确 sz/px + `closedPnl`；未命中 → 回退现近似。其余对账逻辑（挂单/adopt/排空）不变。

`index.ts`：`const userFillsReader = makeUserFillsReader(info as ...);` 传入 `tick(...)`（在 `ordersReader` 之后）。

## 5. 档梯端点（server，`app.ts`）

新 `GET /strategies/:id/rungs`（owner 鉴权，复用 `ownerOf` + `ownedStrategy`）：

```ts
RungDto = { rung: number; state: "idle" | "armed" | "holding"; buyPrice: number; sellPrice: number }
```

handler：取 owned strategy `s`；若 `s.kind !== "gridLimit"` → `[]`；否则用 `GridLimitParams` 算 `rungCount`＋`rungBuyPrice(i)`/`rungSellPrice(i)`，join `store.gridLimitRungs(id)` 的 state（缺省 idle），返回 `[{ rung: i, state, buyPrice, sellPrice }]`（i 升序）。复用 `server/src/strategies/gridLimit.ts` 纯函数（`rungCount`/`rungBuyPrice`/`rungSellPrice`）。

## 6. Mobile 内联档梯

- `mobile/src/services/strategyApi.ts`：新类型 `Rung { rung: number; state: "idle"|"armed"|"holding"; buyPrice: number; sellPrice: number }`；`getRungs(id): Promise<Rung[]>` → `GET /strategies/${id}/rungs`。
- `AgentScreen.tsx` `StrategyRow`：gridLimit 行**信息区可点展开**（`expandedId` 状态；`Pressable` 包信息列，Toggle 仍为兄弟节点保留暂停/恢复，镜像 TWAP 行去嵌套）。展开时 `getRungs(id)` 拉取并渲染档梯：
  - 每档一行（`testID="gl-rung-<id>-<i>"`）：`#i · 买 buyPrice / 卖 sellPrice · state`；state 用 tokens 色（armed→brand、holding→up、idle→muted）。
  - 容器 `testID="gl-rungs-<id>"`；空/加载态占位。
  - 精确 pnl 自动体现在现有摘要行（`{filled} pnl`，server 用 closedPnl 累计）与 owner-wide 成交流水。
- 通过 `deps`/注入的 `StrategyApi` 拉 rungs（保持可测；AgentScreen 的 api 已可注入）。
- i18n en+zh：档梯表头/state 标签（`agent.rungState*`）/空态；颜色仅 tokens；无 emoji/硬编码 hex。

## 7. 测试

- **`userFillsReader.test.ts`**：按 cloid 聚合（多部分成交 Σsz/Σpnl/加权 avg px）、丢弃无 cloid、非数组空 Map（fake Info）。
- **scheduler gridLimit tick**：买/卖成交 userFills 命中 → activity 用精确 sz/px、`addFilledUsdc(closedPnl)`；未命中 → 回退近似（现有行为不变）。
- **HTTP app.test**：`GET /strategies/:id/rungs` 返回 gridLimit 档梯（state join + buy/sell 价）、owner 鉴权、非 gridLimit → `[]`。
- **mobile**：`getRungs` API；StrategyRow 展开拉取并渲染档梯（注入 fake api 返回 rungs），点行显示 `gl-rungs-<id>` + 档行。

## 8. 验证闸门（Gates）

- server：`cd server && npx tsc --noEmit && npx jest`（≥ 207 基线 + 新增）。
- mobile：`cd mobile && npx tsc --noEmit && npx jest`（≥ 789 + 新增）+ `npx jest noHardcodedColors` + `npx jest messages`。
- backend(Go)：不涉及。

## 9. 兼容性

- `userFillsReader` 为 tick 可选依赖：未注入时对账走现近似（现有 scheduler 测试不受影响）。
- 档梯端点纯新增；现有端点/DTO 不变。
- 精确盈亏对已有 gridLimit 行为唯一影响：`filledTotalUsdc` 由近似改为 closedPnl（命中时），activity px/sz 由近似改为真实（命中时）——更准确，无破坏。
