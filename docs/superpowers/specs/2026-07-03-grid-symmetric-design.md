# Grid 增强：对称多/空网格（可选 mode）

- Status: Approved (brainstorm)
- Date: 2026-07-03
- Branch: `feat/grid-symmetric`
- Supersedes/extends: `docs/superpowers/specs/2026-07-02-strategy-grid-design.md`（原库存受限多头网格）

## 1. 背景与目标

已合并的 grid 策略是**库存受限多头网格**（mark-crossing, inventory-bounded LONG）：标记价下穿→买（非 reduce），上穿→reduce-only 卖（有多头库存才卖，否则仅推进档位、不下必败单），永不净空。原 grid spec §9 已将「对称多/空」与「resting 限价网格」列为 v1 拒绝的备选。

本片实现其中的**对称多/空网格**，作为现有网格的一个**可选 `mode`**：

- `mode: "longOnly"` —— 现状，零行为变更（默认）。
- `mode: "symmetric"` —— 多/空双向：价到底部最大做多、到顶部最大做空，中心两侧对称，双向震荡都吃利润。

**真·resting 限价网格不在本片范围**（需新建挂单生命周期/成交轮询子系统，作为独立 track 以后做）。

## 2. 非目标（Out of scope）

- 挂单（GTC resting）/成交轮询/开放订单 diff 等新子系统。
- 独立的 `maxExposure`/`maxPositionUsdc` 参数（净暴露由网格几何天然有界，见 §4）。
- 资金费（funding）预测或对冲逻辑；仅沿用现有 caps + kill-switch。
- 更改 `perLevelUsdc`/`lowerPrice`/`upperPrice`/`levels` 的既有语义。

## 3. 参数与类型

`server/src/strategies/types.ts`：`GridParams` 增字段

```ts
export interface GridParams {
  coin: string;
  lowerPrice: number;
  upperPrice: number;
  levels: number;       // >= 2
  perLevelUsdc: number; // 每穿越一条网格线的名义 USDC
  mode?: "longOnly" | "symmetric"; // 缺省 "longOnly"
}
```

- `mode` 可选，**缺省 `"longOnly"`**：DB 中已有 grid（无该字段）与新建 grid 默认走保守的多头网格，零行为变更。

`validate.ts`（`kind === "grid"` 分支）：

- 若 `mode` 存在，必须 ∈ `{"longOnly","symmetric"}`，否则 `{ ok:false, error:"mode must be longOnly or symmetric" }`。
- 校验通过时 `params` 显式带出 `mode`（缺省归一为 `"longOnly"`），保证下游拿到确定值。

## 4. 引擎行为（`scheduler.ts` grid loop + `grid.ts`）

定义（纯函数，放 `grid.ts`，便于单测）：

- `centerBand = (levels - 1) / 2`（偶数档为半整数，无需取整）。
- `targetNetUsdc(band) = (centerBand - band) * perLevelUsdc`
  - band=0（底部）→ 最大多 `= centerBand * perLevelUsdc`
  - band=levels-1（顶部）→ 最大空 `= -(levels-1-centerBand) * perLevelUsdc`
  - **净暴露由几何天然有界且中心对称**，故无需额外 maxExposure 参数。

### 4.1 symmetric —— 统一"向 target 对账"（seed 与穿越同一逻辑）

symmetric 模式下 seed 与穿越是**同一条规则**：每当 `curBand !== lastLevel`（含首次 `lastLevel === undefined`）时，把净仓**向当前档的 target 对账**——按**真实持仓**定尺寸，从而部分成交/lot 取整会自愈，不会累积漂移或越界。

1. `mark = resolveMark(coin)`，`curBand = bandIndex(...)`；若 `lastLevel === curBand` → `continue`（本档已在跟踪）。
2. `target = targetNetUsdc(curBand)`；读现仓 `szi = resolvePosition(owner, coin) ?? 0`；`actualNetUsdc = szi * mark`。
3. `deltaUsdc = target - actualNetUsdc`；`side = deltaUsdc >= 0 ? "buy" : "sell"`，`sizeUsdc = |deltaUsdc|`。
4. 若 `sizeUsdc < MIN_GRID_NOTIONAL`（=10，HL 永续最小名义）→ `seedGridLevel(curBand)`（仅推进档位，不下单）。
5. 否则过 caps（`withinCaps` + 日额度闸门，两侧都开敞口故都要过），通过则以 `cloid = cloidFor(id, actionsDone)`、**非 reduce-only** 下单；`res.ok` 后 `recordGridAction(curBand, ...)`。
6. 若被 caps 跳过或下单失败 → **不**推进 `lastLevel`，下 tick 重试（cloid 幂等）。

- 净仓以 **USDC 名义**（`szi * mark`）为 target，故价格移动时 USDC 敞口保持有界、中心对称。
- 相比经典"每穿越一线固定 clip"的增量法，对账法在部分成交/多档跳变时**自愈**、不越界，是本方案的核心健壮性来源。

### 4.2 longOnly —— 维持现状（零行为变更）

symmetric 分支提前 `continue`，故 longOnly 路径与合并前**逐字节等价**：

- Seed（`lastLevel === undefined`）：`seedGridLevel(curBand)` 后 `continue`（无下单）。
- 穿越：`gridAction(lastLevel, curBand, perLevelUsdc)` 增量——下穿买（过 caps 闸门、非 reduce）、上穿 **reduce-only 卖**（有多头库存才卖，flat 则 `seedGridLevel(targetLevel)` 推进档位不下单）。

### 4.3 reduce-only 判定汇总

| mode | seed 单 | 买单 | 卖单 |
|---|---|---|---|
| longOnly | 无 | 非 reduce | reduce-only（且 flat 守卫） |
| symmetric | 非 reduce | 非 reduce | 非 reduce |

## 5. 状态与存储

**无新增列**：净仓由交易所持仓隐式承载。重启后从持久化的 `lastLevel` 增量续跑（交易所仍持有已累计仓位）；seed 仅在 `lastLevel === undefined` 时发生一次。`actionsDone` 单调递增维持 cloid 幂等键，语义不变。

## 6. Mobile UI（`AgentScreen.tsx` grid 模板）

- grid 表单（`testID="new-grid"`）加 **mode 选择器**（longOnly / symmetric，默认 longOnly），沿用现有分段 Pressable 风格（与 template 选择一致）；`testID="grid-mode-longOnly"` / `"grid-mode-symmetric"`。
- `onCreateGrid` 组装 params 时带上 `mode`。
- 颜色仅取 `theme`/tokens；无 emoji、无硬编码 hex。
- i18n：新增 `agent.gridMode`、`agent.gridModeLongOnly`、`agent.gridModeSymmetric`（en+zh 对仗，`messages.test.ts` parity 必须过）。

## 7. 测试

- **单元（`grid.test.ts`）**：`targetNetUsdc`（含偶数档半整数 center、端点最大多/空、中心≈0）；`gridAction` 回归不变。
- **validate（`validate.test.ts`）**：mode 合法值通过、非法值报错、缺省归一为 longOnly。
- **scheduler（scheduler 测试）**：
  - symmetric：flat 时上穿卖出**开空**（非 reduce）；随后下穿买入**平空/翻多**；seed-to-target 在非中心档建初始仓且方向/尺寸正确；caps 双侧闸门拦截。
  - longOnly：现有测试（reduce-only 卖、flat 守卫、仅买侧闸门）**全绿不变**。
- **mobile（AgentScreen 测试）**：mode 选择器渲染、切换、提交带 mode。

## 8. 验证闸门（Gates）

- server：`cd server && npx tsc --noEmit && npx jest`（≥ 156 基线）。
- mobile：`cd mobile && npx tsc --noEmit && npx jest`（≥ 基线）+ `npx jest noHardcodedColors` + `npx jest messages` + emoji 扫描。
- backend（Go）：本片不涉及。

## 9. 兼容性

- DB 已有 grid、未带 mode 的新建 grid → `longOnly`，行为与合并前完全一致。
- `symmetric` 为显式 opt-in；文档提示其净空头 + 资金费风险，由 caps/kill-switch 兜底。
