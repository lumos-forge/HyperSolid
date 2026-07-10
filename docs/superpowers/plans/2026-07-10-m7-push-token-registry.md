# M7 P1 —— 设备推送令牌注册表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the server-side push-token registry (`server/`, TS): a `PushTokenStore` interface + `SqlitePushTokenStore`, plus two authenticated Fastify routes (`POST /push/register`, `POST /push/unregister`) where the owner comes from the verified wallet session and Expo push tokens upsert by token (re-binding owner on wallet switch).

**Architecture:** Pure server storage + HTTP. A `PushTokenStore` interface with a `SqlitePushTokenStore` (better-sqlite3, WAL, idempotent `migrate`) keyed by `token` with `ON CONFLICT(token) DO UPDATE` upsert that rebinds `owner`. Two routes reuse the existing `ownerOf` bearer-auth helper (owner never from body); registration validates the Expo push-token format and fails closed. `pushTokens` is an optional `AppDeps` dependency (503 when unconfigured), wired in `index.ts` on the shared `dbPath`. No sending, no mobile, no event wiring (P2–P4).

**Tech Stack:** TypeScript, Fastify 4, better-sqlite3 11, jest + ts-jest, viem (test auth). No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-07-10-m7-push-token-registry-design.md`

**Branch:** `feat/m7-push-token-registry` (already created; spec already committed on it).

**Verified facts (do not re-derive):**
- Store pattern: `server/src/strategies/sqliteStore.ts` — `import Database from "better-sqlite3"`, `Database(path)`, `db.pragma("journal_mode = WAL")`, idempotent `migrate(db)` with `CREATE TABLE IF NOT EXISTS`, `static open(path, now?)`. Owner matching is case-insensitive.
- Route/auth pattern: `server/src/http/app.ts` — `ownerOf(req, reply)` reads `Authorization: Bearer <token>`, calls `deps.auth.verify(token, now())`, sends `reply.code(401).send({ error: "unauthorized" })` and returns `null` on failure. Success routes use `reply.code(204).send()`. Optional deps exist (`activity?`). `AppDeps` is the injected deps interface.
- Test harness: `server/src/http/app.test.ts` — `build()` calls `buildApp({ auth, agents, store, now, agentTtlMs })` with `Memory*` stores; `tokenFor(app)` mints a bearer via `/auth/challenge` → `account.signMessage({message: nonce})` → `/auth/session`; requests use `app.inject({ method, url, headers, payload })`. `PK`/`account` from `viem/accounts`.
- Production wiring: `server/src/index.ts` — `const dbPath = process.env.DB_PATH ?? "strategies.db"`; stores opened via `SqliteXStore.open(dbPath, ...)`; `buildApp({ auth, agents, store, activity, now, version, logger, appConfig, geoHeaders })` at the end.
- Scripts: `server/package.json` — `npm run typecheck` = `tsc --noEmit`; `npm test` = `jest`. better-sqlite3 supports `":memory:"` and `ON CONFLICT ... DO UPDATE` (SQLite 3.24+).

---

## File Structure

- Create: `server/src/push/pushTokenStore.ts` — `PushTokenRow`, `PushTokenStore` interface, `SqlitePushTokenStore`.
- Create: `server/src/push/pushTokenStore.test.ts` — store unit tests (`:memory:`).
- Modify: `server/src/http/app.ts` — add `pushTokens?: PushTokenStore` to `AppDeps`; add `/push/register` + `/push/unregister`; add `isExpoPushToken` validator.
- Modify: `server/src/http/app.test.ts` — push route tests.
- Modify: `server/src/index.ts` — wire `SqlitePushTokenStore.open(dbPath)`.
- Modify: `docs/BACKEND-ARCHITECTURE.md` — note M7 P1 landed + server/TS+Expo deviation.

---

## Task 1: `PushTokenStore` + `SqlitePushTokenStore`

**Files:**
- Create: `server/src/push/pushTokenStore.ts`
- Test: `server/src/push/pushTokenStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/pushTokenStore.test.ts`:

```ts
import { SqlitePushTokenStore } from "./pushTokenStore";

const T1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const T2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

function store(now = () => 1000) {
  return SqlitePushTokenStore.open(":memory:", now);
}

describe("SqlitePushTokenStore", () => {
  it("registers a token and lists it for the owner", () => {
    const s = store(() => 1000);
    s.register(A, T1, "ios", 1000);
    const rows = s.tokensForOwner(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: T1, owner: A, platform: "ios", createdAt: 1000, updatedAt: 1000 });
  });

  it("re-registering the same token rebinds owner and keeps createdAt", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    s.register(B, T1, "android", 2000); // same token, new owner
    expect(s.tokensForOwner(A)).toHaveLength(0);
    const rows = s.tokensForOwner(B);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: T1, owner: B, platform: "android", createdAt: 1000, updatedAt: 2000 });
  });

  it("keeps multiple tokens for one owner", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    s.register(A, T2, "ios", 1000);
    expect(s.tokensForOwner(A).map((r) => r.token).sort()).toEqual([T1, T2].sort());
  });

  it("unregister removes only the owner's token", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    expect(s.unregister(B, T1)).toBe(false); // not B's token
    expect(s.tokensForOwner(A)).toHaveLength(1);
    expect(s.unregister(A, T1)).toBe(true);
    expect(s.tokensForOwner(A)).toHaveLength(0);
  });

  it("deleteToken removes unconditionally", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    s.deleteToken(T1);
    expect(s.tokensForOwner(A)).toHaveLength(0);
  });

  it("matches owner case-insensitively", () => {
    const s = store();
    s.register("0xABCabc0000000000000000000000000000000001", T1, "ios", 1000);
    expect(s.tokensForOwner("0xabcabc0000000000000000000000000000000001")).toHaveLength(1);
    expect(s.unregister("0xABCABC0000000000000000000000000000000001", T1)).toBe(true);
  });

  it("stores null platform when omitted", () => {
    const s = store();
    s.register(A, T1, null, 1000);
    expect(s.tokensForOwner(A)[0].platform).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/pushTokenStore.test.ts`
Expected: FAIL — cannot find module `./pushTokenStore` (not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `server/src/push/pushTokenStore.ts`:

```ts
import Database from "better-sqlite3";

export interface PushTokenRow {
  token: string;
  owner: string;
  platform: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PushTokenStore {
  /** Upsert by token; on conflict rebind owner + refresh platform/updatedAt. */
  register(owner: string, token: string, platform: string | null, now: number): void;
  /** Delete only if the token belongs to owner. Returns true when a row was deleted. */
  unregister(owner: string, token: string): boolean;
  /** All tokens currently bound to owner (for P2 fan-out). */
  tokensForOwner(owner: string): PushTokenRow[];
  /** Unconditional delete by token (for P2 invalid-token pruning). */
  deleteToken(token: string): void;
}

interface DbRow {
  token: string;
  owner: string;
  platform: string | null;
  created_at: number;
  updated_at: number;
}

function toRow(r: DbRow): PushTokenRow {
  return { token: r.token, owner: r.owner, platform: r.platform, createdAt: r.created_at, updatedAt: r.updated_at };
}

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
}

/** Durable PushTokenStore over SQLite. Owner matching is case-insensitive. */
export class SqlitePushTokenStore implements PushTokenStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqlitePushTokenStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqlitePushTokenStore(db);
  }

  register(owner: string, token: string, platform: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO push_tokens (token, owner, platform, created_at, updated_at)
         VALUES (@token, @owner, @platform, @now, @now)
         ON CONFLICT(token) DO UPDATE SET
           owner = excluded.owner,
           platform = excluded.platform,
           updated_at = excluded.updated_at`,
      )
      .run({ token, owner: owner.toLowerCase(), platform, now });
  }

  unregister(owner: string, token: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM push_tokens WHERE token = ? AND owner = ?`)
      .run(token, owner.toLowerCase());
    return info.changes > 0;
  }

  tokensForOwner(owner: string): PushTokenRow[] {
    const rows = this.db
      .prepare(`SELECT token, owner, platform, created_at, updated_at FROM push_tokens WHERE owner = ?`)
      .all(owner.toLowerCase()) as DbRow[];
    return rows.map(toRow);
  }

  deleteToken(token: string): void {
    this.db.prepare(`DELETE FROM push_tokens WHERE token = ?`).run(token);
  }
}
```

Note the store signature takes `SqlitePushTokenStore.open(path)`; the test calls `open(":memory:", now)` with a second arg — SQLite ignores the extra `now` arg harmlessly? No: TypeScript will error on the extra arg. Fix the test call to `SqlitePushTokenStore.open(":memory:")` (remove the `now` param) — the store takes `now` per-call via `register(..., now)`, not at open. Update the test's `store()` helper accordingly:

```ts
function store() {
  return SqlitePushTokenStore.open(":memory:");
}
```

and drop the `now` argument everywhere `store(...)` is called (call `store()`), since each `register` already passes its own `now`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/pushTokenStore.test.ts && npm run typecheck`
Expected: PASS (all 7 store tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/pushTokenStore.ts server/src/push/pushTokenStore.test.ts && \
  git commit -m "feat(push): SqlitePushTokenStore with upsert-rebind by token"
```

---

## Task 2: authed `/push/register` + `/push/unregister` routes

**Files:**
- Modify: `server/src/http/app.ts`
- Test: `server/src/http/app.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/http/app.test.ts`. First add the import at the top (with the other imports):

```ts
import { SqlitePushTokenStore } from "../push/pushTokenStore";
```

Then add a push-enabled app builder and tests inside the `describe("HTTP app", ...)` block:

```ts
  function buildWithPush() {
    const auth = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const pushTokens = SqlitePushTokenStore.open(":memory:");
    return { app: buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000, pushTokens }), pushTokens };
  }

  const PUSH_T = "ExponentPushToken[cccccccccccccccccccccc]";

  it("rejects /push/register without a bearer token", async () => {
    const { app } = buildWithPush();
    const res = await app.inject({ method: "POST", url: "/push/register", payload: { token: PUSH_T } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("registers a push token for the authed owner", async () => {
    const { app, pushTokens } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({
      method: "POST",
      url: "/push/register",
      headers: { authorization: `****** },
      payload: { token: PUSH_T, platform: "ios" },
    });
    expect(res.statusCode).toBe(204);
    expect(pushTokens.tokensForOwner(account.address).map((r) => r.token)).toEqual([PUSH_T]);
    await app.close();
  });

  it("rejects a malformed push token with 400", async () => {
    const { app, pushTokens } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({
      method: "POST",
      url: "/push/register",
      headers: { authorization: `****** },
      payload: { token: "not-a-push-token" },
    });
    expect(res.statusCode).toBe(400);
    expect(pushTokens.tokensForOwner(account.address)).toHaveLength(0);
    await app.close();
  });

  it("unregister is scoped to the owner and idempotent", async () => {
    const { app, pushTokens } = buildWithPush();
    const token = await tokenFor(app);
    const auth = { authorization: `****** };
    await app.inject({ method: "POST", url: "/push/register", headers: auth, payload: { token: PUSH_T } });
    // Unregister a token that isn't registered → still 204, no throw.
    const other = await app.inject({ method: "POST", url: "/push/unregister", headers: auth, payload: { token: "ExponentPushToken[zzzzzzzzzzzzzzzzzzzzzz]" } });
    expect(other.statusCode).toBe(204);
    expect(pushTokens.tokensForOwner(account.address)).toHaveLength(1);
    // Unregister the real token → 204 and gone.
    const res = await app.inject({ method: "POST", url: "/push/unregister", headers: auth, payload: { token: PUSH_T } });
    expect(res.statusCode).toBe(204);
    expect(pushTokens.tokensForOwner(account.address)).toHaveLength(0);
    await app.close();
  });

  it("returns 503 when push is not configured", async () => {
    const app = build(); // no pushTokens
    const token = await tokenFor(app);
    const res = await app.inject({ method: "POST", url: "/push/register", headers: { authorization: `****** }, payload: { token: PUSH_T } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/http/app.test.ts -t push`
Expected: FAIL — `buildApp` has no `pushTokens` dep and the `/push/*` routes 404, so the assertions (204/400/503) fail.

- [ ] **Step 3: Write minimal implementation**

In `server/src/http/app.ts`:

(a) Add the import near the other type imports:

```ts
import type { PushTokenStore } from "../push/pushTokenStore";
```

(b) Add the optional dep to `AppDeps` (alongside `activity?`):

```ts
  /** Device push-token registry (M7 P1). When absent, /push/* routes return 503. */
  pushTokens?: PushTokenStore;
```

(c) Add a module-level validator (near the top of the file, e.g. after imports):

```ts
const EXPO_PUSH_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;
function isExpoPushToken(v: unknown): v is string {
  return typeof v === "string" && EXPO_PUSH_TOKEN.test(v);
}
```

(d) Register the routes (place them after the agent routes block, before `return app` — anywhere inside `buildApp` after `ownerOf` is defined):

```ts
  // --- push token registry (M7 P1) ---
  app.post("/push/register", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    if (!deps.pushTokens) return reply.code(503).send({ error: "push not configured" });
    const { token, platform } = (req.body ?? {}) as { token?: unknown; platform?: unknown };
    if (!isExpoPushToken(token)) return reply.code(400).send({ error: "invalid push token" });
    const plat = platform === "ios" || platform === "android" ? platform : null;
    deps.pushTokens.register(owner, token, plat, now());
    return reply.code(204).send();
  });

  app.post("/push/unregister", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    if (!deps.pushTokens) return reply.code(503).send({ error: "push not configured" });
    const { token } = (req.body ?? {}) as { token?: unknown };
    if (typeof token === "string") deps.pushTokens.unregister(owner, token);
    return reply.code(204).send();
  });
```

Note: `now` is the local `now` used elsewhere in `buildApp` (`const now = deps.now ?? (() => Date.now())` — confirm the exact name by reading the file; reuse it). If the handler is reached with a valid owner but no `pushTokens`, the 503 comes AFTER the 401 check, matching the spec's precedence (auth first).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/http/app.test.ts && npm run typecheck`
Expected: PASS (new push route tests + all existing app tests unchanged); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/http/app.ts server/src/http/app.test.ts && \
  git commit -m "feat(push): authed /push/register + /push/unregister (owner from session)"
```

---

## Task 3: production wiring + roadmap doc

**Files:**
- Modify: `server/src/index.ts`
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Wire the store in index.ts**

In `server/src/index.ts`:

(a) Add the import with the other store imports:

```ts
import { SqlitePushTokenStore } from "./push/pushTokenStore";
```

(b) After the existing store construction (near `const activity = SqliteActivityStore.open(dbPath);`), add:

```ts
  const pushTokens = SqlitePushTokenStore.open(dbPath);
```

(c) Add `pushTokens` to the `buildApp({...})` call (the one with `auth, agents, store, activity, ...`):

```ts
  const app = buildApp({ auth, agents, store, activity, pushTokens, now, version: VERSION, logger: process.env.LOG_REQUESTS === "1", appConfig: appConfigFromEnv(process.env), geoHeaders: geoHeadersFromEnv(process.env) });
```

- [ ] **Step 2: Typecheck + build**

Run: `cd server && npm run typecheck && npx tsc`
Expected: both clean (the `pushTokens` dep type-checks; `tsc` build succeeds).

- [ ] **Step 3: Update the roadmap doc**

In `docs/BACKEND-ARCHITECTURE.md`, update the M7 row (line ~36) to note P1 landed and the server/TS + Expo deviation. Locate the M7 row:

```
| **M7** | 推送服务 | APNs/FCM；自动交易/触发/熔断、授权健康告警（§5.3/§6）| 否 | 通知缺失 | **Go** |
```

Replace it with:

```
| **M7** | 推送服务 | APNs/FCM；自动交易/触发/熔断、授权健康告警（§5.3/§6）**【状态：起步 —— 落 server/(TS) + Expo Push Service（非原生 APNs/FCM，Expo 官方路径、与事件源同位）；P1 设备令牌注册表落地：authed `/push/register`·`/push/unregister`，owner 取自钱包会话，Expo token 主键 upsert 重绑（`server/src/push/pushTokenStore.ts`）；P2 通知核心+传输、P3 mobile 注册、P4 事件接线+偏好 待做】** | 否 | 通知缺失 | **TS（server/，改自原 Go 规划）** |
```

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/index.ts docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "feat(push): wire push token store in index.ts + roadmap M7 P1"
```

---

## Task 4: final validation + PR

**Files:** none (validation + PR only)

- [ ] **Step 1: Full server validation**

Run:
```bash
cd server && npm run typecheck && npx jest src/push/ src/http/app.test.ts
```
Expected: typecheck clean; all push store + app tests pass.

- [ ] **Step 2: Run the full server test suite (no regressions)**

Run: `cd server && npm test`
Expected: the whole jest suite passes (push additions did not break existing tests).

- [ ] **Step 3: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-token-registry && \
  gh pr create --title "feat(server): M7 P1 设备推送令牌注册表（Expo push token）" \
    --body "M7 推送子项目 P1。server 端推送令牌注册表：\`SqlitePushTokenStore\`（token 主键 upsert，重注册重绑 owner）+ authed \`POST /push/register\`·\`/push/unregister\`（owner 取自钱包签名会话，绝不信 body；Expo token 格式 fail-closed）。架构偏离记录：M7 落 server/(TS) + Expo Push Service（非路线图 Go/原生 APNs/FCM）。纯注册表，无发送/无 mobile/无事件接线（P2-P4）。Spec: docs/superpowers/specs/2026-07-10-m7-push-token-registry-design.md"
```
Expected: PR created.

- [ ] **Step 4: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §3 data model → Task 1 (migrate/table); §4 store interface + upsert-rebind → Task 1; §5 routes (register/unregister, auth, 400/401/503/204) → Task 2; §6 DI + index wiring (shared dbPath) → Tasks 2–3; §7 tests (store 1–6, routes 7–12) → Tasks 1–2; §8 validation → Task 4; §1.1 roadmap deviation note → Task 3. All covered.
- **Placeholder scan:** every step has complete code. Task 1 Step 3 includes an explicit correction to the test's `store()` helper (drop the stray `now` arg) so the store signature (`open(path)`) and test agree.
- **Type consistency:** `PushTokenRow` (token/owner/platform/createdAt/updatedAt), `PushTokenStore` methods (`register(owner,token,platform,now)`, `unregister(owner,token):boolean`, `tokensForOwner(owner):PushTokenRow[]`, `deleteToken(token)`), `AppDeps.pushTokens?`, validator `isExpoPushToken`, route paths `/push/register`·`/push/unregister` — identical across store, routes, wiring, and tests, and match the spec.
- **Auth precedence:** routes call `ownerOf` (401) BEFORE the `pushTokens` 503 check, matching spec §5.3 (auth first). Owner always from session, never body.
- **No-regression:** `pushTokens` is optional; existing `build()` (no pushTokens) still constructs the app, and the 503 test asserts the unconfigured path.
