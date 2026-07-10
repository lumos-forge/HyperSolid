# M7 推送 · P5a-server —— 服务端按 locale 渲染推送文案

- 日期：2026-07-10
- 里程碑：M7 推送服务（子项目 P5a-server；P5a 拆为 server + mobile）
- 语言：TypeScript（`server/`）
- 状态：设计已批准，待实现

## 1. 背景与分解

P4 目前发**英文**推送文案（`server/src/push/notifications.ts`），P2 `notify(owner, n)` 把同一段 `title/body` 发给该 owner 的所有 token。P5a 让推送按用户语言出中/英文（`@msebilly-81` 偏好中文）。

P5a 跨端，拆为独立子项目：
- **P5a-server（本文）**：注册表加 `locale` 列；`notify` 改为**按 token 的 locale 渲染**；服务端 push i18n（en/zh）；`/push/register` 接受 `locale`。token 无 locale → 默认 `en`（零回归）。
- **P5a-mobile**：注册时从 `localeStore` 上报 `locale`。

P5a-server 先行且自包含：合并后所有 token 默认 en（现状不变），待 P5a-mobile 上报 zh 后中文用户即收中文。

## 2. 范围与非目标

**在范围内**
- `push_tokens.locale` 列（幂等迁移）；`register`/`PushTokenRow`/`tokensForOwner` 带 locale。
- `notify(owner, render)`：`render: (locale: PushLocale) => Notification`，逐 token 按其 locale 渲染。
- 服务端 push i18n（`server/src/push/messages.ts`，en/zh）。
- catalog 三个 builder 接受 `locale`。
- `/push/register` body 接受可选 `locale`。
- 调用方（`NotifyingActivityStore`、`index.ts` onHealthEvent）传 render fn。

**非目标**
- 不改 mobile（P5a-mobile）。
- 通知分类/免打扰（P5b/P5c）；延迟回执（P2.5）。
- 不改 `data` payload（保持 kind 等，供 app 深链）。

## 3. 注册表加 locale（`server/src/push/pushTokenStore.ts`）

- `migrate`：`CREATE TABLE IF NOT EXISTS` 后，仿 strategies 幂等加列：
  ```ts
  const cols = new Set((db.prepare("PRAGMA table_info(push_tokens)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("locale")) db.exec("ALTER TABLE push_tokens ADD COLUMN locale TEXT");
  ```
- `PushTokenRow` 加 `locale: string | null`。
- `register(owner, token, platform, locale, now)`：INSERT 带 locale，`ON CONFLICT(token) DO UPDATE` 也刷新 `locale = excluded.locale`。
- `tokensForOwner`：SELECT 带 `locale` → row。
- `PushTokenStore` 接口 `register` 签名加 `locale: string | null`。

> 现有 register 调用点（`app.ts` `/push/register`）改为传 locale（见 §7）。

## 4. 服务端 push i18n（`server/src/push/messages.ts`）

```ts
export type PushLocale = "en" | "zh";

function sideLabel(locale: PushLocale, side: string): string {
  const buy = side.toLowerCase() === "buy";
  if (locale === "zh") return buy ? "买入" : "卖出";
  return buy ? "Buy" : "Sell";
}

export const pushMessages = {
  en: {
    fillTitle: "Order filled",
    fillBody: (side: string, sz: string, coin: string, px: string) => `${sideLabel("en", side)} ${sz} ${coin} @ ${px}`,
    deadmanAlertTitle: "Strategy protection at risk",
    deadmanAlertBody: (n: number) => `${n} consecutive unprotected heartbeats — check your agent authorization.`,
    deadmanRecoveredTitle: "Strategy protection restored",
    deadmanRecoveredBody: "Your automated strategies are protected again.",
  },
  zh: {
    fillTitle: "订单成交",
    fillBody: (side: string, sz: string, coin: string, px: string) => `${sideLabel("zh", side)} ${sz} ${coin} @ ${px}`,
    deadmanAlertTitle: "策略保护异常",
    deadmanAlertBody: (n: number) => `连续 ${n} 次心跳未受保护——请检查 agent 授权。`,
    deadmanRecoveredTitle: "策略保护已恢复",
    deadmanRecoveredBody: "你的自动策略重新受到保护。",
  },
} as const;

/** Normalize any stored/raw locale to a supported PushLocale (default en). */
export function toPushLocale(v: string | null | undefined): PushLocale {
  return v === "zh" ? "zh" : "en";
}
```

数字仍用 `toLocaleString("en-US")`（中英通用，如 `50,000`）。

## 5. catalog（`server/src/push/notifications.ts`）—— 接受 locale

```ts
import { pushMessages, type PushLocale } from "./messages";
// fmt() 保留

export function fillNotification(a: Activity, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return {
    title: m.fillTitle,
    body: m.fillBody(a.side, fmt(a.sz), a.coin, fmt(a.px)),
    data: { kind: "fill", strategyId: a.strategyId, coin: a.coin, side: a.side, sz: a.sz, px: a.px },
  };
}
export function deadManAlertNotification(ev: { consecutiveFailures: number }, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return { title: m.deadmanAlertTitle, body: m.deadmanAlertBody(ev.consecutiveFailures), data: { kind: "deadman_alert", consecutiveFailures: ev.consecutiveFailures } };
}
export function deadManRecoveredNotification(locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return { title: m.deadmanRecoveredTitle, body: m.deadmanRecoveredBody, data: { kind: "deadman_recovered" } };
}
```

`capitalize()` 删除（side 本地化改由 `sideLabel`）。

## 6. notify 改为 render-by-locale（`server/src/push/notifier.ts`）

```ts
import { toPushLocale, type PushLocale } from "./messages";

async notify(owner: string, render: (locale: PushLocale) => Notification): Promise<NotifyResult> {
  const result = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
  let rows: PushTokenRow[];
  try {
    rows = this.store.tokensForOwner(owner).filter((r) => this.isValid(r.token));
  } catch (err) { this.log("push tokensForOwner failed", err); return result; }
  result.tokens = rows.length;
  if (rows.length === 0) return result;

  const cache = new Map<PushLocale, Notification>();
  const renderFor = (loc: PushLocale) => {
    let n = cache.get(loc);
    if (!n) { n = render(loc); cache.set(loc, n); }
    return n;
  };

  const tokens = rows.map((r) => r.token);
  const messages: ExpoPushMessage[] = rows.map((r) => {
    const n = renderFor(toPushLocale(r.locale));
    return { to: r.token, sound: "default", title: n.title, body: n.body, data: n.data };
  });
  // ... chunk / send / ticket↔token zip / DeviceNotRegistered prune  —— 用 `tokens` 做对应，逻辑不变
}
```

- 需要 `PushTokenRow` 类型（从 `./pushTokenStore` import type）；store 的 `tokensForOwner` 已返回 `PushTokenRow[]`（含 locale）。
- 渲染按 locale 缓存（最多 2 次），逐 token 取其 locale 的文案。
- chunk/回执/剪枝逻辑与现状一致（仍用 `tokens` 数组做块内 ticket↔token 对应）。

`Notification` 类型不变（`{title, body, data?}`）。`PushLocale` 从 `messages.ts` 导出。

## 7. HTTP 路由（`server/src/http/app.ts`）

`/push/register` body 加可选 `locale`：
```ts
const { token, platform, locale } = (req.body ?? {}) as { token?: unknown; platform?: unknown; locale?: unknown };
if (!isExpoPushToken(token)) return reply.code(400).send({ error: "invalid push token" });
const plat = platform === "ios" || platform === "android" ? platform : null;
const loc = locale === "en" || locale === "zh" ? locale : null;
deps.pushTokens.register(owner, token, plat, loc, now());
```
非法/缺失 locale 存 `null`（渲染时默认 en）。

## 8. 调用方

- `NotifyingActivityStore.record`（`notifyingActivityStore.ts`）：`this.notifier.notify(row.owner, (locale) => fillNotification(row, locale))`。
- `index.ts` `onHealthEvent`：`void notifier.notify(owner, (l) => deadManAlertNotification(ev, l)).catch(() => {})`；recovered 同理 `deadManRecoveredNotification(l)`。

## 9. 默认与兼容

- token `locale` 为 null / 非 en/zh → `toPushLocale` 归一到 `en`（现状文案不变）。
- 老数据无 locale 列 → 迁移加列默认 NULL → 渲染 en。**零回归**。

## 10. 测试计划

**`pushTokenStore.test.ts`（追加）**
- locale 迁移幂等（二次 open 不报错）。
- `register(..., "zh", ...)` 存 locale；`tokensForOwner` 返回 `locale:"zh"`；重注册刷新 locale。
- 旧调用签名更新为带 locale（已存在的 register 测试传 locale 参数）。

**`messages.test.ts`（新）**
- `sideLabel`/`pushMessages` en/zh 关键文案正确；`toPushLocale(null|"fr"|"zh")` → en/en/zh。

**`notifications.test.ts`（改）**
- `fillNotification(a, "en")` → "Order filled" / "Buy …"；`"zh"` → "订单成交" / "买入 …"。
- deadman alert/recovered en/zh。

**`notifier.test.ts`（改）**
- `notify(owner, render)`：owner 有两 token（locale en 与 zh）→ 各收对应语言文案（断言消息 title/body）。
- 无 locale token → en。
- 现有 fail-safe/剪枝/chunk 用例改为 `render` 形态（如 `() => N`）。

**`notifyingActivityStore.test.ts`（改）**
- 断言 `notifier.notify` 收到的 render fn 满足 `render("en")` 深等于 `fillNotification(row, "en")`。

**`app.test.ts`（改/追加）**
- `/push/register` 带 `locale:"zh"` → 入库 locale=zh；非法 locale → null；既有 register 测试仍绿。

## 11. 验证命令

```bash
cd server && npm run typecheck && npx jest src/push/ src/http/app.test.ts
```
（`npm test` 跑全量确认无回归。）

## 12. 与现有代码的关系

- locale 列迁移对齐 `strategies/sqliteStore.ts`（PRAGMA table_info + ALTER ADD COLUMN）。
- push i18n（en/zh 模板 + 插值）对齐 mobile `i18n/messages.ts` 思路（服务端独立一份，覆盖推送三类）。
- notify render-fn 保持 fail-safe/chunk/剪枝不变，仅内容按 locale 渲染。

## 13. 后续

- **P5a-mobile**：注册上报 `locale`（StrategyApi.registerPush 加 locale + PushEnv.locale + pushRegistration/toggle 传入）。
- P5b 分类开关、P5c 免打扰、P2.5 延迟回执。
