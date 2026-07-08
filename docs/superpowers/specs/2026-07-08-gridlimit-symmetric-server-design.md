# gridLimit 对称双边（sub-project 2a · server）设计

> 子项目 2 的 server 部分。给 resting limit 网格 `gridLimit` 加 `symmetric` 双边模式：在 mark 上方挂 maker 卖开空、下方 reduce-only TP 买；默认 `longOnly` 向后兼容。mobile 模板开关（2b）后做。

## 背景与目标

`gridLimit` 是 resting-order（ALO）网格，per-rung 状态机：`idle → armed(maker 买 @line[i]) → holding(reduce-only TP 卖 @line[i+1]) → idle`，只做多（买在 mark 下方开多、卖是 reduce-only 止盈）。`grid.ts` 已有 `symmetric`（但那是 market-order 净仓调平，机制不同，不可直接镜像）。

本切片给 `gridLimit` 加 `symmetric`：每个 rung 按其相对 mark 的位置取一个方向——
- **长 rung**（rung 中点 < mark）：maker 买 @line[i] 开多 → 成交 → reduce-only TP 卖 @line[i+1]。（现状）
- **短 rung**（rung 中点 ≥ mark）：maker 卖 @line[i+1] 开空（reduceOnly=false）→ 成交 → reduce-only TP 买 @line[i]。

## 范围（2a）

- `types.ts`：`GridLimitParams` 加 `mode?: "longOnly" | "symmetric"`。
- `validate.ts`：gridLimit 校验 mode（镜像 grid）。
- `gridLimit.ts`：短仓方向/挂单纯 helper。
- `scheduler.ts`：gridLimit reconcile 扩展短 rung 全周期。
- server 单测（gridLimit + scheduler）。

**非目标（2b）**：mobile 模板 mode 开关、strategyApi、mobile validate、i18n。

## 设计决策

- **方向分区**：`rungCenter(i) = (line[i]+line[i+1])/2`；`rungIsShort(i, mark) = rungCenter(i) >= mark`。mark 下方全长、上方全空、中枢 rung 按中点定——干净分区、每个入场都是 maker、无重叠、无空洞。
- **方向由 `(state, side)` 推导**（不改 `RungState` schema / sqlite 表）：armed+buy=长入场、armed+sell=短入场、holding+sell=长 TP、holding+buy=短 TP。in-cycle rung 方向稳定（不随 mark 移动重判）；idle rung 每拍据 center vs mark 重取。
- **只 gate 开仓**：开仓单（长的买 / 短的卖）过 `withinCaps` + 每日额度；TP（reduce-only）不过。
- **净敞口天然有界**：rung 数 × perLevelUsdc（长在下、空在上），不新增敞口参数（同 grid-symmetric 结论）。
- **向后兼容**：默认 `longOnly`，`mode` 缺省时逻辑与今日逐字节一致。

## 组件

### 1. `types.ts`

```ts
export interface GridLimitParams {
  coin: string;
  lowerPrice: number;
  upperPrice: number;
  levels: number;
  perLevelUsdc: number;
  /** longOnly (default): resting long grid. symmetric: two-sided long/short resting grid. */
  mode?: "longOnly" | "symmetric";
}
```

### 2. `validate.ts`（gridLimit 块，镜像 grid 块）

在既有 gridLimit 校验末尾加：
```ts
const mode = g.mode ?? "longOnly";
if (mode !== "longOnly" && mode !== "symmetric") return { ok: false, error: "mode must be longOnly or symmetric" };
return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc, mode } };
```

### 3. `gridLimit.ts` 新增纯 helper

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

### 4. `scheduler.ts` gridLimit reconcile 扩展

在既有 gridLimit 分支内：

**新增两个 place 函数**（与 placeBuy/placeSell 并列）：
```ts
// short entry: maker SELL to open (NOT reduce-only) — gated by caps like placeBuy.
const placeShortEntry = async (i, prev) => {
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
// short TP: reduce-only BUY to close (no caps).
const placeTpBuy = async (i, prev) => {
  const seq = prev.seq + 1;
  const cloid = cloidForKey(s.id, `gl:${i}:${seq}`);
  if (open.has(cloid)) { store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "buy", cloid, px: rungBuyPrice(p, i), seq }); return; }
  const res = await restingExec.placeLimit({ owner: s.owner, coin: p.coin, price: rungBuyPrice(p, i), sizeCoin: rungShortSizeCoin(p, i), side: "buy", reduceOnly: true, cloid });
  if (res.ok && "oid" in res) store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "buy", cloid, px: rungBuyPrice(p, i), seq });
  else store.setGridLimitRung(s.id, { rung: i, state: "holding", side: "buy", cloid: null, px: rungBuyPrice(p, i), seq: prev.seq });
};
```

**reconcile 循环改为方向感知**（`mode = p.mode ?? "longOnly"`）：
- **成交检测**（armed/holding 的 cloid 消失）：
  - `armed` 消失 = 入场成交 → `entrySide = r.side`（buy=长/sell=短）；记 activity(side=entrySide, sz, px)；`entrySide === "buy"` → `placeSell`（长 TP）否则 `placeTpBuy`（短 TP）。
  - `holding` 消失 = TP 成交 → 记 activity(side=r.side)；`addFilledUsdc(closedPnl)`（fallback 近似 `(rungSellPrice - rungBuyPrice) * size` 长短同量级）；复位 idle。
- **holding 重试**：`if (!r.cloid) await (r.side === "buy" ? placeTpBuy : placeSell)(i, r)`。
- **idle 起手**：`if (mode === "symmetric" && rungIsShort(p, i, mark)) { if (armableShort(p, i, mark)) await placeShortEntry(i, r); } else { if (armable(p, i, mark)) await placeBuy(i, r); }`。

成交检测里 `px` 的 fallback 用 `r.px`（placeShortEntry 存 rungSellPrice、placeTpBuy 存 rungBuyPrice），对长短均正确。**drain**（暂停/取消/kill 撤所有挂单）方向无关，不变。

## 测试

- `gridLimit.test.ts`：`rungCenter`（中点）、`rungIsShort`（center≥mark）、`armableShort`（sell 线 > mark）、`rungShortSizeCoin`（perLevelUsdc/sell 线）。
- `scheduler.test.ts`：
  - symmetric 短 rung 全周期：idle→开空卖(armed,side sell)→成交→TP 买(holding,side buy)→成交→idle，`addFilledUsdc` 记账；
  - caps gate 开空（withinCaps 拒 → 不挂）；每日额度 gate 开空；
  - 长短按 mark 分区：mark 下方 rung 走长（买）、上方走短（卖）、中枢按 center；
  - drain 撤短单；
  - `longOnly`（默认/显式）行为不变（回归）；
  - 边界：mark 恰在某中枢线。

## 验证门

- `cd server && npm run typecheck` 零错。
- `cd server && npm test`（≥ 基线 225）全绿。
- `git diff --stat main...HEAD` 仅改 `server/src/strategies/{types.ts,validate.ts,gridLimit.ts}`、`server/src/engine/scheduler.ts` + 对应 `.test.ts` + 本 spec/plan。不动 mobile、Go 后端。

## 备注

- 方向稳定性：in-cycle rung 方向锁定（由 side 推导），mark 移动只影响 idle rung 的新方向，故 TP 侧不会因 mark 抖动而错挂。
- reduce-only TP 买在短仓部分成交时被 HL 夹到实际空仓量（同长边 TP 卖的夹取），安全。
- 2b（mobile）将据本 `mode` 契约加模板开关；server 契约（validate 接受 mode、默认 longOnly）即 2b 的依赖。
