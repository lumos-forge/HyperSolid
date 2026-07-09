# 死手开关失败告警设计（server/ TS）

日期：2026-07-09
状态：已批准

## 背景

PR #52 落地了 scheduleCancel 死手开关（心跳 + ≤10/日预算）。终审留了一个 Low Note：`deadManExecutor.arm` 持续返回 false（agent 撤销/过期 → 无 client；或 HL 持续拒绝），或 budget 耗尽（`decide` 返回 `skip`）时，某 owner 的死手开关**静默失效**——无任何运维信号。对一个 fail-closed 安全机制，「坏了却无从得知」比没有更危险（虚假的安全感）。

本 slice 补齐**过渡式（transition-only）失败告警**：仅在「进入告警」与「恢复」两个跳变点各发一次信号，稳态零日志噪声（避免评审指出的 per-tick 刷屏）。server/ 目前无 Prometheus 层，故用注入的 logger（`console.error`）作为信号载体。

## 目标

- 新增 `DeadManHealth` 追踪器：按 owner 记录连续「未布防」次数，跨过阈值时发一次 `alert`、恢复时发一次 `recovered`。
- 心跳集成：把 `budget skip` 与 `arm 失败`一并视为「本 tick 未受保护 = failure」，成功 arm/refresh 视为健康；跳变时经注入回调发信号。
- `index.ts` 装配：`makeDeadManHealth()` 建一次（跨 tick 持久），`onHealthEvent` 用 `console.error` 输出。

**非目标（YAGNI）**：不接 env 阈值（常量 3）；不做指标/告警外发（server/ 无指标层，log-based 即可）；不改 budget/executor 逻辑；不做 clear-on-shutdown 或逐 owner opt-in（另属后续）。

## 架构

### 1. `server/src/engine/deadMan.ts` 新增 `DeadManHealth`

```ts
/** Consecutive unprotected heartbeats before raising an alert (~alertAfter × tick of no protection). */
export const DEADMAN_ALERT_AFTER = 3;

export type DeadManHealthEvent =
  | { kind: "none" }
  | { kind: "alert"; consecutiveFailures: number }
  | { kind: "recovered" };

export interface DeadManHealth {
  /** Record one heartbeat outcome for owner (armed = did we successfully arm/refresh this tick).
   *  Returns a transition event to surface, or { kind: "none" } in steady state. */
  record(owner: string, armed: boolean): DeadManHealthEvent;
}

export function makeDeadManHealth(alertAfter?: number): DeadManHealth;
```
内部每 owner 状态 `{ failures: number; alerting: boolean }`（内存 Map）。`alertAfter` 默认 `DEADMAN_ALERT_AFTER`（3）。`record`：
- `armed === true`：若 `alerting` → 复位 `{ failures: 0, alerting: false }`，返回 `{ kind: "recovered" }`；否则复位 `failures=0`（alerting 已 false），返回 `{ kind: "none" }`。
- `armed === false`：`failures += 1`；若 `!alerting && failures >= alertAfter` → 置 `alerting = true`，返回 `{ kind: "alert", consecutiveFailures: failures }`；否则返回 `{ kind: "none" }`（已在告警态则保持沉默，不重复告警）。

语义：只在**进入告警**（首次跨过阈值）与**恢复**（告警态下首次成功）两个跳变发事件；稳态健康或稳态告警都返回 `none`。

### 2. 心跳集成（`deadManHeartbeat`）

`DeadManHeartbeatDeps` 追加两个**可选**字段（保持对现有调用/测试的后向兼容）：
```ts
export interface DeadManHeartbeatDeps {
  activeOwners(): string[];
  budget: DeadManBudget;
  executor: DeadManExecutor;
  now(): number;
  ttlMs: number;
  health?: DeadManHealth;                                   // optional health tracker
  onHealthEvent?: (owner: string, event: DeadManHealthEvent) => void; // transition sink (e.g. logger)
}
```
循环体改为：
```ts
  for (const owner of new Set(deps.activeOwners())) {
    const d = deps.budget.decide(owner, now, deps.ttlMs);
    let armed = false;
    if (!d.skip) {
      armed = await deps.executor.arm(owner, d.time);
      if (armed) deps.budget.record(owner, now, d.time, d.counts);
    }
    const ev = deps.health?.record(owner, armed);
    if (ev && ev.kind !== "none") deps.onHealthEvent?.(owner, ev);
  }
```
要点：
- **`skip` 与 `arm 失败`统一记为 `armed=false`（未受保护）**——从安全视角，无论「预算耗尽」还是「布防出错」，该 owner 本 tick 都没被保护，同属不健康；闭合两类静默缺口。
- `health` 未注入时行为与原来完全一致（纯附加层）。
- 布防成功仍照旧 `budget.record`；health 独立于 budget 计数。

### 3. `index.ts` 装配

在现有 dead-man 装配处（`makeDeadManBudget()` 附近）追加：
```ts
const deadManHealth = makeDeadManHealth();
```
把心跳调用扩展为携带 health + 日志回调：
```ts
      void deadManHeartbeat({
        activeOwners,
        budget: deadManBudget,
        executor: deadManExecutor,
        now,
        ttlMs: deadManTtlMs as number,
        health: deadManHealth,
        onHealthEvent: (owner, ev) => {
          if (ev.kind === "alert") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
          } else if (ev.kind === "recovered") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm recovered for ${owner}`);
          }
        },
      }).catch((e) => console.error("dead-man heartbeat failed", e));
```

## 关键取舍

- **过渡式告警、零稳态噪声**：只在进入告警/恢复两个跳变发日志，避免持续失败时每 tick 刷屏（评审明确警告的形态）。
- **log-based 信号**：server/ 无 Prometheus 层；`console.error` 与既有约定（`"scheduler tick failed"` 等）一致。指标化留待引入 server 指标层的后续。
- **skip 计入 failure**：budget 耗尽同样意味着未受保护，一并纳入健康信号，闭合同类静默缺口。
- **阈值常量 3**（构造参数默认，非 env）：≈3×tick 无保护才告警，兼顾灵敏与抗抖动；YAGNI 不加 env 面。
- **health/onHealthEvent 可选**：纯附加，现有心跳测试与调用不受影响。

## 测试

- **`makeDeadManHealth`**：
  - 连续未布防到第 `alertAfter` 次才发 `alert`（前几次 `none`），`consecutiveFailures` 正确。
  - 告警态下继续未布防返回 `none`（不重复告警）。
  - 告警态下一次成功返回 `recovered`（一次）；随后稳态成功返回 `none`。
  - 恢复后重新累积可再次 `alert`（计数已复位）。
  - 未到阈值时成功复位计数（如 2 次失败后成功，再失败需重新累积）。
  - 多 owner 独立；`alertAfter` 可配（如 2）。
- **`deadManHeartbeat`**：
  - `arm` 失败 → `health.record(owner,false)`；跳变时 `onHealthEvent` 收到 `alert`。
  - `budget.decide` 返回 `skip` → 不 arm，但仍 `health.record(owner,false)`（skip 计 failure）。
  - `arm` 成功 → `health.record(owner,true)`，budget.record 照旧。
  - 未注入 `health` 时行为不变（不抛错、不调 onHealthEvent）。

## 门禁

`cd server && npm run typecheck && npm test`。

## 任务拆分

2 个 task：
1. `engine/deadMan.ts` `makeDeadManHealth`（record 状态机）+ 测试。
2. `engine/deadMan.ts` 心跳集成（可选 health/onHealthEvent、skip 计 failure）+ `index.ts` 装配（console 日志回调）+ 测试。
