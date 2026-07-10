# M7 推送 · P4 —— 事件接线（引擎事件 → 通知）

- 日期：2026-07-10
- 里程碑：M7 推送服务（子项目 P4）
- 语言：TypeScript（`server/`）
- 状态：设计已批准，待实现

## 1. 背景

M7 已落地 P1 令牌注册表（`pushTokenStore.ts`）与 P2 通知核心（`notifier.ts`：fail-safe `Notifier.notify(owner, notification)`）。P4 把 server 引擎里两个**已存在的干净事件钩子**接到 `Notifier`，让自动交易真正产生用户可见推送。这是 P2 库首次实际装配（构造真实 `Expo` 客户端）。

事件钩子（勘察结论）：
- **成交**：每笔自动交易成交都经 `ActivityStore.record({strategyId,owner,time,coin,side,sz,px})`（`server/src/strategies/activityStore.ts`，其 doc 即「A recorded strategy fill」）。触发（TP/SL）→ 下单 → 成交也经此，故成交通知天然覆盖「触发→成交」。
- **dead-man 健康**：`onHealthEvent(owner, ev)`（`server/src/index.ts` 心跳回调，当前仅 `console.error`），`ev: DeadManHealthEvent = {kind:"none"} | {kind:"alert"; consecutiveFailures} | {kind:"recovered"}`（`server/src/engine/deadMan.ts`）。覆盖「熔断/授权健康告警」。

## 2. 范围与非目标

**在范围内**
- 通知目录（纯函数）：`fillNotification`、`deadManAlertNotification`、`deadManRecoveredNotification`。
- 成交装饰器 `NotifyingActivityStore implements ActivityStore`：`record` 委托内层后 fire-and-forget 发成交通知。
- 富化 `index.ts` 既有 `onHealthEvent`：alert/recovered 各发一条通知（保留原日志）。
- `index.ts` 装配：构造 `Notifier`（真实 `Expo`）、用装饰器包裹 activity store。

**非目标（明确排除）**
- kill-switch 不通知（用户主动操作，无需告知）。
- 纯「触发已挂/策略完成/DCA 每轮」等更细分类——留待需要时（P4.5）。
- 通知偏好 / 免打扰 / 按用户 locale 本地化——**P5**。P4 服务端发**英文**文本。
- 延迟回执轮询——**P2.5**。
- mobile 端（权限/取 token/注册调用）——**P3**。

## 3. 本地化取舍

Expo 推送在 OS 横幅显示服务端下发的 `title`/`body`（纯文本）。按用户 locale 本地化需存用户 locale 偏好（P5）。P4 一律发**英文** `title`/`body`，并在 `data` 里带结构化字段（`kind` 等），便于 app 打开时本地化/深链。

## 4. 通知目录（`server/src/push/notifications.ts`）

复用 P2 的 `Notification` 类型（`{ title, body, data? }`）与 `Activity` 类型（`server/src/strategies/activityStore.ts`）、`DeadManHealthEvent`（`server/src/engine/deadMan.ts`）。

```ts
import type { Notification } from "./notifier";
import type { Activity } from "../strategies/activityStore";
import type { DeadManHealthEvent } from "../engine/deadMan";

// e.g. "Bought 0.01 BTC @ 50,000"
export function fillNotification(a: Activity): Notification;

// dead-man protection failing (ev.kind === "alert")
export function deadManAlertNotification(ev: { consecutiveFailures: number }): Notification;

// dead-man protection recovered
export function deadManRecoveredNotification(): Notification;
```

内容（英文）：
- `fillNotification(a)`：
  - `title`: `"Order filled"`。
  - `body`: `` `${Side} ${sz} ${coin} @ ${px 格式化}` ``，`Side` = `a.side` 首字母大写（如 `Buy`/`Sell`），`px` 用千分位（`toLocaleString("en-US")`）。
  - `data`: `{ kind: "fill", strategyId: a.strategyId, coin: a.coin, side: a.side, sz: a.sz, px: a.px }`。
- `deadManAlertNotification(ev)`：
  - `title`: `"Strategy protection at risk"`。
  - `body`: `` `${ev.consecutiveFailures} consecutive unprotected heartbeats — check your agent authorization.` ``。
  - `data`: `{ kind: "deadman_alert", consecutiveFailures: ev.consecutiveFailures }`。
- `deadManRecoveredNotification()`：
  - `title`: `"Strategy protection restored"`。
  - `body`: `"Your automated strategies are protected again."`。
  - `data`: `{ kind: "deadman_recovered" }`。

纯函数、无副作用、可单测。

## 5. 成交装饰器（`server/src/push/notifyingActivityStore.ts`）

```ts
import type { ActivityStore, Activity } from "../strategies/activityStore";
import type { Notifier } from "./notifier";
import { fillNotification } from "./notifications";

/** Wraps an ActivityStore; on record(), also fires a fill push notification
 *  (fire-and-forget; Notifier.notify is itself fail-safe). All other methods pass through. */
export class NotifyingActivityStore implements ActivityStore {
  constructor(private inner: ActivityStore, private notifier: Pick<Notifier, "notify">) {}
  record(a: Omit<Activity, "id">): Activity {
    const row = this.inner.record(a);
    try {
      // swallow both a synchronous throw and an async rejection
      void Promise.resolve(this.notifier.notify(row.owner, fillNotification(row))).catch(() => {});
    } catch {
      // notifier threw synchronously (broken impl)
    }
    return row;
  }
  list(owner: string, strategyId: string): Activity[] { return this.inner.list(owner, strategyId); }
  listRecent(owner: string, limit: number): Activity[] { return this.inner.listRecent(owner, limit); }
  notionalSince(owner: string, sinceMs: number): number { return this.inner.notionalSince(owner, sinceMs); }
}
```

- `record` 先委托内层拿到含 `id`/归一化 owner 的 `row`，再用 `row` 构造通知并 `void notifier.notify(...)`（不 await，不阻塞交易 tick）。
- **隔离**：`Notifier.notify` 已 fail-safe（不外抛）；`void` 丢弃 promise。即使 notify 同步抛错（不应发生），也不能影响 `record` 返回——实现上 notify 调用包在 `try/catch` 里兜底（见 §7 测试 3）。
- 其余方法纯透传，`ActivityStore` 接口不变 → 消费方无感。

## 6. 装配（`server/src/index.ts`）

- 引入运行时 `import { Expo } from "expo-server-sdk"`（**仅此 runtime 处** import 该 ESM 值，不进被 jest 测的模块）。
- 构造 `const notifier = new Notifier({ expo: new Expo(), store: pushTokens });`。
- 包裹 activity：`const activity = new NotifyingActivityStore(SqliteActivityStore.open(dbPath), notifier);`（替换现有 `const activity = SqliteActivityStore.open(dbPath);`）。
- 富化 `onHealthEvent`：
  ```ts
  onHealthEvent: (owner, ev) => {
    if (ev.kind === "alert") {
      console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
      void notifier.notify(owner, deadManAlertNotification(ev));
    } else if (ev.kind === "recovered") {
      console.error(`dead-man arm recovered for ${owner}`);
      void notifier.notify(owner, deadManRecoveredNotification());
    }
  },
  ```
- `index.ts` 不被单测覆盖（既有约定）；其正确性由被测的纯 builder + 装饰器保证，装配为薄接线。

## 7. 测试计划

**`notifications.test.ts`**（纯函数）
1. `fillNotification`：buy 单 → `title:"Order filled"`、`body` 含 `"Buy 0.01 BTC @ 50,000"`（px 千分位）、`data.kind==="fill"` 且携带 strategyId/coin/side/sz/px。
2. `fillNotification`：sell 单 → `body` 以 `"Sell "` 开头（side 首字母大写）。
3. `deadManAlertNotification({consecutiveFailures:3})`：`title` 含 "protection"、`body` 含 `"3 consecutive"`、`data:{kind:"deadman_alert",consecutiveFailures:3}`。
4. `deadManRecoveredNotification()`：`data.kind==="deadman_recovered"`。

**`notifyingActivityStore.test.ts`**（fake inner store + fake notifier）
5. `record` 委托内层并返回其结果（含内层分配的 `id`）。
6. `record` 后用 `row.owner` + `fillNotification(row)` 的内容调用 `notifier.notify` 恰一次。
7. `notifier.notify` 抛错时 `record` 仍正常返回内层结果（fire-and-forget 隔离；实现用 try/catch 兜底）。
8. `list`/`listRecent`/`notionalSince` 透传到内层（参数与返回一致）。

## 8. 验证命令

```bash
cd server && npm run typecheck && npx jest src/push/notifications.test.ts src/push/notifyingActivityStore.test.ts
```
（`npm test` 跑全量确认无回归——尤其现有 activity 相关测试仍绿。）

## 9. 与现有代码的关系

- 装饰器模式对齐 server 既有「接口 + 实现」风格（`ActivityStore` 接口已在，装饰器实现同接口）。
- fire-and-forget + fail-safe 对齐 P2 `Notifier` 与 `internal/tracing`/`internal/obs` 的旁路失败隔离原则。
- 运行时 `Expo` 仅在 `index.ts` import，延续 P2「被测模块只用类型」的 ESM 规避策略。
- 复用 P1 `pushTokens`、P2 `Notifier`/`Notification`、`Activity`、`DeadManHealthEvent`。

## 10. 后续（本次不做）

- **P3** mobile 注册（权限 + 取 Expo token + 注册调用 + 设置开关）——接通后 P1/P2/P4 端到端可用。
- **P5** 通知偏好（分类开关/免打扰/按用户 locale 本地化）。
- **P2.5** 延迟回执轮询。
- **P4.5**（可选）更细通知分类（触发已挂/策略完成等）。
