# scheduleCancel 死手开关设计（server/ TS）

日期：2026-07-09
状态：已批准

## 背景

HyperSolid 的 agentic 后端替 owner 挂驻留限价单（gridLimit 等）。若后端进程宕机/失联，这些挂单会滞留在 HL 上无人管理。**死手开关（Dead Man's Switch）**用 HL 的 `scheduleCancel` 解决：后端心跳周期性把「到点撤销全部挂单」的时间刷到 `now + TTL`；只要后端存活就不断续期，一旦宕机超过 TTL，HL 自动撤掉该 owner 全部挂单。

HL 语义（已核验，docs/HYPERLIQUID-GAP-ANALYSIS.md A2 + HL 官方文档）：
- `{ type:"scheduleCancel", time }`，`time` ≥ now+5s；到点撤该账户**全部挂单**（**不平仓**）；省略 `time` = 清除。
- **刷新一个仍在未来的已布防调度是免费的；只有从「未布防」状态布防才计入日限**。每日 ≤ **10** 次计数（00:00 UTC 重置）。可由 agent（L1）签名。
- `@nktkas/hyperliquid` ExchangeClient 已内置 `scheduleCancel({ time? })`。

启用范围（用户决策）：**环境开关 + 对有 running 策略的 owner 默认全开**。配了 `DEADMAN_TTL_MS` 即启用；心跳为每个有 running 策略的 owner 刷新 scheduleCancel。本 slice 不做逐 owner/策略 opt-in（留作后续 UX）。

## 目标

- 新增死手执行器：经 agent-signed client 发 `scheduleCancel`。
- 新增 ≤10/日预算（armed-state 状态机）：区分免费刷新与计数布防，超额 fail-closed。
- 新增心跳驱动 + `index.ts` 装配（`DEADMAN_TTL_MS` env，复用现有 tick timer）。

**非目标（YAGNI）**：不做逐 owner/策略 opt-in；不做 clear-on-shutdown（优雅重启会在 TTL 内刷新；宕机超 TTL 撤单是安全默认）；不做诚实揭示 UI（只撤单不平仓的风险揭示是 app/UX 责任，spec §6.1，非 server 代码单元）；不加 server 指标（server/ 无 Prometheus 层）。

## 架构

### 1. `server/src/agent/deadManExecutor.ts` — 死手执行器

```ts
/** Narrow agent-signed client surface for the dead-man switch. */
export interface DeadManClientLike {
  scheduleCancel(params: { time?: number }): Promise<unknown>;
}

export interface DeadManExecutorDeps {
  clientFor(owner: string): DeadManClientLike | undefined;
  /** Optional fire-and-forget shadow verifier; never affects execution. */
  shadowVerify?: (kind: string, params: unknown) => void;
}

export interface DeadManExecutor {
  /** Arm (or refresh) the owner's scheduleCancel to fire at timeMs. Returns false on no client or error. */
  arm(owner: string, timeMs: number): Promise<boolean>;
}

export function makeDeadManExecutor(deps: DeadManExecutorDeps): DeadManExecutor;
```
`arm(owner, timeMs)`：无 client → false（fail-closed）；否则 `shadowVerify?.("scheduleCancel", { time: timeMs })`（try/catch 吞，绝不影响执行），`await client.scheduleCancel({ time: timeMs })`；成功 → true；catch → false（布防失败不记账，心跳下一轮重试）。

### 2. `server/src/engine/deadMan.ts` — 预算（≤10/日 armed-state 状态机）

```ts
export type DeadManDecision = { skip: true } | { skip: false; time: number; counts: boolean };

export interface DeadManBudget {
  /** Decide the action for owner at nowMs: a free refresh, a counting new-arm, or skip when the
   *  daily budget (10) is exhausted and a new arm would be needed. Does NOT mutate state. */
  decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision;
  /** Commit a SUCCESSFUL send: set armedUntil=time; increment the day's counter iff counts. */
  record(owner: string, nowMs: number, time: number, counts: boolean): void;
}

export function makeDeadManBudget(): DeadManBudget;
```
常量 `DEADMAN_MAX_PER_DAY = 10`，`dayMs = 24*60*60*1000`。每 owner 状态 `{ day: number; count: number; armedUntil: number }`（内存 Map）。

`decide(owner, now, ttl)`：
- `time = now + ttl`；`day = Math.floor(now / dayMs)`。
- 读 prev：`count = prev && prev.day === day ? prev.count : 0`（跨日归零）；`armedUntil = prev ? prev.armedUntil : 0`。
- `armedUntil > now`（仍布防、未到点）→ **免费刷新**：`{ skip:false, time, counts:false }`。
- 否则（未布防/已过期/已触发）→ **新布防**：`count >= DEADMAN_MAX_PER_DAY` → `{ skip:true }`（fail-closed）；否则 `{ skip:false, time, counts:true }`。

`record(owner, now, time, counts)`：`day = floor(now/dayMs)`；`base = prev && prev.day===day ? prev.count : 0`；写 `{ day, count: base + (counts?1:0), armedUntil: time }`。

设计要点：`record` 只在**发送成功后**调用，故失败不会被误判为已布防（下轮仍作新布防/刷新重试）。跨 00:00 UTC：count 归零但 `armedUntil` 保留 → 若仍布防，下轮仍是免费刷新（甚至可能整日 0 计数）。稳态每日仅 ~1 次计数，10 预算给重连churn留足余量。

### 3. `server/src/engine/deadMan.ts` — 心跳驱动

```ts
export interface DeadManHeartbeatDeps {
  activeOwners(): string[];   // owners with >=1 running strategy (dedup handled internally)
  budget: DeadManBudget;
  executor: DeadManExecutor;
  now(): number;
  ttlMs: number;
}

export async function deadManHeartbeat(deps: DeadManHeartbeatDeps): Promise<void> {
  const now = deps.now();
  for (const owner of new Set(deps.activeOwners())) {
    const d = deps.budget.decide(owner, now, deps.ttlMs);
    if (d.skip) continue; // daily budget exhausted → cannot arm again today (fail-closed)
    if (await deps.executor.arm(owner, d.time)) deps.budget.record(owner, now, d.time, d.counts);
  }
}
```
按 owner 顺序 await（无并发竞态）。budget skip 的 owner 不 arm；arm 失败不 record。

### 4. `server/src/index.ts` 装配

```ts
const deadManTtlMs = process.env.DEADMAN_TTL_MS ? Number(process.env.DEADMAN_TTL_MS) : undefined;
const deadManEnabled = deadManTtlMs !== undefined && Number.isFinite(deadManTtlMs) && deadManTtlMs >= 10_000;
const deadManExecutor = makeDeadManExecutor({ clientFor, shadowVerify });
const deadManBudget = makeDeadManBudget();
const activeOwners = () => [...new Set(store.listAll().filter((s) => s.status === "running").map((s) => s.owner))];
```
在现有 `setInterval` 回调内、`tick(...)` 之后追加（仅启用时）：
```ts
    if (deadManEnabled) {
      void deadManHeartbeat({ activeOwners, budget: deadManBudget, executor: deadManExecutor, now, ttlMs: deadManTtlMs as number })
        .catch((e) => console.error("dead-man heartbeat failed", e));
    }
```
`clientFor` 与 `shadowVerify` 已在 index.ts 作用域内（现有 placer/restingExec 装配已用）。

## 关键取舍

- **启用需显式配置**：未设 `DEADMAN_TTL_MS` 或 < 10s → 禁用（安全保守；避免误配一个 < HL 5s 下限的 TTL）。建议 `DEADMAN_TTL_MS ≥ 3 × TICK_MS`，使正常运行永不误触发，仅宕机超 TTL 才撤单。
- **只 `arm` 不 clear**：优雅重启在 TTL 内刷新；宕机超 TTL 撤单是安全默认。
- **只撤单不平仓**：离线大持仓仍暴露市场风险——须由 app/UX 诚实揭示（spec §6.1）+ 策略预置驻留 HL 侧的 reduce-only 止损。本 slice 仅实现机制。
- **发送失败 fail-closed**：`arm` 返回 false 不 record，下轮重试；不会误标已布防。

## 测试

- **`deadManExecutor`**：`arm` 调 `scheduleCancel({ time })` 返回 true；无 client → false；client 抛错 → false；shadowVerify 收到 `{ time }`（fire-and-forget，抛错不影响 arm）。
- **`deadMan` budget**：首次布防 `counts:true`；record 后仍布防（armedUntil>now）→ 下次 `decide` 是免费刷新 `counts:false`；连续新布防到 count=10 后 `decide` 返回 `skip`；过期后（armedUntil ≤ now）重新布防 `counts:true`；跨日（now 进入新 day）count 归零但仍布防 → 刷新仍免费；`record` 仅在调用时提交（未 record 不改状态）。
- **`deadManHeartbeat`**：多 active owner 各 arm 一次并 record；`decide` skip 的 owner 不调 executor.arm；`executor.arm` 返回 false 时不 record（下轮重试）。dedup 重复 owner。

## 门禁

`cd server && npm run typecheck && npm test`。

## 任务拆分

3 个 task（budget 与 executor 相互独立；heartbeat+index 依赖前两者）：
1. `engine/deadMan.ts` `makeDeadManBudget`（decide/record 状态机）+ 测试。
2. `agent/deadManExecutor.ts` `makeDeadManExecutor`（arm，never-throw fail-closed）+ 测试。
3. `engine/deadMan.ts` `deadManHeartbeat` + `index.ts` 装配（`DEADMAN_TTL_MS` env、activeOwners、timer）+ 测试。
