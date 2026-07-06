# gridLimit：真·resting 限价网格（长-only）

- Status: Approved (brainstorm)
- Date: 2026-07-05
- Branch: `feat/grid-limit-resting`
- 关联：延后自 `docs/superpowers/specs/2026-07-03-grid-symmetric-design.md`（§2 明确 resting 网格为独立大项目）

## 1. 背景与目标

现有 `grid` 策略是**标记价穿越 + 激进 IoC** 引擎（`makeHlPlacer` 只发 IoC，未成交即失败）。本片新增**真·resting 限价网格**——在网格线上挂 **ALO(post-only)** 限价单、轮询开放订单对账成交、成交后回挂反向单，构成一个**长-only、库存受限**的经典现货式网格。

作为**新策略 kind `gridLimit`**，与 mark-crossing `grid` 引擎**完全隔离**。server + mobile 一体交付。

底层原语已具备：agent 签名 `ExchangeClient`（`order`/`cancelByCloid`）、共享 `InfoClient`（`frontendOpenOrders` 返回带 `cloid` 的开放订单）。本片新建其上的**挂单生命周期/对账子系统**。

## 2. 非目标（Out of scope）

- 对称多空 resting（本片长-only；对称可作后续 toggle）。
- 逐 rung 明细监控视图（v1 mobile 只展示摘要行）。
- userFills 精确成交价（成交价用档位限价近似；后续可选配）。
- 现有 `grid`/其它 kind 行为不变。

## 3. 模型

`server/src/strategies/types.ts`：
- `StrategyKind` 增 `"gridLimit"`。
- `StrategyStatus` 增 `"canceling"`（DELETE gridLimit 后的排空态，撤净 resting 单后由 tick 移除）。
- `GridLimitParams { coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number }`（levels≥2；语义同 GridParams）。
- `Strategy` 判别联合加 `{ kind: "gridLimit"; params: GridLimitParams }`。

网格线 `line[i] = lowerPrice + i·step`，`step = (upperPrice - lowerPrice)/(levels-1)`，i∈[0, levels-1]。

**Rung（档梯）** i∈[0, levels-2]：一对"买@line[i] / reduce-only 卖@line[i+1]"，共 `levels-1` 个。每 rung 是状态机，任意时刻**至多一个** resting 单：

| state | 含义 | resting 单 |
|---|---|---|
| `idle` | 无单（line[i] ≥ mark，或已完成待重挂） | 无 |
| `armed` | 已在 line[i] 挂 resting **买**单 | 买 @ line[i]（ALO，非 reduce） |
| `holding` | 买单已成交，持 `perLevelUsdc/line[i]` 仓，在 line[i+1] 挂止盈 | reduce-only **卖** @ line[i+1]（ALO） |

循环：`idle/armed →(买成交)→ holding →(卖成交)→ armed(若 line[i]<mark)/idle`。

- 最大暴露 =(levels-1)·perLevelUsdc，天然有界。
- 卖单 reduce-only，**永不净空**。

## 4. 执行层（新，`server/src/agent/`）

### 4.1 `RestingExecutor`（agent 签名）

扩展 `ExchangeLike` 加 `cancelByCloid(params): Promise<unknown>`。新 `makeRestingExecutor(deps)` 返回：

- `placeLimit(req: { owner, coin, price, sizeCoin, side, reduceOnly, cloid }): Promise<PlaceLimitResult>`
  - 发 ALO 单：`{ a: assetIndex, b: side==="buy", p: formatPrice(price, szDecimals), s: roundSize(sizeCoin, szDecimals), r: reduceOnly, t: { limit: { tif: "Alo" } }, c: cloid }`，`grouping:"na"`。
  - 结果：`{ ok:true, oid }`（resting）/ `{ ok:true, filledSz, avgPx }`（极少：立即成交）/ `{ ok:false, rejected:true }`（ALO 穿盘拒单，status.error 含 "post only"）/ `{ ok:false }`（无 client/异常）。
  - 失败/拒单 → 对账不推进该 rung，下 tick 重试。
- `cancelCloid(req: { owner, coin, cloid }): Promise<boolean>`：`cancelByCloid({ cancels:[{ asset: assetIndex, cloid }] })`；成功或"已不存在"皆视为 true（幂等吞错）。

`clientFor`/`resolveAsset` 复用现有 `PlacerDeps` 风格依赖注入。

### 4.2 `OpenOrdersReader`（Info，非签名）

`makeOpenOrdersReader(info)` 返回 `openCloids(owner): Promise<Map<string, { oid: number; coin: string; side: "buy"|"sell"; px: number }>>`——`frontendOpenOrders({ user: owner })`，按 `cloid`（非 null）建 Map，side 由 B/A 映射。

## 5. 纯逻辑（`server/src/strategies/gridLimit.ts`，好测）

- `gridLimitLines(p): number[]`、`rungCount(p) = p.levels - 1`。
- `rungBuyPrice(p, i) = line[i]`、`rungSellPrice(p, i) = line[i+1]`。
- `rungSizeCoin(p, i, mark) = perLevelUsdc / line[i]`（买入以 line[i] 计价的币量；用于挂单尺寸）。
- `desiredRung(rung, p, i, mark): { action: "none" | "placeBuy" | "placeSell" | "toHolding" | "toArmed" }`——纯函数给出目标态转移意图；实际下单/撤单在 scheduler。
- 关键判定：`armable(i, p, mark) = rungBuyPrice(p,i) < mark`。

## 6. 对账 tick（`scheduler.ts` 新分支）

`tick()` 新增可选依赖 `restingExec?: RestingExecutor`、`ordersReader?: OpenOrdersReader`。仅当两者存在时处理 gridLimit：

对每个 `kind==="gridLimit"` 策略：
1. `status === "running"` 且非 kill：
   - `mark = marks.resolveMark(coin)`；无效则跳过。
   - `open = ordersReader.openCloids(owner)`（**每 owner 每 tick poll 一次**，跨该 owner 多策略共享缓存）。
   - 逐 rung（读 `grid_orders` 状态）：
     - **成交检测**：若 rung 状态为 armed/holding 且其持久化 `cloid` **不在 open** → 判成交：
       - armed(买)成交 → 置 holding，`placeLimit` reduce-only 卖 @ line[i+1]（新 seq/cloid）；记 activity（buy, sz, px≈line[i]）。
       - holding(卖)成交 → 记 activity（sell, sz, px≈line[i+1]）+ `filledTotalUsdc += 已实现`；置 armed（若 armable）挂买 @ line[i]，否则 idle。
     - **补挂**：若目标应挂而当前 idle/无 cloid（初次、或上 tick 被拒/失败）：
       - armable 且非 holding → `placeLimit` 买 @ line[i]（**过 caps + 日额度闸门**）；成功置 armed（存 oid/cloid/px/seq）。
       - 非 armable 且非 holding → 保持 idle。
     - ALO `rejected` 或 `ok:false` → 不改状态，下 tick 重试。
2. `status !== "running"`（暂停/删除中）或 killSwitch：**排空**——对每个有 cloid 的 rung `cancelCloid`，撤后置该 rung idle（清 cloid）。语义：
   - `paused`：排空后保持 paused（所有 rung idle）；resume 后下 tick 重新对账挂单。
   - `canceling`（DELETE 触发的新 `StrategyStatus`）：排空后 `remove` 策略（级联删 `grid_orders`）。
   - killSwitch：所有 gridLimit 排空且不挂新（状态不变，恢复后继续）。

**生命周期接线**：HTTP `PATCH` 暂停 → `paused`；`DELETE` gridLimit → 不立即删，置 `canceling`（agent 签名的 executor 只在 scheduler 侧，故撤单在 tick 异步排空后再 remove）。其它 kind 的 DELETE 行为不变（无 resting 单，直接 remove）。

**cloid 方案**：`cloidForKey(strategyId, key)`（对 `cloidFor` 加字符串键变体），key = `gl:${rung}:${seq}`；每次新挂单 seq+1（跨循环唯一、同 seq 崩溃重试幂等）。

## 7. 持久化（新表 `grid_orders`）

`server/src/strategies/sqliteStore.ts` 迁移新增：
```sql
CREATE TABLE IF NOT EXISTS grid_orders (
  strategy_id TEXT NOT NULL,
  rung INTEGER NOT NULL,
  state TEXT NOT NULL,       -- 'idle' | 'armed' | 'holding'
  side TEXT,                 -- 'buy' | 'sell' | null
  cloid TEXT,                -- 当前 resting 单 cloid，idle 为 null
  px REAL,                   -- resting 单价格
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (strategy_id, rung)
);
```
`StrategyStore` 加 gridLimit 相关方法（`MemoryStrategyStore` + `SqliteStrategyStore` 双实现）：
- `gridLimitRungs(id): RungState[]`（读所有 rung；缺省 idle）。
- `setGridLimitRung(id, rung, next: { state, side, cloid, px, seq })`（upsert）。
- `filledTotalUsdc` 复用现有列累加已实现盈亏（近似）。
删除策略时级联删 `grid_orders`。

## 8. HTTP 契约

`validate.ts` 加 `kind==="gridLimit"` 分支：校验 coin/lowerPrice/upperPrice(>lower)/levels(≥2 整数)/perLevelUsdc(>0)，与 grid 一致。`app.ts` POST /strategies 已按 kind 走 validateParams，无需改结构。GET /strategies 序列化 gridLimit 摘要（见 §9）。

## 9. Mobile

`mobile/src/services/strategyApi.ts`：`GridLimitParams` 类型 + `StrategyKind` 加 `"gridLimit"`；Strategy 摘要字段（`filledTotalUsdc`，以及可选 `armedCount`/`holdingCount` 由 server 汇总下发）。
`AgentScreen.tsx`：`gridLimit` 模板（coin/lower/upper/levels/perLevel 表单，镜像 grid，testID `new-grid-limit` 等）；`onCreateGridLimit` → `ctrl.createGridLimit`；StrategyRow 渲染 gridLimit 摘要行。
`useStrategyController.ts`：`createGridLimit`。
i18n en+zh（模板名、字段、摘要、进度）；颜色仅 tokens；无 emoji/硬编码 hex。

server 汇总 `armedCount`/`holdingCount`：GET /strategies 对 gridLimit 从 `grid_orders` 统计并下发（app.ts 序列化处）。

## 10. 风控

- 买单（开多）过 `withinCaps`（per-order + per-coin notional）+ 日额度闸门；被拦则该 rung 本 tick 不挂，下 tick 重试。
- 卖单 reduce-only，不占额度、不开新敞口。
- killSwitch 全局排空 + 停挂。
- ALO 保证纯 maker；最大暴露 =(levels-1)·perLevelUsdc 有界。
- **日额度语义**：`dailyMaxNotionalUsdc` 基于**已成交**活动累计（`notionalSince`）。gridLimit 的 resting **挂单**（arming）不计入成交，故初次铺满网格不受日额度限制——初始铺单的敞口上界由**网格几何**（(levels-1)·perLevelUsdc）+ per-order/per-coin caps 决定；随成交累积，日额度会逐步节流后续 re-arm。这是刻意设计（网格本应铺满其区间），非缺陷。若需按承诺 resting 敞口设日限，应另设 per-strategy resting 名义上限。
- **`canceling` 生命周期**：DELETE gridLimit 置 `canceling`（异步排空后由 tick 移除）；PATCH 对 `canceling` 策略返回 409（不可复活）；mobile 对 `canceling` 行只显示状态标签、不显示开关。

## 11. 边界与健壮性

- **部分成交**：resting 单部分成交时仍在 open（剩余量）→ 未判成交，直到完全成交才转移。安全（不产生半仓错配）。
- **交易所侧撤单**（罕见，如保证金）：openOrders-diff 会误判"成交"→ 挂 reduce-only 卖；因 reduce-only 无仓则被 HL 拒（不会开空），rung 卡住待下 tick 重试。可接受（reduce-only 兜底）。
- **崩溃恢复**：rung 状态持久化 + 同 seq cloid 幂等；重启后从 `grid_orders` 续跑对账。
- **每 owner 每 tick 单次 poll**：多 gridLimit 同 owner 共享一次 `openCloids`。

## 12. 测试

- **`gridLimit.test.ts`**：lines/rungCount/rungBuy/SellPrice/rungSizeCoin/armable/desiredRung。
- **`restingExecutor.test.ts`**：ALO 下单 tuple、resting(oid)/立即成交/ALO 拒单/无 client；cancelCloid 幂等（fake ExchangeLike）。
- **`openOrdersReader.test.ts`**：cloid Map 构建、B/A 映射、null cloid 丢弃（fake Info）。
- **scheduler gridLimit tick**：初始 armable 挂买；买成交→挂 reduce-only 卖@i+1；卖成交→重挂买/idle；非 armable 保持 idle；ALO 拒单不推进+重试；caps 闸门拦买；stop/kill 排空撤单。
- **store**：grid_orders upsert/读取/级联删；seq 递增。
- **validate.test**：gridLimit 合法/非法。
- **HTTP app.test**：POST gridLimit 创建 + GET 摘要序列化。
- **mobile**：gridLimit 模板渲染+提交（createStrategy("gridLimit", ...)）、StrategyRow 摘要、i18n parity。

## 13. 验证闸门（Gates）

- server：`cd server && npx tsc --noEmit && npx jest`（≥ 169 基线 + 新增）。
- mobile：`cd mobile && npx tsc --noEmit && npx jest`（≥ 785 + 新增）+ `npx jest noHardcodedColors` + `npx jest messages`。
- backend(Go)：不涉及。

## 14. 兼容性

- 纯新增 kind；现有 grid/dca/twap/tpsl 与 schema 不受影响（`grid_orders` 为独立新表）。
- `tick()` 新依赖 `restingExec`/`ordersReader` 可选：未注入时 gridLimit 分支不执行（现有测试不受影响）；`index.ts` 注入真实实现。
