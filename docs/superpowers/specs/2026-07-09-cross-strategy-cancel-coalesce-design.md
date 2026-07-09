# 跨策略撤单合并设计（server/ TS）

日期：2026-07-09
状态：已批准

## 背景

M10-agentic（PR #51）给 gridLimit 的 drain 路径做了 **per-strategy** 撤单合并：一个 draining 策略的所有 rung cloid 合并为一次 `cancelCloids({owner, coin, cloids})`。但一个 owner 若有多个 draining 策略（尤其分布在不同币种），每策略仍单发一次——K 个策略 = K 次 `cancelByCloid` HL 动作。

**关键洞察**：HL `cancelByCloid` 的 `cancels: [{asset, cloid}]` 数组**支持混合 asset**——单次调用可撤多币种。当前 `cancelCloids` 只因签名限定单 coin（一次 `resolveAsset`）才逐策略发。把执行器升级为混合币种，并在 scheduler 里按 owner 跨策略累积，即可把一个 owner 全部 draining 撤单合并为**一次**（超 batch 分块）。

真正的收益在 **cross-coin**：owner 跨币种网格（BTC+ETH+SOL 同时 draining）K→1；同币种多网格罕见，故本切片直指 cross-coin。

## 目标

- `restingExecutor` 用 `cancelMany({owner, cancels: Array<{coin, cloid}>})`（混合币种）**替换** `cancelCloids`（drain 是唯一调用方，避免 dead code）。
- `scheduler` drain 按 owner 跨策略累积 `{coin, cloid}`，`for (const s of all)` 循环后对每 owner 一次 `cancelMany` flush。

**非目标（YAGNI）**：不改 running 放置/cap/fill 逻辑；不改 budget/心跳；不做同币种专用路径（cancelMany 已覆盖单/多币种）。

## 架构

### 1. `restingExecutor.ts`：`cancelCloids` → `cancelMany`

接口（`RestingExecutor`）把
```ts
cancelCloids(req: { owner: string; coin: string; cloids: string[] }): Promise<boolean>;
```
替换为
```ts
cancelMany(req: { owner: string; cancels: Array<{ coin: string; cloid: string }> }): Promise<boolean>;
```
实现（沿用 cancelCloids 的 never-throw / 分块 / shadow 风格）：
- `cancels` 为空 → 返回 true，不发请求。
- 无 client → 返回 false。
- 外层 try/catch（best-effort，绝不 reject 中断 tick）：
  - **去重解析币种**：对每个 distinct coin 调一次 `resolveAsset`，缓存 `Map<coin, assetIndex>`；**单个 coin resolveAsset 抛错只跳过该 coin 的 cancels**（不影响其余币种），用 try/catch 包住每 coin 的解析。
  - 构建混合 `all: Array<{ asset, cloid }>`（只含成功解析币种的 cancels）。
  - 按 `maxCancelBatch`（默认 100）分块；每块 `shadowVerify?.("cancelByCloid", { cancels: chunk })`（try 吞）+ `client.cancelByCloid({ cancels: chunk })`（try 吞，幂等）。
  - 返回 true。

### 2. `scheduler.ts`：per-owner 跨策略累积 + 循环后 flush

gridLimit reconcile 块（`if (restingExec && ordersReader && marks)`）内：
- 顶部加 `const cancelsByOwner = new Map<string, Array<{ coin: string; cloid: string }>>();`。
- drain 路径（`if (killSwitch || s.status !== "running")`）：保留每 rung 的 `rungResting`/`anyResting`/idle-clearing 与 `store.remove(canceling && !anyResting)` **inline**（只看 `open` 状态，与撤单调用无关）；把原先的 `if (toCancel.length > 0) await restingExec.cancelCloids({owner, coin, cloids: toCancel})` 改为**累积**：
```ts
        if (toCancel.length > 0) {
          const acc = cancelsByOwner.get(s.owner) ?? [];
          for (const cloid of toCancel) acc.push({ coin: p.coin, cloid });
          cancelsByOwner.set(s.owner, acc);
        }
```
（去掉 inline 撤单；`continue` 仍在。）
- `for (const s of all)` 循环**结束之后**（gridLimit 块内、块结束前）flush：
```ts
    for (const [owner, cancels] of cancelsByOwner) {
      await restingExec.cancelMany({ owner, cancels });
    }
```

一个 owner 全部 draining 策略（任意币种）的撤单合并为一次 `cancelMany`（超 batch 由执行器分块）。

## 关键取舍

- **cross-coin 才是真收益**：owner 跨币种网格 K→1；同币种多网格罕见，cancelMany 天然也覆盖。
- **语义保留**：撤单一贯 best-effort、result-ignored、下 tick 复核；deferred 到 gridLimit 块末尾无碍——drain 与 running 是不同策略、cloid 隔离，时序不影响正确性；`store.remove` 仍按 `anyResting` inline 判定，时序不变。
- **单 coin 解析失败隔离**：一个坏 coin 不拖垮同 owner 其它币种的撤单（best-effort，下 tick 复核）。
- **替换而非新增**：drain 是 `cancelCloids` 唯一调用方，替换避免 dead code。

## 测试

- **`restingExecutor.cancelMany`**：
  - 混合币种（BTC+ETH）→ 一次 `cancelByCloid`，`cancels` 含各自 asset（BTC→assetIndex_btc、ETH→assetIndex_eth）；每 distinct coin 只 `resolveAsset` 一次。
  - 空 cancels → 不发、返回 true。
  - 无 client → false。
  - 某 coin `resolveAsset` 抛错 → 只丢该 coin 的 cancels，其余照发、返回 true。
  - 分块（maxCancelBatch=2 + 3 cancels → 两次）。
  - shadowVerify 收到批量 cancels；抛错不影响撤单。
- **`scheduler`**（更新 fake：`cancelCloids`→`cancelMany` 捕获 `{owner, cancels}`；drain 断言改 `.cancels.map(c=>c.cloid)`）：
  - **两个 draining 策略同 owner 不同币种（BTC + ETH），各有 open rung → 恰 1 次 `cancelMany`，其 cancels 含两币种的 cloids**（证明 cross-strategy + cross-coin 合并）。
  - 单 draining 策略仍 1 次 cancelMany 含其 cloids。
  - `canceling && !anyResting` 仍 `store.remove`。
  - kill-switch drain 仍合并。

## 门禁

`cd server && npm run typecheck && npm test`。

## 任务拆分

2 个 task（cancelMany 执行器 / scheduler 累积+flush，后者依赖前者）：
1. `agent/restingExecutor.ts`：`cancelMany`（替换 cancelCloids，混合币种 + 去重解析 + 分块 + never-throw）+ 测试。
2. `engine/scheduler.ts`：drain 累积 + 循环后 flush；更新 fake 与 drain/cross-coin 测试。
