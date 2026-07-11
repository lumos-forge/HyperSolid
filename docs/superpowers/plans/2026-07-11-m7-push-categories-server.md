# M7 P5b-server — Per-Category Push Preferences (server) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-authoritative per-owner push category preferences (`fills`, `alerts`, default on) and gate `Notifier.notify` on them so disabled categories are never delivered.

**Architecture:** A new SQLite `PushPrefStore` (per-owner, per-category rows; absent → on). `Notifier.notify` gains a `category` parameter and an optional injected `prefs` dep; it returns early (zeros) when the category is disabled, fail-open on lookup error. Two callers pass their category. New authed `GET/POST /push/prefs` routes read/write prefs. Wiring injects the store in `index.ts`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, jest.

Spec: `docs/superpowers/specs/2026-07-11-m7-push-categories-server-design.md`

---

## Task 1: `PushPrefStore` (SQLite per-category prefs)

Self-contained new module; no signature ripple.

**Files:**
- Create: `server/src/push/pushPrefStore.ts`
- Create: `server/src/push/pushPrefStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/pushPrefStore.test.ts`:
```ts
import { SqlitePushPrefStore } from "./pushPrefStore";

const OWNER = "0xABCDEF0000000000000000000000000000000001";

describe("SqlitePushPrefStore", () => {
  it("defaults every category to enabled on a fresh db", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    expect(s.isEnabled(OWNER, "fills")).toBe(true);
    expect(s.isEnabled(OWNER, "alerts")).toBe(true);
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true });
  });

  it("persists a disabled category and leaves others on", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { fills: false }, 1000);
    expect(s.isEnabled(OWNER, "fills")).toBe(false);
    expect(s.isEnabled(OWNER, "alerts")).toBe(true);
    expect(s.get(OWNER)).toEqual({ fills: false, alerts: true });
  });

  it("upserts: a later set overwrites the earlier value", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { fills: false }, 1000);
    s.set(OWNER, { fills: true }, 2000);
    expect(s.isEnabled(OWNER, "fills")).toBe(true);
  });

  it("set with an empty object is a no-op", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, {}, 1000);
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true });
  });

  it("matches owner case-insensitively", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { alerts: false }, 1000);
    expect(s.isEnabled(OWNER.toLowerCase(), "alerts")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/pushPrefStore.test.ts`
Expected: FAIL — `Cannot find module './pushPrefStore'`.

- [ ] **Step 3: Implement the store**

Create `server/src/push/pushPrefStore.ts`:
```ts
import Database from "better-sqlite3";

export type PushCategory = "fills" | "alerts";

export interface PushPrefs {
  fills: boolean;
  alerts: boolean;
}

export interface PushPrefStore {
  /** Effective on/off for one category; an absent row defaults to true (on). */
  isEnabled(owner: string, category: PushCategory): boolean;
  /** Effective prefs for every category (absent → true). */
  get(owner: string): PushPrefs;
  /** Upsert only the provided categories. */
  set(owner: string, prefs: Partial<PushPrefs>, now: number): void;
}

const CATEGORIES: PushCategory[] = ["fills", "alerts"];

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_prefs (
      owner TEXT NOT NULL,
      category TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner, category)
    );
  `);
}

/** Durable per-owner category preferences over SQLite. Owner match is case-insensitive.
 *  Missing rows default to enabled (notifications on). */
export class SqlitePushPrefStore implements PushPrefStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqlitePushPrefStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqlitePushPrefStore(db);
  }

  isEnabled(owner: string, category: PushCategory): boolean {
    const row = this.db
      .prepare(`SELECT enabled FROM push_prefs WHERE owner = ? AND category = ?`)
      .get(owner.toLowerCase(), category) as { enabled: number } | undefined;
    return row ? row.enabled !== 0 : true;
  }

  get(owner: string): PushPrefs {
    const rows = this.db
      .prepare(`SELECT category, enabled FROM push_prefs WHERE owner = ?`)
      .all(owner.toLowerCase()) as { category: string; enabled: number }[];
    const map = new Map(rows.map((r) => [r.category, r.enabled !== 0]));
    return {
      fills: map.get("fills") ?? true,
      alerts: map.get("alerts") ?? true,
    };
  }

  set(owner: string, prefs: Partial<PushPrefs>, now: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO push_prefs (owner, category, enabled, updated_at)
       VALUES (@owner, @category, @enabled, @now)
       ON CONFLICT(owner, category) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    );
    const lower = owner.toLowerCase();
    for (const category of CATEGORIES) {
      const v = prefs[category];
      if (typeof v === "boolean") {
        stmt.run({ owner: lower, category, enabled: v ? 1 : 0, now });
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/pushPrefStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/pushPrefStore.ts server/src/push/pushPrefStore.test.ts && git commit -m "feat(push): per-owner category preference store (fills/alerts, default on)"
```

---

## Task 2: Gate `Notifier.notify` on category (atomic)

One coordinated commit: `notify` gains a `category` parameter, so every caller and
every test that calls `notify` must change together to compile.

**Files:**
- Modify: `server/src/push/notifier.ts`
- Modify: `server/src/push/notifier.test.ts`
- Modify: `server/src/push/notifyingActivityStore.ts`
- Modify: `server/src/push/notifyingActivityStore.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Update the tests to the new shape**

(a) `server/src/push/notifier.test.ts` — add the import, then change every
`notify(OWNER, () => N)` / `notify(OWNER, (locale) => ...)` call to pass a category
as the second argument, and add prefs-gating tests.

Add to the top imports (the file already imports `PushTokenRow` from `./pushTokenStore`):
```ts
import type { PushCategory } from "./pushPrefStore";
```

Replace every occurrence of `.notify(OWNER, () => N)` with `.notify(OWNER, "fills", () => N)`.
There are several such calls in the existing suite (the "no tokens", "sends to all",
"prunes", "does not prune", "filters invalid", "send chunk rejects", "correlates
tickets", and "tokensForOwner throws" tests). Also update the per-locale render test:

Replace:
```ts
    const res = await new Notifier({ expo, store }).notify(OWNER, (locale) => ({ title: locale, body: `b-${locale}`, data: {} }));
```
with:
```ts
    const res = await new Notifier({ expo, store }).notify(OWNER, "fills", (locale) => ({ title: locale, body: `b-${locale}`, data: {} }));
```

Then add these tests just before the final closing `});` of the `describe("Notifier.notify", ...)` block:
```ts
  it("skips sending entirely when the category is disabled", async () => {
    const store = fakeStore([T1, T2]);
    const expo = fakeExpo({ tickets: okTickets });
    const prefs = { isEnabled: (_o: string, _c: PushCategory) => false };
    const res = await new Notifier({ expo, store, prefs }).notify(OWNER, "fills", () => N);
    expect(res).toEqual({ tokens: 0, sent: 0, errors: 0, pruned: 0 });
    expect(expo.sends).toHaveLength(0);
  });

  it("sends when the category is enabled", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const prefs = { isEnabled: (_o: string, _c: PushCategory) => true };
    const res = await new Notifier({ expo, store, prefs }).notify(OWNER, "alerts", () => N);
    expect(res.sent).toBe(1);
  });

  it("fails open (sends) when the prefs lookup throws", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const prefs = { isEnabled: () => { throw new Error("db"); } };
    const logs: string[] = [];
    const res = await new Notifier({ expo, store, prefs, logger: (m) => logs.push(m) }).notify(OWNER, "alerts", () => N);
    expect(res.sent).toBe(1);
    expect(logs.length).toBeGreaterThan(0);
  });
```

(b) `server/src/push/notifyingActivityStore.test.ts` — the `notifierFake` records a
category; assert the fill category is passed. Replace:
```ts
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
with:
```ts
function notifierFake(opts: { throwSync?: boolean } = {}) {
  const calls: { owner: string; category: string; render: (locale: "en" | "zh") => Notification }[] = [];
  return {
    calls,
    async notify(owner: string, category: string, render: (locale: "en" | "zh") => Notification) {
      calls.push({ owner, category, render });
      if (opts.throwSync) throw new Error("boom");
      return { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    },
  };
}
```

And in the "fires a fill notification..." test, add a category assertion. Replace:
```ts
    expect(notifier.calls[0].owner).toBe(row.owner); // lowercased by inner
    expect(notifier.calls[0].render("en")).toEqual(fillNotification(row, "en"));
    expect(notifier.calls[0].render("zh")).toEqual(fillNotification(row, "zh"));
```
with:
```ts
    expect(notifier.calls[0].owner).toBe(row.owner); // lowercased by inner
    expect(notifier.calls[0].category).toBe("fills");
    expect(notifier.calls[0].render("en")).toEqual(fillNotification(row, "en"));
    expect(notifier.calls[0].render("zh")).toEqual(fillNotification(row, "zh"));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/push/notifier.test.ts src/push/notifyingActivityStore.test.ts`
Expected: FAIL — `notify` still takes `(owner, render)`; the new `prefs`/category
shapes don't compile/assert.

- [ ] **Step 3: Add category + prefs gate to `Notifier`**

In `server/src/push/notifier.ts`:

Add the import near the other `./messages` / `./pushTokenStore` imports:
```ts
import type { PushCategory, PushPrefStore } from "./pushPrefStore";
```

Add `prefs` to `NotifierDeps` (after `store`):
```ts
export interface NotifierDeps {
  expo: ExpoLike;
  store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  /** Optional per-owner category gate; when absent, all categories send. */
  prefs?: Pick<PushPrefStore, "isEnabled">;
  /** Failure log sink; defaults to console.error. */
  logger?: (msg: string, err?: unknown) => void;
  /** Token validator; defaults to the Expo push-token format regex. */
  isValidToken?: (token: string) => boolean;
}
```

Add a private field + assign it in the constructor. Replace:
```ts
  private readonly expo: ExpoLike;
  private readonly store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly isValid: (token: string) => boolean;

  constructor(deps: NotifierDeps) {
    this.expo = deps.expo;
    this.store = deps.store;
    this.log = deps.logger ?? ((msg, err) => console.error(msg, err));
    this.isValid = deps.isValidToken ?? ((t) => EXPO_PUSH_TOKEN.test(t));
  }
```
with:
```ts
  private readonly expo: ExpoLike;
  private readonly store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  private readonly prefs?: Pick<PushPrefStore, "isEnabled">;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly isValid: (token: string) => boolean;

  constructor(deps: NotifierDeps) {
    this.expo = deps.expo;
    this.store = deps.store;
    this.prefs = deps.prefs;
    this.log = deps.logger ?? ((msg, err) => console.error(msg, err));
    this.isValid = deps.isValidToken ?? ((t) => EXPO_PUSH_TOKEN.test(t));
  }
```

Change the `notify` signature and add the gate at the very top. Replace:
```ts
  async notify(owner: string, render: (locale: PushLocale) => Notification): Promise<NotifyResult> {
    const result: NotifyResult = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    let rows: PushTokenRow[];
```
with:
```ts
  async notify(owner: string, category: PushCategory, render: (locale: PushLocale) => Notification): Promise<NotifyResult> {
    const result: NotifyResult = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    if (this.prefs) {
      let enabled = true;
      try {
        enabled = this.prefs.isEnabled(owner, category);
      } catch (err) {
        this.log("push prefs lookup failed", err); // fail-open: send anyway
      }
      if (!enabled) return result; // category disabled → skip entirely
    }
    let rows: PushTokenRow[];
```

- [ ] **Step 4: Update the two callers**

(a) `server/src/push/notifyingActivityStore.ts` — pass the `fills` category. Replace:
```ts
      void Promise.resolve(this.notifier.notify(row.owner, (locale: PushLocale) => fillNotification(row, locale))).catch(() => {});
```
with:
```ts
      void Promise.resolve(this.notifier.notify(row.owner, "fills", (locale: PushLocale) => fillNotification(row, locale))).catch(() => {});
```

(b) `server/src/index.ts onHealthEvent` — pass the `alerts` category. Replace:
```ts
            void notifier.notify(owner, (l) => deadManAlertNotification(ev, l)).catch(() => {});
```
with:
```ts
            void notifier.notify(owner, "alerts", (l) => deadManAlertNotification(ev, l)).catch(() => {});
```
and replace:
```ts
            void notifier.notify(owner, (l) => deadManRecoveredNotification(l)).catch(() => {});
```
with:
```ts
            void notifier.notify(owner, "alerts", (l) => deadManRecoveredNotification(l)).catch(() => {});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd server && npx jest src/push/ && npm run typecheck`
Expected: PASS (all push suites) and `tsc` clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifier.ts server/src/push/notifier.test.ts server/src/push/notifyingActivityStore.ts server/src/push/notifyingActivityStore.test.ts server/src/index.ts && git commit -m "feat(push): gate notify() on per-owner category preference (fills/alerts)"
```

---

## Task 3: `GET/POST /push/prefs` routes + wiring

**Files:**
- Modify: `server/src/http/app.ts`
- Modify: `server/src/http/app.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write the failing route tests**

In `server/src/http/app.test.ts`, update `buildWithPush()` to also create and inject
a `pushPrefs` store, and return it. Replace:
```ts
  function buildWithPush() {
    const auth = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const pushTokens = SqlitePushTokenStore.open(":memory:");
    return { app: buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000, pushTokens }), pushTokens };
  }
```
with:
```ts
  function buildWithPush() {
    const auth = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const pushTokens = SqlitePushTokenStore.open(":memory:");
    const pushPrefs = SqlitePushPrefStore.open(":memory:");
    return { app: buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000, pushTokens, pushPrefs }), pushTokens, pushPrefs };
  }
```

Add the import at the top of the file, next to the `SqlitePushTokenStore` import:
```ts
import { SqlitePushPrefStore } from "../push/pushPrefStore";
```

Then add these tests just before the final closing `});` of the push `describe` block
(right after the "stores null locale..." test). NOTE: build the bearer header the same
way the surrounding tests do (an `authorization` header from `tokenFor(app)`); do not
copy any redacted header text.
```ts
  it("returns default prefs (all on) for a fresh owner", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "GET", url: "/push/prefs", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fills: true, alerts: true });
    await app.close();
  });

  it("persists a category toggle via POST and reflects it in GET", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const post = await app.inject({ method: "POST", url: "/push/prefs", headers: auth, payload: { fills: false } });
    expect(post.statusCode).toBe(204);
    const res = await app.inject({ method: "GET", url: "/push/prefs", headers: auth });
    expect(res.json()).toEqual({ fills: false, alerts: true });
    await app.close();
  });

  it("rejects a non-boolean pref value with 400", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "POST", url: "/push/prefs", headers: { authorization: `Bearer ${token}` }, payload: { fills: "yes" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects /push/prefs without a bearer token", async () => {
    const { app } = buildWithPush();
    const res = await app.inject({ method: "GET", url: "/push/prefs" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 for /push/prefs when push is not configured", async () => {
    const app = build();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "GET", url: "/push/prefs", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/http/app.test.ts`
Expected: FAIL — `pushPrefs` is not a known `buildApp` dep and the routes 404.

- [ ] **Step 3: Add the `pushPrefs` dep type**

In `server/src/http/app.ts`, add the import next to the other push import:
```ts
import type { PushPrefStore } from "../push/pushPrefStore";
```
and add the optional dep to the `AppDeps` interface, next to `pushTokens?: PushTokenStore;`:
```ts
  pushPrefs?: PushPrefStore;
```

- [ ] **Step 4: Add the routes**

In `server/src/http/app.ts`, immediately after the `/push/unregister` handler
(the block ending with `if (typeof token === "string") deps.pushTokens.unregister(owner, token); return reply.code(204).send();`),
add:
```ts
  app.get("/push/prefs", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    if (!deps.pushPrefs) return reply.code(503).send({ error: "push not configured" });
    return deps.pushPrefs.get(owner);
  });

  app.post("/push/prefs", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    if (!deps.pushPrefs) return reply.code(503).send({ error: "push not configured" });
    const body = (req.body ?? {}) as { fills?: unknown; alerts?: unknown };
    const prefs: { fills?: boolean; alerts?: boolean } = {};
    for (const key of ["fills", "alerts"] as const) {
      const v = body[key];
      if (v === undefined) continue;
      if (typeof v !== "boolean") return reply.code(400).send({ error: `invalid ${key}` });
      prefs[key] = v;
    }
    deps.pushPrefs.set(owner, prefs, now());
    return reply.code(204).send();
  });
```

- [ ] **Step 5: Run app tests + typecheck**

Run: `cd server && npx jest src/http/app.test.ts && npm run typecheck`
Expected: PASS (new prefs tests + existing) and `tsc` clean.

- [ ] **Step 6: Wire the store in `index.ts`**

In `server/src/index.ts`, add the import next to the `SqlitePushTokenStore` import:
```ts
import { SqlitePushPrefStore } from "./push/pushPrefStore";
```

Replace:
```ts
  const pushTokens = SqlitePushTokenStore.open(dbPath);
  const notifier = new Notifier({ expo: new Expo(), store: pushTokens });
```
with:
```ts
  const pushTokens = SqlitePushTokenStore.open(dbPath);
  const pushPrefs = SqlitePushPrefStore.open(dbPath);
  const notifier = new Notifier({ expo: new Expo(), store: pushTokens, prefs: pushPrefs });
```

Then add `pushPrefs` to the `buildApp({ ... })` call. Replace:
```ts
  const app = buildApp({ auth, agents, store, activity, pushTokens, now, version: VERSION, logger: process.env.LOG_REQUESTS === "1", appConfig: appConfigFromEnv(process.env), geoHeaders: geoHeadersFromEnv(process.env) });
```
with:
```ts
  const app = buildApp({ auth, agents, store, activity, pushTokens, pushPrefs, now, version: VERSION, logger: process.env.LOG_REQUESTS === "1", appConfig: appConfigFromEnv(process.env), geoHeaders: geoHeadersFromEnv(process.env) });
```

- [ ] **Step 7: Run full server suite + typecheck**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; all suites pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/http/app.ts server/src/http/app.test.ts server/src/index.ts && git commit -m "feat(push): GET/POST /push/prefs routes + wire pref store into notifier"
```

---

## Task 4: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md` (M7 row: note P5b-server landed)

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, find the deferred fragment `P5b 分类开关` in the
M7 row and replace it with a landed note. Replace:
```
（切语言后需重开推送才更新，YAGNI）；P5b 分类开关
```
with:
```
（切语言后需重开推送才更新，YAGNI）；P5b-server 分类开关落地：`push_prefs(owner,category,enabled)` 偏好存储（缺省全开）+ `Notifier.notify(owner, category, render)` 按 owner 类别拦截（禁用→跳过、prefs 抛错 fail-open）+ `GET/POST /push/prefs` 路由，类别 fills/alerts（P5b-mobile 子开关 UI 待做）；P5c 免打扰
```

(If the current text reads `P5b 分类开关、P5c 免打扰` instead, adapt by replacing
`P5b 分类开关` only and leaving the rest intact.)

- [ ] **Step 2: Full server validation**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; full jest suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P5b-server category preferences landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-categories-server
gh pr create --title "feat(push): M7 P5b-server — per-category push preferences (fills/alerts)" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** PushPrefStore (schema + isEnabled/get/set, default-on) → Task 1.
Notifier category param + optional prefs gate + fail-open → Task 2 Steps 3. Callers
(fills/alerts) → Task 2 Step 4. GET/POST /push/prefs (defaults, boolean validation,
503, 401) → Task 3 Steps 1,4. Wiring → Task 3 Step 6. Roadmap/out-of-scope → Task 4.
No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after. (Task 4
Step 4 PR body-file is composed at execution time; the app.test bearer header is
described rather than pasted due to the view/edit redaction of `Bearer` literals.)

**Type consistency:** `PushCategory = "fills" | "alerts"` and `PushPrefs { fills, alerts }`
are used identically across pushPrefStore.ts, notifier.ts (`Pick<PushPrefStore,"isEnabled">`),
app.ts (`PushPrefStore`), and the tests. `notify(owner, category, render)` is applied
uniformly in notifier.ts, notifyingActivityStore.ts (`"fills"`), index.ts (`"alerts"`),
and the notifierFake. `SqlitePushPrefStore.open(":memory:")` matches `SqlitePushTokenStore.open`.
