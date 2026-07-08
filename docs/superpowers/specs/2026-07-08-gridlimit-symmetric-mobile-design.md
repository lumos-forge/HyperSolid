# gridLimit 对称双边（mobile 模板）— 子项目 2b

日期：2026-07-08
状态：已批准，待实现

## 背景

子项目 2a（PR #36，已合并）在 server 端为 `gridLimit`（限价挂单网格）新增了
`mode: "longOnly" | "symmetric"` 契约：`symmetric` 时在中枢价上方铺设做空梯级，
与下方做多梯级镜像。默认 `longOnly` 行为逐字节不变。

本子项目 2b 是 mobile 端的对应部分：让 AgentScreen 的 gridLimit 模板暴露该
`mode`，并透传到 server。它**完全镜像**早先已上线的 grid 对称模式开关
（`grid` 模板已有 `mode` 分段控件），不引入新概念或新组件。

## 目标

- gridLimit 创建表单新增「模式」分段控件：仅多头（longOnly）/ 多空双向（symmetric）。
- 默认 `longOnly`，透传 `mode` 给 `createGridLimit` → server。
- 默认行为与现状一致（longOnly 时 payload 语义不变，仅显式带上 `mode: "longOnly"`）。

## 非目标（YAGNI）

- 运行中策略卡片**不显示**模式（严格对齐 grid，已与用户确认）。
- 不加说明/提示文案（grid 也没有）。
- 不做移动端专属的 mode 额外校验（mode 来自二选一分段控件，天然受限）。
- 不改 server / Go。

## 架构与改动

纯粹镜像 `grid` 模板的 `gridMode` 开关，作用到 `gridLimit` 模板。

1. **`mobile/src/services/strategyApi.ts`**
   `GridLimitParams` 增加 `mode?: "longOnly" | "symmetric"`（与 `GridParams` 完全一致）。

2. **`mobile/src/screens/AgentScreen.tsx`**
   - 新增 state：`const [glMode, setGlMode] = useState<"longOnly" | "symmetric">("longOnly")`。
   - 在 gridLimit 模板的 perLevel 字段与创建按钮之间插入模式分段控件，
     镜像 grid 的结构（`styles.sideRow` / `styles.sideBtns` / `styles.sideBtn`），
     testID 为 `grid-limit-mode-longOnly` / `grid-limit-mode-symmetric`，
     文案复用 `agent.gridMode` / `agent.gridModeLongOnly` / `agent.gridModeSymmetric`。
   - `onCreateGridLimit` 在 payload 中加入 `mode: glMode`。
   - 与 grid 一致：创建后不重置 `glMode`（仅重置输入字段）。

3. **i18n（`mobile/src/i18n/messages.ts`）**
   无需新增 key。复用已存在的 `agent.gridMode`、`agent.gridModeLongOnly`、
   `agent.gridModeSymmetric`（en+zh 均已存在），messages 对等测试保持通过。

## 数据流

用户在 gridLimit 模板选择模式 → `glMode` state → `onCreateGridLimit`
组装 `{ coin, lowerPrice, upperPrice, levels, perLevelUsdc, mode: glMode }`
→ `ctrl.createGridLimit(params)` → `StrategyApi.createStrategy("gridLimit", params)`
→ server（2a 已实现 `mode` 校验与对称 reconcile）。

## 错误处理

不变。现有内联校验（lower>0、upper>lower、levels 整数≥2、perLevel>0）保持不变；
mode 无非法态（二选一），无需新增校验或错误分支。

## 测试

`mobile/src/screens/AgentScreen.test.tsx`：
- 更新既有「切换到限价网格模板并创建」用例：断言 payload 含 `mode: "longOnly"`
  （镜像 grid 默认用例在 2a 前的同类更新）。
- 新增用例「选择 symmetric 后创建对称限价网格」：按下 `grid-limit-mode-symmetric`
  后创建，断言 payload 含 `mode: "symmetric"`（镜像 grid 的对称测试）。

## 验收门

`cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors && npx jest messages`
（i18n 无新增 key，messages 应保持通过；无硬编码色值）。
