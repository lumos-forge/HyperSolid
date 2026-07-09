# 死手 opt-in + clear-on-shutdown 设计（server/ TS）

日期：2026-07-09
状态：已批准

## 背景

PR #52/#53 落地了 scheduleCancel 死手开关（心跳 + ≤10/日预算 + 失败告警），但留了两个后续项：

1. **无逐 owner opt-in**：`DEADMAN_TTL_MS` 全局启用后，对**所有**有 running 策略的 owner 一律布防。用户无法选择是否为自己的账户启用死手（死手只撤单不平仓，离线持仓仍暴露——有用户可能不想被自动撤单）。
2. **无 clear-on-shutdown**：优雅关停（部署/滚动重启）时死手不清除，若重启慢于 TTL 会误触发 cancel-all；且当前 `index.ts` 无任何 SIGINT/SIGTERM 处理。

本 slice 补齐这两项。opt-in 经**策略参数**表达（无新 store/endpoint）；clear-on-shutdown 加**执行器 clear + 优雅关停 handler**。

## 目标

- **opt-in**：策略参数新增可选 `deadMan?: boolean`；owner「任一 running 策略 `deadMan===true`」才布防（默认 off = 真 opt-in）。
- **clear-on-shutdown**：`deadManExecutor.clear(owner)`（发 `scheduleCancel({})` 清除）+ `deadManClearAll` 批量清除 + `index.ts` SIGINT/SIGTERM handler。

**非目标（YAGNI）**：不做 owner 偏好存储/HTTP 端点/app 设置（opt-in 走策略参数）；不做逐策略（而非逐 owner）的死手（死手是账户级）；不改 budget/心跳/告警逻辑。

## 关键行为变更

已启用部署（`DEADMAN_TTL_MS` 已配）的死手覆盖从「所有有 running 策略的 owner」→「有 ≥1 个 running 且 `deadMan:true` 策略的 owner」。未启用部署不受影响。这是用户明确批准的 opt-in 语义。

## 架构

### A. opt-in（按 owner，经策略参数）

**`server/src/strategies/types.ts`**：新增共享基接口，5 个 params 接口 extends 它（DRY）：
```ts
/** Fields common to every strategy's params. */
export interface StrategyParamsCommon {
  /** Opt-in: while this strategy runs, arm the account-level scheduleCancel dead-man switch. */
  deadMan?: boolean;
}
export interface DcaParams extends StrategyParamsCommon { /* ...existing... */ }
export interface TwapParams extends StrategyParamsCommon { /* ... */ }
export interface TpslParams extends StrategyParamsCommon { /* ... */ }
export interface GridParams extends StrategyParamsCommon { /* ... */ }
export interface GridLimitParams extends StrategyParamsCommon { /* ... */ }
```

**`server/src/strategies/validate.ts`**：`validateParams` 在 coin 校验之后、分 kind 之前加：
```ts
if (p.deadMan !== undefined && typeof p.deadMan !== "boolean") return { ok: false, error: "deadMan must be a boolean" };
const deadMan = p.deadMan === true;
```
每个 kind 的成功返回对象 spread `...(deadMan ? { deadMan: true } : {})`（沿用 `maxTotalUsdc`/`mode` 的可选字段写法，默认 false 时不写该字段）。

**`server/src/index.ts`**：`activeOwners` 过滤增加 opt-in 条件：
```ts
const activeOwners = () => [...new Set(
  store.listAll()
    .filter((s) => s.status === "running" && (s.params as { deadMan?: boolean }).deadMan === true)
    .map((s) => s.owner),
)];
```

参数持久化：HTTP `POST /strategies` → `validateParams` → `store.create(owner, kind, v.params)`；SQLite 以 JSON 存 params（`JSON.parse(row.params)` 读回），故 `deadMan:true` 存续、重启后仍生效。

### B. clear-on-shutdown

**`server/src/agent/deadManExecutor.ts`**：`DeadManExecutor` 接口增加 `clear`：
```ts
export interface DeadManExecutor {
  arm(owner: string, timeMs: number): Promise<boolean>;
  /** Clear the owner's scheduled cancel (omit time). Returns false on no client or error. */
  clear(owner: string): Promise<boolean>;
}
```
实现：无 client→false；`try { deps.shadowVerify?.("scheduleCancel", {}); } catch {}`；`try { await client.scheduleCancel({}); return true; } catch { return false; }`（never-throw，best-effort）。

**`server/src/engine/deadMan.ts`**：新增
```ts
/** Best-effort clear of the dead-man for every (deduped) owner, e.g. on graceful shutdown. A single
 *  owner's failure does not stop the rest. Sequential. */
export async function deadManClearAll(deps: {
  activeOwners(): string[];
  executor: Pick<DeadManExecutor, "clear">;
}): Promise<void> {
  for (const owner of new Set(deps.activeOwners())) {
    await deps.executor.clear(owner);
  }
}
```
（`executor.clear` 自身 never-throw，故循环不需 try/catch；仍以 `Pick<DeadManExecutor, "clear">` 收窄依赖便于测试。）

**`server/src/index.ts`** 优雅关停：在 `await app.listen(...)` 之后注册
```ts
  const shutdown = async () => {
    clearInterval(timer);
    if (deadManEnabled) {
      await deadManClearAll({ activeOwners, executor: deadManExecutor });
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
```

## 关键取舍

- **opt-in 走策略参数**：零新增 store/endpoint、纯 server 内部、可测（validateParams）。代价是 opt-in 是逐 owner（任一 running 策略开启即为账户布防），因为死手本就是账户级。
- **默认 off = 真 opt-in**：与用户选择一致；未 opt-in 的 owner 不布防（死手只撤单不平仓，默认不打扰）。全局 `DEADMAN_TTL_MS` 仍是总开关。
- **优雅信号清除、非优雅死亡保护**：SIGINT/SIGTERM 清除避免部署误撤单；SIGKILL/崩溃无 handler → 死手照常触发，保护不丢。清除后到新进程首心跳有秒级未保护窗口，可接受。
- **薄装配不单测**：`activeOwners` 的 opt-in 过滤与信号 handler 属 index.ts 装配层（同既有 timer 装配一样不单测），由 typecheck + 单元覆盖的原语（validate/clear/clearAll）共同保证。

## 测试

- **`validate`**：各 kind `deadMan:true` 透传进返回 params（至少 dca + gridLimit 两例）；缺省或 `false` 时 params 不含 `deadMan`；`deadMan` 非 boolean（如 `"yes"`/`1`）拒绝并给出错误。
- **`deadManExecutor.clear`**：发 `scheduleCancel({})`（空对象）返回 true；无 client→false；client 抛错→false；shadowVerify 收到 `("scheduleCancel", {})` 且其抛错不影响 clear。
- **`deadManClearAll`**：对每个（去重后）owner 调一次 `executor.clear`；空 owner 列表→不调用；重复 owner 去重；单个 owner clear 返回 false 不阻断其余（顺序完成全部）。

## 门禁

`cd server && npm run typecheck && npm test`。

## 任务拆分

3 个 task（opt-in 与 clear 原语相互独立；index 装配依赖前两者）：
1. `strategies/types.ts` + `validate.ts`：`deadMan?` 参数 opt-in（共享基 + 校验透传）+ 测试。
2. `agent/deadManExecutor.ts` `clear` + `engine/deadMan.ts` `deadManClearAll` + 测试。
3. `index.ts`：`activeOwners` opt-in 过滤 + SIGINT/SIGTERM clear-on-shutdown 装配 + 全量门禁。
