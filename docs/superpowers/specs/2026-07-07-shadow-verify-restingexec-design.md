# 影子校验扩展：restingExecutor + cancelByCloid + fetch 超时

日期：2026-07-07
状态：已批准，待实现

## 背景

PR #20 给 TS `server/` 加了零风险影子校验（`signerShadow.ts`），把 `placer.ts` 的 `order`（IoC）在真实运行时与 Go signer 对拍 L1 actionHash。但服务器还有两处签名未被影子覆盖，且 PR #20 评审留了一个非阻断项（fetch 无超时）。本片承接补齐：

- **`restingExecutor.ts`** 实际签两种 action：`placeLimit` → `order`（ALO 挂单）；`cancelCloid` → `cancelByCloid`。二者尚未接影子校验。
- **`signerShadow.ts`** 的 `actionFromKindParams` 只映射了 `order`；`cancelByCloid` 缺映射。
- **fetch 无超时**：Go signer 挂起时 fire-and-forget 请求会无限 pending（PR #20 评审的非阻断项）。

Go `/v1/digest/l1` 已支持全部 kind（golden 逐字节证明），本片纯粹是在真实运行时**多覆盖服务器实际签的 action** + **加超时护栏**。

## 架构

纯增量，延续 PR #20 的零风险姿态：fire-and-forget、吞一切异常、默认关闭（未配 `SIGNER_SHADOW_URL` 时 `shadowVerify` 为 `undefined`）。永不阻塞、永不改变真实下单/撤单结果。

### 改动 1：`server/src/agent/signerShadow.ts`

**(a) fetch 超时**（AbortController + setTimeout，默认 2000ms）：
- `ShadowOpts` 加 `timeoutMs?: number`。
- `FetchLike` 的 init 类型加 `signal?: AbortSignal`。
- 在支持的 kind 分支内（`actionFromKindParams` 返回非空后），创建 `const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);`，把 `signal: controller.signal` 传给 fetch，用内层 `try { … } finally { clearTimeout(timer); }` 确保清理。超时触发 abort → fetch reject → 被既有外层 `catch` 吞掉并 `warn`。

**(b) cancelByCloid 映射**：`actionFromKindParams` 增加分支：
```ts
if (kind === "cancelByCloid") {
  const p = params as { cancels: { asset: number; cloid: string }[] };
  return { type: "cancelByCloid", cancels: p.cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })) };
}
```
（与 Go `BuildCancelByCloidAction` 的 `{type,cancels:[{asset,cloid}]}` 一致。`order` 分支不变，已覆盖 Ioc 与 Alo——`tif` 是参数。）

### 改动 2：`server/src/agent/restingExecutor.ts`

- `RestingExecutorDeps` 加可选 `shadowVerify?: (kind: string, params: unknown) => void`。
- `placeLimit`：在构造 `order`（`t:{limit:{tif:"Alo"}}`）之后、`await client.order(...)` 之前，try/catch 调：
  ```ts
  try {
    deps.shadowVerify?.("order", {
      asset: assetIndex, isBuy: req.side === "buy", px: order.p, sz: order.s,
      reduceOnly: order.r, tif: "Alo", grouping: "na", cloid: order.c,
    });
  } catch { /* shadow must never affect placement */ }
  ```
- `cancelCloid`：在解出 `assetIndex` 之后、`await client.cancelByCloid(...)` 之前，try/catch 调：
  ```ts
  try {
    deps.shadowVerify?.("cancelByCloid", { cancels: [{ asset: assetIndex, cloid: req.cloid }] });
  } catch { /* shadow must never affect cancellation */ }
  ```

### 改动 3：`server/src/index.ts`

已有 `shadowVerify`（PR #20 从 `SIGNER_SHADOW_URL` 构造）。把它也传入 restingExecutor：
```ts
const restingExec = makeRestingExecutor({ clientFor, resolveAsset: resolvers.resolveAsset, shadowVerify });
```
（未配 `SIGNER_SHADOW_URL` → `shadowVerify` 为 `undefined` → restingExecutor 不触发，零开销零风险。）

## 数据流

```
restingExecutor.placeLimit/cancelCloid 建 action
  → 真实 client.order(...) / client.cancelByCloid(...)（不变）
  → deps.shadowVerify?.(kind, params)   // 可选、旁路、吞异常、带 2000ms 超时
       │ 本地 createL1ActionHash(action, SHADOW_NONCE) = localHash
       │ POST Go /v1/digest/l1（signal 超时）→ remoteHash
       └ localHash === remoteHash ? debug : warn+metric
```

## 测试

- `server/src/agent/signerShadow.test.ts`（新增用例）：
  - **超时**：mock fetch 返回一个"直到 abort 才 reject"的 promise（`init.signal.addEventListener("abort", …)`）；`makeShadowVerifier({..., timeoutMs: 20})`；`verify("order", …)`；等待 >20ms；断言 `warn` 被调用一次（超时被吞掉，不抛、不挂）。
  - **cancelByCloid 匹配**：用真实 `createL1ActionHash` 算 `{type:"cancelByCloid", cancels:[{asset,cloid}]}` 的 hash 作 mock fetch 返回值；`verify("cancelByCloid", {cancels:[{asset:0,cloid:"0x…01"}]})`；断言 fetch 被调用、`warn` 未被调用。
- `server/src/agent/restingExecutor.test.ts`（新增用例）：
  - `placeLimit` 注入 `shadowVerify` spy → 被调用一次，`kind==="order"`，params `matchObject({asset:3,isBuy:true,tif:"Alo",grouping:"na",cloid:"0xc"})`。
  - `cancelCloid` 注入 spy → 被调用一次，`kind==="cancelByCloid"`，params `{cancels:[{asset:3,cloid:"0xc"}]}`。
  - 抛错的 `shadowVerify` 不影响 `placeLimit`（仍返回 resting oid）与 `cancelCloid`（仍返回 true）。

## 验证门槛

- `cd server && npx tsc --noEmit && npx jest` 全绿（≥ 既有基线 220）。
- Go 侧不改，无需重跑（`/v1/digest/l1` 已支持 cancelByCloid，golden 已证）。

## 范围外（YAGNI）

- 服务器未签的其它 kind 映射（cancel/modify/scheduleCancel 等）。
- user-signed 影子、把签名迁到 Go（replace）、mTLS。
