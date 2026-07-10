# M7 推送 · P2 —— 通知核心 + Expo 传输（server/ TS）

- 日期：2026-07-10
- 里程碑：M7 推送服务（子项目 P2，共 P1–P4 + P2.5）
- 语言：TypeScript（`server/`）
- 状态：设计已批准，待实现

## 1. 背景

M7 分解见 P1 spec（`docs/superpowers/specs/2026-07-10-m7-push-token-registry-design.md`）。P1 已落地令牌注册表（`server/src/push/pushTokenStore.ts`：`tokensForOwner`、`deleteToken`）。

P2 交付**通知发送核心**：一个 fail-safe 的 `notify(owner, notification)` —— 查该 owner 的令牌、经 Expo Push Service 批量发送、对即时 ticket 里 `DeviceNotRegistered` 的令牌剪枝。纯库模块（仿 `wsshard`/`placer`：可注入、全单测、无网络），P4 事件接线时消费；本 PR 不接活路由/引擎。

## 2. 范围与非目标

**在范围内**
- `Notifier` 类 + `notify(owner, notification): Promise<NotifyResult>`。
- 注入式 `ExpoLike` 缝（`chunkPushNotifications` + `sendPushNotificationsAsync`），真实 `Expo` 实例结构上满足。
- 批量分块发送；逐 ticket 处理；`DeviceNotRegistered` 令牌即时剪枝（`store.deleteToken`）。
- **fail-safe**：`notify` 全程捕获、绝不外抛。
- 新增依赖 `expo-server-sdk`。

**非目标（明确排除）**
- 不做延迟回执轮询（**P2.5**：ticket-id→token 持久化 + ~15 分钟后 `getPushNotificationReceiptsAsync` + 剪枝 + 调度）。`DeviceNotRegistered` 多在延迟回执暴露；P2 只处理**即时 ticket** 层的该错误，其余留待 P2.5。
- 不接引擎事件源（P4）、不接 mobile（P3）。
- 不在 `index.ts` 装配（无调用者，避免未用变量；P4 装配 `new Notifier({ expo: new Expo(), store: pushTokens })`）。
- 不做通知偏好/分类/免打扰（P4）。
- 不做发送重试/退避（Expo SDK 内部已处理传输层；应用层重试留待需要时）。

## 3. 依赖

新增 `expo-server-sdk`（Expo 官方 Node SDK，production-grade）到 `server/package.json` dependencies。提供类型 `ExpoPushMessage`、`ExpoPushTicket`（notifier 仅用其类型，运行时依赖注入的 `ExpoLike`；默认令牌校验用本地正则以避免 jest 加载 ESM 包）；生产装配处（P4）用 `Expo` 实例。

## 4. 类型与接口（`server/src/push/notifier.ts`）

```ts
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import type { PushTokenStore } from "./pushTokenStore";

export interface Notification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Injectable seam over the subset of expo-server-sdk we use; a real `Expo`
// instance satisfies this structurally, tests pass a fake (no network).
export interface ExpoLike {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

export interface NotifierDeps {
  expo: ExpoLike;
  store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  /** Failure log sink; defaults to console.error. */
  logger?: (msg: string, err?: unknown) => void;
  /** Token validator; defaults to the Expo push-token format regex (types-only dep). */
  isValidToken?: (token: string) => boolean;
}

export interface NotifyResult {
  tokens: number; // valid tokens looked up for the owner
  sent: number;   // tickets with status "ok"
  errors: number; // tickets with status "error" (or a chunk that threw)
  pruned: number; // tokens deleted due to DeviceNotRegistered
}
```

## 5. 行为（`Notifier.notify`）

签名：`async notify(owner: string, n: Notification): Promise<NotifyResult>`。

1. `rows = store.tokensForOwner(owner)`（catch 保护，见 §6）。取每行 `token`，用 `isValidToken` 过滤；无有效令牌 → 返回 `{tokens:0,sent:0,errors:0,pruned:0}`，**不调用 Expo**。
2. 为每个有效 token 构造消息，保留 token↔message 配对：
   ```ts
   { to: token, sound: "default", title: n.title, body: n.body, data: n.data }
   ```
3. `chunks = expo.chunkPushNotifications(messages)`。为保持 ticket↔token 对应，按同一分块规则并行维护「每块的 token 顺序」——实现上：先构造 `messages` 与并行数组 `tokens[]`（同序），再对 `messages` 分块；由于 `chunkPushNotifications` 按顺序切分，用一个游标按每块长度从 `tokens[]` 切出对应片段。
4. 逐块：`try { tickets = await expo.sendPushNotificationsAsync(chunk) }`：
   - 抛错 → `logger("push send chunk failed", err)`；该块每个 token 计 `errors++`；继续下一块（不中断）。
   - 成功 → 逐 `(ticket, token)`（同序 zip）：
     - `ticket.status === "ok"` → `sent++`。
     - `ticket.status === "error"` → `errors++`；若 `ticket.details?.error === "DeviceNotRegistered"` → `store.deleteToken(token)`、`pruned++`。（错误 ticket 的 `details.expoPushToken` 也会带上出错令牌，但按块内同序 zip 出的 `token` 更稳健、无需依赖该可选字段。）
5. 返回累计 `NotifyResult`。

`tokens` = 有效令牌数（过滤后、发送前）。

## 6. 错误处理 / fail-safe

- `notify` **绝不外抛**：最外层 `try/catch` 包住整个流程；`store.tokensForOwner`、`chunkPushNotifications`、per-chunk `send`、`deleteToken` 的异常都被捕获并 `logger` 记录，函数照常返回 `NotifyResult`（尽力而为）。
- 对齐 `internal/tracing`/`internal/obs` 的失败隔离原则：推送是旁路，其失败绝不能打断交易/引擎关键路径（P4 调用方 fire-and-forget）。
- `logger` 默认 `console.error`（server 既有约定，见 `index.ts`）。

## 7. 测试计划（`notifier.test.ts`，fake `ExpoLike` + fake store，无网络）

fake `ExpoLike`：`chunkPushNotifications` 按可配置块大小切分（默认全放一块或每块 N 条）；`sendPushNotificationsAsync` 返回可编程 tickets 或抛错。fake store：内存 `tokensForOwner`/`deleteToken`，记录删除调用。

1. 无令牌 → `{0,0,0,0}`，`sendPushNotificationsAsync` 未被调用。
2. 两个有效令牌全 `ok` → `{tokens:2,sent:2,errors:0,pruned:0}`；消息含正确 `to/title/body/data/sound`。
3. 某 ticket `error` + `details.error==="DeviceNotRegistered"` → 该 token 被 `deleteToken`、`pruned:1,errors:1`；其余 token 不受影响。
4. 某 ticket `error` 非 DNR（如 `MessageRateExceeded`）→ `errors:1`，**不**剪枝。
5. 非法令牌（`isValidToken` 返回 false）被过滤，不进消息、不计入 `tokens`。
6. `sendPushNotificationsAsync` 抛错 → `notify` **不抛**，`logger` 被调用，该块 token 计 errors，返回值合理。
7. 多块（fake 块大小=1，3 个令牌）：第 2 块的 DNR 剪枝对应到**正确**的 token（验证跨块 token↔ticket 对应）。
8. `store.tokensForOwner` 抛错 → `notify` 不抛，返回 `{0,0,0,0}`，`logger` 被调用。

## 8. 验证命令

```bash
cd server && npm run typecheck && npx jest src/push/notifier.test.ts
```
（`npm test` 跑全量以确认无回归。）

## 9. 与现有代码的关系

- 注入式外部客户端缝对齐 `server/src/agent/placer.ts`（`ExchangeLike`）、`signerShadow.ts`（`fetchImpl?`/`ShadowLogger`）。
- 纯库模块 + 全单测、暂不接活路由，对齐 `backend/internal/wsshard`（先建可测核心，消费方后接）。
- 日志沿用 `console.error`（`server/src/index.ts` 约定）。
- 复用 P1 `PushTokenStore.tokensForOwner`/`deleteToken`。

## 10. 后续（本次不做）

- **P2.5 回执轮询**：持久化 ticket-id→token；~15 分钟后 `expo.getPushNotificationReceiptsAsync`（经 `chunkPushNotificationReceiptIds`）；对 `DeviceNotRegistered` receipts 剪枝；调度（复用 `engine/scheduler` 或独立定时）。
- **P3 mobile 注册**、**P4 事件接线 + 偏好**。
