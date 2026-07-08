# M10-agentic：撤单合并 + 挂单上限设计（server/ TS）

日期：2026-07-08
状态：已批准

## 背景

`server/` 的 gridLimit 策略在 scheduler tick 中维护一梯 resting 限价单。两处对 HL 配额/限频不友好：

1. **撤单逐发**：drain 路径（paused/canceling/kill）对每个 rung 的 open cloid 单独调用 `restingExec.cancelCloid`（scheduler.ts:280），每次是一次独立的 `cancelByCloid` 签名动作 + 网络往返 + 限频权重。一个 R 段网格产生 R 次撤单调用。
2. **无挂单上限**：ALO entry 放置（placeBuy/placeShortEntry）前不检查该 owner 当前挂单总数，`levels` 校验仅 `>= 2`（无上界），多策略/大网格可能把账户推向 HL 的每地址挂单硬上限。

本切片补齐两项 fail-closed 保护：**撤单合并**（批量 `cancelByCloid`）与**挂单上限**（entry 前的 per-owner 软闸）。`scheduleCancel 计数`按决策推迟到 scheduleCancel 心跳实际落地时再做（当前 server/ 无任何 scheduleCancel 调用点，提前建计数器属 dead code）。

## 目标

- `cancelByCloid` 合并：一个 draining 策略每 tick 的所有 rung 撤单合并为一次（超 `maxCancelBatch` 时分块），R 次 → 1 次（或 ⌈R/maxBatch⌉ 次）。
- 挂单上限：`RiskLimits.maxOpenOrders`（undefined/≤0 = 禁用）；running gridLimit 在 **entry**（reduceOnly=false）放置前，若 owner 当前挂单总数 ≥ cap 则跳过放置。**reduce-only 退出单不受限**（绝不阻塞降风险平仓/止盈）。

**非目标（YAGNI）**：不做 scheduleCancel 计数（无调用点）；不做跨策略/跨 owner 的撤单合并（只 per-strategy，改动最小、拿主要收益）；server/ 无 Prometheus 层，本切片不加指标（与既有 `withinCaps` 静默 return 一致）。

## 架构

### 1. `restingExecutor.ts`：`cancelCloids` 批量撤单（替换 `cancelCloid`）

`RestingExecutor` 接口把单发 `cancelCloid` 替换为批量：
```ts
export interface RestingExecutor {
  placeLimit(req: PlaceLimitRequest): Promise<PlaceLimitResult>;
  cancelCloids(req: { owner: string; coin: string; cloids: string[] }): Promise<boolean>;
}
```
`RestingExecutorDeps` 增加可选 `maxCancelBatch?: number`（默认 100）。`cancelCloids`：
- `cloids` 为空 → 返回 true，不发请求。
- 无 client → 返回 false。
- 否则解析 `coin`→assetIndex **一次**；按 `maxCancelBatch` 把 `cloids` 分块，每块发一次 `client.cancelByCloid({ cancels: chunk.map(c => ({ asset: assetIndex, cloid: c })) })`；每块 `shadowVerify?.("cancelByCloid", { cancels })` fire-and-forget；每块 try/catch 吞掉错误（已成交/已撤 = 幂等）。全部完成后返回 true。

`cancelCloid`（单发）从接口与实现中移除；唯一调用方是 scheduler drain，改用 `cancelCloids`。

### 2. `openOrdersReader.ts`：`openOrders` 暴露总挂单数（替换 `openCloids`）

```ts
export interface OpenOrdersReader {
  openOrders(owner: string): Promise<{ byCloid: Map<string, OpenOrderInfo>; total: number }>;
}
```
`total` = `frontendOpenOrders` 返回数组的**全量长度**（含无 cloid 的手动单）= HL 每地址挂单配额的真实度量。`byCloid` 仍只含 cloid 标记单（沿用原过滤逻辑）。非数组 → `{ byCloid: 空, total: 0 }`。`openCloids` 从接口移除；唯一调用方是 scheduler，改用 `openOrders`。

### 3. `risk/guards.ts`：`RiskLimits.maxOpenOrders`

```ts
export interface RiskLimits {
  maxNotionalUsdc: number;
  perCoinMaxNotionalUsdc?: Record<string, number>;
  dailyMaxNotionalUsdc?: number;
  maxOpenOrders?: number; // per-owner open-order ceiling for NEW entries; undefined/<=0 = disabled
}
```
`withinCaps` **不**读取该字段（保持纯 per-order notional 语义）；挂单上限由 scheduler 用 owner 当前总挂单数强制。

### 4. `scheduler.ts`：装配合并 + cap

gridLimit reconcile 块（`if (restingExec && ordersReader && marks)`）内：

**(a) getOpen 缓存 total + getOpenCount**
```ts
const openByOwner = new Map<string, Map<string, { side: "buy" | "sell"; px: number }>>();
const openCountByOwner = new Map<string, number>();
const getOpen = async (owner: string) => {
  let m = openByOwner.get(owner);
  if (!m) {
    const r = await ordersReader.openOrders(owner);
    m = r.byCloid; openByOwner.set(owner, m); openCountByOwner.set(owner, r.total);
  }
  return m;
};
const getOpenCount = async (owner: string) => { await getOpen(owner); return openCountByOwner.get(owner) ?? 0; };
```
`getOpen` 仍返回 byCloid Map，故所有 `open.has(...)` 调用不变；`total` 顺带缓存，`getOpenCount` 复用同一次抓取（无额外网络调用）。

**(b) drain 合并**：drain 块保留每 rung 的 `rungResting`/`anyResting`/idle-clearing（仍按 `open.has(c)`），把逐 rung 的 `await restingExec.cancelCloid(...)` 改为**收集 cloids**，rung 循环后若非空一次 `await restingExec.cancelCloids({ owner: s.owner, coin: p.coin, cloids })`。`store.remove`（canceling && !anyResting）逻辑不变。语义完全保留（撤单一贯是 best-effort，rung 清理只看 open 状态）。

**(c) entry cap**：在 reconcile 块内定义
```ts
const overOpenCap = async (owner: string) =>
  limits.maxOpenOrders !== undefined && limits.maxOpenOrders > 0 &&
  (await getOpenCount(owner)) >= limits.maxOpenOrders;
```
在 `placeBuy` 与 `placeShortEntry`（entry，reduceOnly=false）中，紧接 crash-orphan 采纳（`open.has(cloid)` 早返回）之后、现有 `withinCaps` 之前插入：`if (await overOpenCap(s.owner)) return;`。`placeSell`/`placeTpBuy`（reduceOnly=true 退出单）**不加**该闸。

### 5. `index.ts`：`MAX_OPEN_ORDERS` env
```ts
const maxOpenOrders = process.env.MAX_OPEN_ORDERS ? Number(process.env.MAX_OPEN_ORDERS) : undefined;
```
并入传给 `tick` 的 limits：`{ maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc, maxOpenOrders }`。

## 关键取舍

- **撤单合并只覆盖 drain**：drain 是唯一的 cancel 点（running 路径只 place/侦测成交，不撤单），per-strategy 合并改动最小、拿下主要收益（大网格 R→1）；跨策略/跨 owner 合并留作后续。
- **分块**：`levels` 无上界 → 单次批量可能很大，`maxCancelBatch`（默认 100）分块避免超大单请求；每块 best-effort 独立吞错。
- **cap 只闸 entry、用 total**：用含手动单的总挂单数防把账户推过 HL 硬上限；只闸 entry 保证 reduce-only 退出永不被阻塞；软闸留硬上限余量。
- **cap 与合并互补**：合并降撤单权重，cap 限挂单增长，二者共同保护 HL 配额。

## 测试

- **`restingExecutor`**（替换 cancelCloid 测试为 cancelCloids）：
  - 多 cloid → 一次 `cancelByCloid`，`cancels` 为对应数组，asset 只解析一次。
  - `maxCancelBatch=2` + 3 个 cloid → 两次 `cancelByCloid`（分块）。
  - 空 cloids → 不发请求、返回 true。
  - 无 client → false。
  - 抛错 → 吞掉、返回 true（幂等）。
  - shadowVerify 收到批量 cancels（fire-and-forget，不影响撤单）。
- **`openOrdersReader`**：`openOrders` 返回 `total` = 全量长度（含 null-cloid 手动单），`byCloid` 只含 cloid 单；非数组 → `{空, 0}`。
- **`scheduler`**（更新 fake：`cancelCloids` 捕获批量、`openOrders` 返回 `{byCloid,total}`，total 可注入）：
  - 合并：draining 策略多 open rung → 恰 **1 次** `cancelCloids`，含全部 rung cloids。
  - cap：`maxOpenOrders` 设定且 `total ≥ cap` → running gridLimit **不下 entry**；reduce-only 退出仍下；`total < cap` → entry 正常下。
- 既有 scheduler drain 测试改为断言合并后的批量形状（证明 coalescing）。

## 门禁

`cd server && npm run typecheck && npm test`（tsc + jest）。

## 任务拆分

3 个 task（restingExecutor 与 openOrdersReader+guards 相互独立；scheduler+index 依赖前两者）：
1. `restingExecutor.ts`：`cancelCloids` 批量 + 分块 + fail-closed（+ 测试，替换 cancelCloid）。
2. `openOrdersReader.ts` `openOrders` total + `risk/guards.ts` `maxOpenOrders` 字段（+ 测试）。
3. `scheduler.ts` drain 合并 + entry cap 装配 + `index.ts` env（+ 更新 fake 与合并/cap 测试）。
