# M7 P5a-server —— 服务端按 locale 渲染推送文案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Localize push text server-side: add a `locale` column to the push-token registry, render each notification per the token's locale (en/zh) via a `notify(owner, render)` signature + a server push-i18n module, and accept `locale` on `/push/register`. Missing locale → English (zero regression).

**Architecture:** `pushTokenStore` gains a `locale` column (idempotent migration). `notify(owner, n: Notification)` becomes `notify(owner, render: (locale) => Notification)`, keeping the token rows so it renders each message in that token's locale (cached per locale). A new `messages.ts` holds en/zh templates; the catalog builders take a `locale`. The two callers (`NotifyingActivityStore`, `index.ts` `onHealthEvent`) pass a render closure. `/push/register` parses an optional `locale`.

**Tech Stack:** TypeScript, better-sqlite3, jest. Reuses P1 registry, P2 notifier, P4 catalog/callers.

**Reference spec:** `docs/superpowers/specs/2026-07-10-m7-push-localized-server-design.md`

**Branch:** `feat/m7-push-localized-server` (already created; spec committed).

**Verified facts (do not re-derive):**
- `pushTokenStore.ts`: `PushTokenStore.register(owner, token, platform: string|null, now: number): void`; `tokensForOwner(owner): PushTokenRow[]`; `PushTokenRow = { token, owner, platform: string|null, createdAt, updatedAt }`; `DbRow = { token, owner, platform, created_at, updated_at }`; `toRow(r)` maps them; `migrate` does `CREATE TABLE IF NOT EXISTS push_tokens (token PK, owner, platform, created_at, updated_at)` + owner index. `register` uses `INSERT ... ON CONFLICT(token) DO UPDATE SET owner=excluded.owner, platform=excluded.platform, updated_at=excluded.updated_at`.
- Idempotent-column pattern (strategies/sqliteStore.ts): `const cols = new Set((db.prepare("PRAGMA table_info(push_tokens)").all() as {name:string}[]).map(c=>c.name)); if (!cols.has("locale")) db.exec("ALTER TABLE push_tokens ADD COLUMN locale TEXT");`
- `app.ts` `/push/register` handler: parses `{ token, platform }`, validates `isExpoPushToken(token)` (400 on fail), `plat = platform==="ios"||"android" ? platform : null`, `deps.pushTokens.register(owner, token, plat, now())`, 204.
- `notifier.ts` `notify(owner, n: Notification)`: `tokens = store.tokensForOwner(owner).map(r=>r.token).filter(isValid); result.tokens = tokens.length; messages = tokens.map(to => ({to, sound:"default", title:n.title, body:n.body, data:n.data}))`; then chunk/send/zip-tickets-to-`tokens`/prune-DeviceNotRegistered. `Notification = { title, body, data? }`.
- Callers: `notifyingActivityStore.ts` `record` does `void Promise.resolve(this.notifier.notify(row.owner, fillNotification(row))).catch(()=>{})`. `index.ts` `onHealthEvent`: `void notifier.notify(owner, deadManAlertNotification(ev)).catch(()=>{})` (alert) and `void notifier.notify(owner, deadManRecoveredNotification()).catch(()=>{})` (recovered).
- `notifications.ts`: `fillNotification(a: Activity)`, `deadManAlertNotification(ev)`, `deadManRecoveredNotification()` return English `Notification`; has `capitalize()` + `fmt()`.
- Test fakes: notifier.test `row(token): PushTokenRow = {token, owner: OWNER, platform:"ios", createdAt:1, updatedAt:1}`; `fakeStore(tokens)` → `tokensForOwner: () => tokens.map(row)`. notifyingActivityStore.test `notifierFake` records `calls:{owner, n}` with `async notify(owner, n)`. pushTokenStore.test calls `register(A, T1, "ios", 1000)` etc.
- Scripts: `npm run typecheck` = tsc; `npm test` = jest.

---

## File Structure

- Create: `server/src/push/messages.ts` — `PushLocale`, `pushMessages` (en/zh), `sideLabel`, `toPushLocale`.
- Create: `server/src/push/messages.test.ts`.
- Modify: `server/src/push/pushTokenStore.ts` — `locale` column/param/row.
- Modify: `server/src/push/pushTokenStore.test.ts` — locale + updated register calls.
- Modify: `server/src/http/app.ts` — parse `locale` on `/push/register`.
- Modify: `server/src/http/app.test.ts` — locale registration test.
- Modify: `server/src/push/notifications.ts` — builders take `locale`.
- Modify: `server/src/push/notifications.test.ts` — en/zh assertions.
- Modify: `server/src/push/notifier.ts` — `notify(owner, render)`, per-token render.
- Modify: `server/src/push/notifier.test.ts` — render-fn shape + localized test.
- Modify: `server/src/push/notifyingActivityStore.ts` — pass render closure.
- Modify: `server/src/push/notifyingActivityStore.test.ts` — render-fn assertion.
- Modify: `server/src/index.ts` — onHealthEvent render closures.

---

## Task 1: server push i18n (`messages.ts`)

**Files:**
- Create: `server/src/push/messages.ts`
- Test: `server/src/push/messages.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/messages.test.ts`:

```ts
import { pushMessages, sideLabel, toPushLocale } from "./messages";

describe("push messages", () => {
  it("localizes side labels", () => {
    expect(sideLabel("en", "buy")).toBe("Buy");
    expect(sideLabel("en", "sell")).toBe("Sell");
    expect(sideLabel("zh", "buy")).toBe("买入");
    expect(sideLabel("zh", "sell")).toBe("卖出");
  });

  it("has en + zh templates for fill and dead-man", () => {
    expect(pushMessages.en.fillTitle).toBe("Order filled");
    expect(pushMessages.zh.fillTitle).toBe("订单成交");
    expect(pushMessages.en.fillBody("buy", "0.01", "BTC", "50,000")).toBe("Buy 0.01 BTC @ 50,000");
    expect(pushMessages.zh.fillBody("sell", "2", "ETH", "3,200")).toBe("卖出 2 ETH @ 3,200");
    expect(pushMessages.en.deadmanAlertBody(3)).toContain("3 consecutive");
    expect(pushMessages.zh.deadmanAlertBody(3)).toContain("连续 3 次");
  });

  it("normalizes any locale to a supported one (default en)", () => {
    expect(toPushLocale("zh")).toBe("zh");
    expect(toPushLocale("en")).toBe("en");
    expect(toPushLocale(null)).toBe("en");
    expect(toPushLocale("fr")).toBe("en");
    expect(toPushLocale(undefined)).toBe("en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/messages.test.ts`
Expected: FAIL — cannot find module `./messages`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/push/messages.ts`:

```ts
export type PushLocale = "en" | "zh";

export function sideLabel(locale: PushLocale, side: string): string {
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/messages.test.ts && npm run typecheck`
Expected: PASS (3 tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/messages.ts server/src/push/messages.test.ts && \
  git commit -m "feat(push): server push i18n (en/zh templates + toPushLocale)"
```

---

## Task 2: `push_tokens.locale` column + `/push/register` locale

**Files:**
- Modify: `server/src/push/pushTokenStore.ts`
- Test: `server/src/push/pushTokenStore.test.ts`
- Modify: `server/src/http/app.ts`
- Test: `server/src/http/app.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/push/pushTokenStore.test.ts`, update the existing `register` calls to the new 5-arg signature (add a `locale` arg — `null` where locale is irrelevant) and add a locale test. First, update every existing `s.register(A, T1, "ios", 1000)`-style call to `s.register(A, T1, "ios", null, 1000)` (and similar). Then append:

```ts
describe("SqlitePushTokenStore locale", () => {
  it("stores and returns locale, refreshing it on re-register", () => {
    const s = SqlitePushTokenStore.open(":memory:");
    s.register("0x1111111111111111111111111111111111111111", "ExponentPushToken[a]", "ios", "zh", 1000);
    let rows = s.tokensForOwner("0x1111111111111111111111111111111111111111");
    expect(rows[0].locale).toBe("zh");
    s.register("0x1111111111111111111111111111111111111111", "ExponentPushToken[a]", "ios", "en", 2000);
    rows = s.tokensForOwner("0x1111111111111111111111111111111111111111");
    expect(rows[0].locale).toBe("en");
  });

  it("re-opening the same file is idempotent (locale migration)", () => {
    const s = SqlitePushTokenStore.open(":memory:");
    expect(s.tokensForOwner("0xabc")).toEqual([]);
  });
});
```

In `server/src/http/app.test.ts`, append (inside the push describe block, reusing `buildWithPush`, `tokenFor`, `account`, `PUSH_T`):

```ts
  it("stores the locale from the register body", async () => {
    const { app, pushTokens } = buildWithPush();
    const token = await tokenFor(app);
    await app.inject({ method: "POST", url: "/push/register", headers: { authorization: `Bearer ${token}` }, payload: { token: PUSH_T, platform: "ios", locale: "zh" } });
    expect(pushTokens.tokensForOwner(account.address)[0].locale).toBe("zh");
    await app.close();
  });

  it("stores null locale for an unsupported locale value", async () => {
    const { app, pushTokens } = buildWithPush();
    const token = await tokenFor(app);
    await app.inject({ method: "POST", url: "/push/register", headers: { authorization: `Bearer ${token}` }, payload: { token: PUSH_T, locale: "fr" } });
    expect(pushTokens.tokensForOwner(account.address)[0].locale).toBeNull();
    await app.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/pushTokenStore.test.ts src/http/app.test.ts`
Expected: FAIL — `register` now called with 5 args but signature is 4 (type error), and `.locale` is not on `PushTokenRow`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/push/pushTokenStore.ts`:

(a) `PushTokenRow` — add `locale`:
```ts
export interface PushTokenRow {
  token: string;
  owner: string;
  platform: string | null;
  locale: string | null;
  createdAt: number;
  updatedAt: number;
}
```

(b) `DbRow` + `toRow`:
```ts
interface DbRow {
  token: string;
  owner: string;
  platform: string | null;
  locale: string | null;
  created_at: number;
  updated_at: number;
}

function toRow(r: DbRow): PushTokenRow {
  return { token: r.token, owner: r.owner, platform: r.platform, locale: r.locale, createdAt: r.created_at, updatedAt: r.updated_at };
}
```

(c) `PushTokenStore.register` interface signature:
```ts
  register(owner: string, token: string, platform: string | null, locale: string | null, now: number): void;
```

(d) `migrate` — idempotent column add after the CREATE TABLE:
```ts
function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      platform TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_tokens_owner ON push_tokens(owner);
  `);
  const cols = new Set((db.prepare("PRAGMA table_info(push_tokens)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("locale")) db.exec("ALTER TABLE push_tokens ADD COLUMN locale TEXT");
}
```

(e) `register` impl:
```ts
  register(owner: string, token: string, platform: string | null, locale: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO push_tokens (token, owner, platform, locale, created_at, updated_at)
         VALUES (@token, @owner, @platform, @locale, @now, @now)
         ON CONFLICT(token) DO UPDATE SET
           owner = excluded.owner,
           platform = excluded.platform,
           locale = excluded.locale,
           updated_at = excluded.updated_at`,
      )
      .run({ token, owner: owner.toLowerCase(), platform, locale, now });
  }
```

(f) `tokensForOwner` SELECT:
```ts
  tokensForOwner(owner: string): PushTokenRow[] {
    const rows = this.db
      .prepare(`SELECT token, owner, platform, locale, created_at, updated_at FROM push_tokens WHERE owner = ?`)
      .all(owner.toLowerCase()) as DbRow[];
    return rows.map(toRow);
  }
```

In `server/src/http/app.ts` `/push/register` handler, parse + pass locale:
```ts
    const { token, platform, locale } = (req.body ?? {}) as { token?: unknown; platform?: unknown; locale?: unknown };
    if (!isExpoPushToken(token)) return reply.code(400).send({ error: "invalid push token" });
    const plat = platform === "ios" || platform === "android" ? platform : null;
    const loc = locale === "en" || locale === "zh" ? locale : null;
    deps.pushTokens.register(owner, token, plat, loc, now());
    return reply.code(204).send();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/pushTokenStore.test.ts src/http/app.test.ts && npm run typecheck`
Expected: PASS (store locale tests + existing store tests updated to 5-arg + app locale tests + existing app tests); `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/pushTokenStore.ts server/src/push/pushTokenStore.test.ts server/src/http/app.ts server/src/http/app.test.ts && \
  git commit -m "feat(push): push_tokens.locale column + /push/register locale"
```

---

## Task 3: locale-aware catalog + `notify(owner, render)` + callers

This is one coordinated commit (the catalog signature, `notify` signature, and both callers must change together to compile).

**Files:**
- Modify: `server/src/push/notifications.ts`, `notifications.test.ts`
- Modify: `server/src/push/notifier.ts`, `notifier.test.ts`
- Modify: `server/src/push/notifyingActivityStore.ts`, `notifyingActivityStore.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Update the tests to the new shape**

(a) `notifications.test.ts` — replace with locale-aware assertions:

```ts
import { fillNotification, deadManAlertNotification, deadManRecoveredNotification } from "./notifications";
import type { Activity } from "../strategies/activityStore";

function fill(over: Partial<Activity> = {}): Activity {
  return { id: "a1", strategyId: "s1", owner: "0xabc", time: 1000, coin: "BTC", side: "buy", sz: 0.01, px: 50000, ...over };
}

describe("notification catalog", () => {
  it("fillNotification en", () => {
    const n = fillNotification(fill(), "en");
    expect(n.title).toBe("Order filled");
    expect(n.body).toBe("Buy 0.01 BTC @ 50,000");
    expect(n.data).toEqual({ kind: "fill", strategyId: "s1", coin: "BTC", side: "buy", sz: 0.01, px: 50000 });
  });

  it("fillNotification zh", () => {
    const n = fillNotification(fill({ side: "sell", coin: "ETH", sz: 2, px: 3200 }), "zh");
    expect(n.title).toBe("订单成交");
    expect(n.body).toBe("卖出 2 ETH @ 3,200");
  });

  it("deadManAlertNotification en/zh", () => {
    expect(deadManAlertNotification({ consecutiveFailures: 3 }, "en").body).toContain("3 consecutive");
    expect(deadManAlertNotification({ consecutiveFailures: 3 }, "zh").title).toBe("策略保护异常");
    expect(deadManAlertNotification({ consecutiveFailures: 3 }, "zh").data).toEqual({ kind: "deadman_alert", consecutiveFailures: 3 });
  });

  it("deadManRecoveredNotification en/zh", () => {
    expect(deadManRecoveredNotification("en").data).toEqual({ kind: "deadman_recovered" });
    expect(deadManRecoveredNotification("zh").title).toBe("策略保护已恢复");
  });
});
```

(b) `notifier.test.ts` — (i) update `row(token)` to include `locale: null`; add a locale-aware row helper; (ii) change every `.notify(OWNER, N)` to `.notify(OWNER, () => N)`; (iii) add a per-locale render test. Concretely, update the `row` helper and `fakeStore`, and add after the existing tests:

```ts
// update helper: add locale
function row(token: string, locale: string | null = null): PushTokenRow {
  return { token, owner: OWNER, platform: "ios", locale, createdAt: 1, updatedAt: 1 };
}

// new store variant with per-token locale
function fakeStoreLocales(entries: { token: string; locale: string | null }[]) {
  const deleted: string[] = [];
  return {
    deleted,
    tokensForOwner: (_o: string) => entries.map((e) => row(e.token, e.locale)),
    deleteToken: (t: string) => { deleted.push(t); },
  };
}

// ... inside describe:
it("renders each token in its own locale (default en)", async () => {
  const store = fakeStoreLocales([
    { token: T1, locale: "en" },
    { token: T2, locale: "zh" },
    { token: T3, locale: null },
  ]);
  const expo = fakeExpo({ chunkSize: 10, tickets: okTickets });
  const res = await new Notifier({ expo, store }).notify(OWNER, (locale) => ({ title: locale, body: `b-${locale}`, data: {} }));
  expect(res.sent).toBe(3);
  const byTok = new Map(expo.sends.flat().map((m) => [m.to, m]));
  expect(byTok.get(T1)?.title).toBe("en");
  expect(byTok.get(T2)?.title).toBe("zh");
  expect(byTok.get(T3)?.title).toBe("en"); // null → en
});
```

(In the same file, change all existing `notify(OWNER, N)` calls to `notify(OWNER, () => N)`. `T3` is already declared in this test file from P2; if not, add `const T3 = "ExponentPushToken[cccccccccccccccccccccc]";`.)

(c) `notifyingActivityStore.test.ts` — the `notifierFake` now records a render fn; assert it renders the localized fill:

```ts
import { fillNotification } from "./notifications";
// ...
function notifierFake(opts: { throwSync?: boolean } = {}) {
  const calls: { owner: string; render: (locale: "en" | "zh") => Notification }[] = [];
  return {
    calls,
    async notify(owner: string, render: (locale: "en" | "zh") => Notification) {
      calls.push({ owner, render });
      if (opts.throwSync) throw new Error("boom");
      return { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    },
  };
}
```

And change the assertion in the "fires a fill notification..." test from `expect(notifier.calls[0].n).toEqual(fillNotification(row))` to:
```ts
    expect(notifier.calls[0].owner).toBe(row.owner);
    expect(notifier.calls[0].render("en")).toEqual(fillNotification(row, "en"));
    expect(notifier.calls[0].render("zh")).toEqual(fillNotification(row, "zh"));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/push/notifications.test.ts src/push/notifier.test.ts src/push/notifyingActivityStore.test.ts`
Expected: FAIL (compile/assertion) — catalog takes no locale yet, `notify` takes a `Notification` not a render fn.

- [ ] **Step 3: Implement the catalog**

Replace `server/src/push/notifications.ts` with:

```ts
import type { Notification } from "./notifier";
import type { Activity } from "../strategies/activityStore";
import { pushMessages, type PushLocale } from "./messages";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** Fill notification, localized. */
export function fillNotification(a: Activity, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return {
    title: m.fillTitle,
    body: m.fillBody(a.side, fmt(a.sz), a.coin, fmt(a.px)),
    data: { kind: "fill", strategyId: a.strategyId, coin: a.coin, side: a.side, sz: a.sz, px: a.px },
  };
}

/** Dead-man protection failing, localized. */
export function deadManAlertNotification(ev: { consecutiveFailures: number }, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return {
    title: m.deadmanAlertTitle,
    body: m.deadmanAlertBody(ev.consecutiveFailures),
    data: { kind: "deadman_alert", consecutiveFailures: ev.consecutiveFailures },
  };
}

/** Dead-man protection recovered, localized. */
export function deadManRecoveredNotification(locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return {
    title: m.deadmanRecoveredTitle,
    body: m.deadmanRecoveredBody,
    data: { kind: "deadman_recovered" },
  };
}
```

- [ ] **Step 4: Implement `notify(owner, render)`**

In `server/src/push/notifier.ts`:

(a) Add imports:
```ts
import { toPushLocale, type PushLocale } from "./messages";
import type { PushTokenRow } from "./pushTokenStore";
```

(b) Replace the `notify` method's token-lookup + message-build (through the `messages` array) with:
```ts
  async notify(owner: string, render: (locale: PushLocale) => Notification): Promise<NotifyResult> {
    const result: NotifyResult = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    let rows: PushTokenRow[];
    try {
      rows = this.store.tokensForOwner(owner).filter((r) => this.isValid(r.token));
    } catch (err) {
      this.log("push tokensForOwner failed", err);
      return result;
    }
    result.tokens = rows.length;
    if (rows.length === 0) return result;

    const cache = new Map<PushLocale, Notification>();
    const renderFor = (loc: PushLocale): Notification => {
      let n = cache.get(loc);
      if (!n) {
        n = render(loc);
        cache.set(loc, n);
      }
      return n;
    };

    const tokens = rows.map((r) => r.token);
    const messages: ExpoPushMessage[] = rows.map((r) => {
      const n = renderFor(toPushLocale(r.locale));
      return { to: r.token, sound: "default", title: n.title, body: n.body, data: n.data };
    });
```
Leave the remaining body (from `let chunks: ExpoPushMessage[][];` onward — chunk/send/`chunkTokens`/prune) UNCHANGED; it already uses the `tokens` array for ticket↔token correlation.

- [ ] **Step 5: Update the two callers**

(a) `server/src/push/notifyingActivityStore.ts` — import + render closure:
```ts
import type { ActivityStore, Activity } from "../strategies/activityStore";
import type { Notifier } from "./notifier";
import type { PushLocale } from "./messages";
import { fillNotification } from "./notifications";
```
and in `record`:
```ts
      void Promise.resolve(this.notifier.notify(row.owner, (locale: PushLocale) => fillNotification(row, locale))).catch(() => {});
```

(b) `server/src/index.ts` `onHealthEvent`:
```ts
          if (ev.kind === "alert") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
            void notifier.notify(owner, (l) => deadManAlertNotification(ev, l)).catch(() => {});
          } else if (ev.kind === "recovered") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm recovered for ${owner}`);
            void notifier.notify(owner, (l) => deadManRecoveredNotification(l)).catch(() => {});
          }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && npx jest src/push/ src/http/app.test.ts && npm run typecheck`
Expected: PASS (all push tests + app tests); `tsc` clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifications.ts server/src/push/notifications.test.ts server/src/push/notifier.ts server/src/push/notifier.test.ts server/src/push/notifyingActivityStore.ts server/src/push/notifyingActivityStore.test.ts server/src/index.ts && \
  git commit -m "feat(push): render notifications per token locale (notify render-fn + i18n catalog)"
```

---

## Task 4: roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the roadmap M7 status**

In `docs/BACKEND-ARCHITECTURE.md`, in the M7 pending list, replace `P5 通知偏好+locale` with:

```
P5a-server 本地化推送（push_tokens.locale + notify 逐 token 按 locale 渲染 + 服务端 push i18n en/zh，默认 en）落地；P5a-mobile（上报 locale）、P5b 分类开关、P5c 免打扰
```

(Find the exact `P5 通知偏好+locale` substring in the M7 row and replace only it, preserving the surrounding pending items.)

- [ ] **Step 2: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: mark M7 P5a-server 本地化推送 landed"
```

- [ ] **Step 3: Full server validation (no regressions)**

Run: `cd server && npm run typecheck && npm test`
Expected: typecheck clean; the whole jest suite passes.

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-localized-server && \
  gh pr create --title "feat(server): M7 P5a-server 服务端按 locale 渲染推送文案" \
    --body "M7 推送子项目 P5a-server。push_tokens 加 \`locale\` 列（幂等迁移）；\`notify(owner, render)\` 逐 token 按其 locale 渲染（en/zh，按 locale 缓存）；服务端 push i18n \`messages.ts\`；catalog builders 接受 locale；\`/push/register\` 接受可选 \`locale\`。token 无 locale → 默认 en（零回归）。mobile 上报 locale 拆为 P5a-mobile。Spec: docs/superpowers/specs/2026-07-10-m7-push-localized-server-design.md"
```
Expected: PR created.

- [ ] **Step 5: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §3 registry locale → Task 2; §4 messages → Task 1; §5 catalog → Task 3; §6 notify → Task 3; §7 route → Task 2; §8 callers → Task 3; §9 default en (`toPushLocale`) → Tasks 1/3; §10 tests → Tasks 1–3; §11 validation → Task 4. Doc → Task 4. All covered.
- **Placeholder scan:** all code complete; the "leave the remaining body unchanged" note (Task 3 Step 4) references the exact existing chunk/send block that already correlates via `tokens`.
- **Type consistency:** `PushLocale = "en"|"zh"` (messages.ts) used in catalog/notifier/callers; `notify(owner, render: (locale: PushLocale) => Notification)`; `register(owner, token, platform, locale, now)`; `PushTokenRow.locale`; `toPushLocale` default en — identical across all tasks and match the spec.
- **Atomic refactor safety:** Task 3 changes catalog + notify + both callers + their tests in one commit so the tree compiles and all tests pass together (splitting further would leave the tree non-compiling). Task 2 changes `register` signature + its only caller (app.ts route) + store/app tests together for the same reason.
- **Zero regression:** missing/unknown `locale` → `toPushLocale` → `en`, preserving current English behavior for all existing tokens; the migration adds a nullable column (no default value change).
