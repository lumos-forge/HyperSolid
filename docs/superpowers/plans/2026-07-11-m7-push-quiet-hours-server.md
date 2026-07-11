# M7 P5c-server — Quiet Hours (server) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-owner, timezone-aware daily quiet-hours window that suppresses only `fills` notifications during the window; `alerts` always send.

**Architecture:** A pure `isWithinQuietHours(qh, nowMs)` (IANA-tz minute-of-day math), a SQLite `QuietHoursStore` (per-owner row, default disabled), a `fills`-only gate in `Notifier.notify` behind optional `quietHours` + `now` deps (fail-open), and authed `GET/POST /push/quiet-hours` routes. No change to `notify`'s signature, so callers are untouched.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, `Intl.DateTimeFormat`, jest.

Spec: `docs/superpowers/specs/2026-07-11-m7-push-quiet-hours-server-design.md`

---

## Task 1: `pushQuietHours` pure logic

**Files:**
- Create: `server/src/push/pushQuietHours.ts`
- Create: `server/src/push/pushQuietHours.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/pushQuietHours.test.ts`:
```ts
import { isWithinQuietHours, minuteOfDayInTz, type QuietHours } from "./pushQuietHours";

const AT = (tz: string, over: Partial<QuietHours> = {}): QuietHours => ({ enabled: true, start: 0, end: 0, tz, ...over });
// 2026-01-01T00:00:00Z: UTC minute-of-day 0; Asia/Shanghai (UTC+8) = 480.
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("minuteOfDayInTz", () => {
  it("computes local minute-of-day for a timezone", () => {
    expect(minuteOfDayInTz(T0, "UTC")).toBe(0);
    expect(minuteOfDayInTz(T0, "Asia/Shanghai")).toBe(480);
  });
});

describe("isWithinQuietHours", () => {
  it("same-day window: inside vs outside", () => {
    expect(isWithinQuietHours(AT("Asia/Shanghai", { start: 470, end: 490 }), T0)).toBe(true);  // 480 in [470,490)
    expect(isWithinQuietHours(AT("Asia/Shanghai", { start: 481, end: 490 }), T0)).toBe(false); // 480 < 481
  });

  it("same window differs by timezone", () => {
    const qh = { enabled: true, start: 470, end: 490 } as const;
    expect(isWithinQuietHours({ ...qh, tz: "Asia/Shanghai" }, T0)).toBe(true); // 480 in window
    expect(isWithinQuietHours({ ...qh, tz: "UTC" }, T0)).toBe(false);          // 0 not in window
  });

  it("overnight window wraps midnight", () => {
    // 23:00–07:00 UTC. At UTC 00:00 (m=0) → inside; at UTC 10:00 → outside.
    const qh = AT("UTC", { start: 1380, end: 420 });
    expect(isWithinQuietHours(qh, T0)).toBe(true);
    expect(isWithinQuietHours(qh, Date.UTC(2026, 0, 1, 10, 0, 0))).toBe(false);
  });

  it("disabled → false", () => {
    expect(isWithinQuietHours(AT("UTC", { enabled: false, start: 0, end: 1000 }), T0)).toBe(false);
  });

  it("empty window (start === end) → false", () => {
    expect(isWithinQuietHours(AT("UTC", { start: 300, end: 300 }), T0)).toBe(false);
  });

  it("unparseable timezone → false (fail-open)", () => {
    expect(isWithinQuietHours(AT("Not/AZone", { start: 0, end: 1439 }), T0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/pushQuietHours.test.ts`
Expected: FAIL — `Cannot find module './pushQuietHours'`.

- [ ] **Step 3: Implement the pure logic**

Create `server/src/push/pushQuietHours.ts`:
```ts
export interface QuietHours {
  enabled: boolean;
  start: number; // minute-of-day 0..1439, local (tz) time
  end: number;   // minute-of-day 0..1439, local (tz) time
  tz: string;    // IANA timezone
}

/** Current minute-of-day (0..1439) in the given IANA timezone; throws RangeError on a bad tz. */
export function minuteOfDayInTz(nowMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(nowMs));
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

/** True when nowMs is inside the quiet window. Fail-open: disabled, empty
 *  (start===end), or an unparseable tz all return false (not quiet → send). */
export function isWithinQuietHours(qh: QuietHours, nowMs: number): boolean {
  if (!qh.enabled || qh.start === qh.end) return false;
  let m: number;
  try {
    m = minuteOfDayInTz(nowMs, qh.tz);
  } catch {
    return false; // bad tz → don't suppress
  }
  return qh.start < qh.end
    ? m >= qh.start && m < qh.end          // same-day window
    : m >= qh.start || m < qh.end;         // overnight (wraps midnight)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/pushQuietHours.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/pushQuietHours.ts server/src/push/pushQuietHours.test.ts && git commit -m "feat(push): tz-aware quiet-hours window logic (fills suppression)"
```

---

## Task 2: `QuietHoursStore` (SQLite)

**Files:**
- Create: `server/src/push/pushQuietHoursStore.ts`
- Create: `server/src/push/pushQuietHoursStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/pushQuietHoursStore.test.ts`:
```ts
import { SqliteQuietHoursStore } from "./pushQuietHoursStore";

const OWNER = "0xABCDEF0000000000000000000000000000000009";

describe("SqliteQuietHoursStore", () => {
  it("returns a disabled default on a fresh db", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    expect(s.get(OWNER)).toEqual({ enabled: false, start: 0, end: 0, tz: "UTC" });
  });

  it("round-trips a set config", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    s.set(OWNER, { enabled: true, start: 1380, end: 420, tz: "Asia/Shanghai" }, 1000);
    expect(s.get(OWNER)).toEqual({ enabled: true, start: 1380, end: 420, tz: "Asia/Shanghai" });
  });

  it("isQuietNow reflects an enabled window and false when disabled", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    const noon = Date.UTC(2026, 0, 1, 12, 0, 0); // UTC minute-of-day 720
    s.set(OWNER, { enabled: true, start: 0, end: 1439, tz: "UTC" }, 1000);
    expect(s.isQuietNow(OWNER, noon)).toBe(true);
    s.set(OWNER, { enabled: false, start: 0, end: 1439, tz: "UTC" }, 2000);
    expect(s.isQuietNow(OWNER, noon)).toBe(false);
  });

  it("matches owner case-insensitively", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    s.set(OWNER, { enabled: true, start: 0, end: 100, tz: "UTC" }, 1000);
    expect(s.get(OWNER.toLowerCase()).enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/pushQuietHoursStore.test.ts`
Expected: FAIL — `Cannot find module './pushQuietHoursStore'`.

- [ ] **Step 3: Implement the store**

Create `server/src/push/pushQuietHoursStore.ts`:
```ts
import Database from "better-sqlite3";
import { isWithinQuietHours, type QuietHours } from "./pushQuietHours";

export interface QuietHoursStore {
  /** Absent row → { enabled:false, start:0, end:0, tz:"UTC" }. */
  get(owner: string): QuietHours;
  set(owner: string, qh: QuietHours, now: number): void;
  /** Effective suppression check now; false (send) on any error. */
  isQuietNow(owner: string, nowMs: number): boolean;
}

interface DbRow {
  enabled: number;
  start_min: number;
  end_min: number;
  tz: string;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_quiet_hours (
      owner TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      tz TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

const DEFAULT: QuietHours = { enabled: false, start: 0, end: 0, tz: "UTC" };

/** Durable per-owner quiet-hours config over SQLite. Owner match is case-insensitive.
 *  A missing row means "disabled" (never suppresses). */
export class SqliteQuietHoursStore implements QuietHoursStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqliteQuietHoursStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqliteQuietHoursStore(db);
  }

  get(owner: string): QuietHours {
    const row = this.db
      .prepare(`SELECT enabled, start_min, end_min, tz FROM push_quiet_hours WHERE owner = ?`)
      .get(owner.toLowerCase()) as DbRow | undefined;
    if (!row) return { ...DEFAULT };
    return { enabled: row.enabled !== 0, start: row.start_min, end: row.end_min, tz: row.tz };
  }

  set(owner: string, qh: QuietHours, now: number): void {
    this.db
      .prepare(
        `INSERT INTO push_quiet_hours (owner, enabled, start_min, end_min, tz, updated_at)
         VALUES (@owner, @enabled, @start, @end, @tz, @now)
         ON CONFLICT(owner) DO UPDATE SET
           enabled = excluded.enabled,
           start_min = excluded.start_min,
           end_min = excluded.end_min,
           tz = excluded.tz,
           updated_at = excluded.updated_at`,
      )
      .run({ owner: owner.toLowerCase(), enabled: qh.enabled ? 1 : 0, start: qh.start, end: qh.end, tz: qh.tz, now });
  }

  isQuietNow(owner: string, nowMs: number): boolean {
    try {
      return isWithinQuietHours(this.get(owner), nowMs);
    } catch {
      return false; // fail-open
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/pushQuietHoursStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/pushQuietHoursStore.ts server/src/push/pushQuietHoursStore.test.ts && git commit -m "feat(push): SQLite quiet-hours store (per-owner, default disabled)"
```

---

## Task 3: `fills`-only quiet-hours gate in `Notifier`

`notify`'s signature is unchanged (only new optional deps), so callers/tests outside
this file are untouched.

**Files:**
- Modify: `server/src/push/notifier.ts`
- Modify: `server/src/push/notifier.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/src/push/notifier.test.ts`, add these tests just before the final `});`
that closes the `describe("Notifier.notify", ...)` block:
```ts
  it("suppresses fills during quiet hours", async () => {
    const store = fakeStore([T1, T2]);
    const expo = fakeExpo({ tickets: okTickets });
    const quietHours = { isQuietNow: () => true };
    const res = await new Notifier({ expo, store, quietHours, now: () => 0 }).notify(OWNER, "fills", () => N);
    expect(res).toEqual({ tokens: 0, sent: 0, errors: 0, pruned: 0 });
    expect(expo.sends).toHaveLength(0);
  });

  it("sends fills outside quiet hours", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const quietHours = { isQuietNow: () => false };
    const res = await new Notifier({ expo, store, quietHours, now: () => 0 }).notify(OWNER, "fills", () => N);
    expect(res.sent).toBe(1);
  });

  it("always sends alerts even during quiet hours", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const quietHours = { isQuietNow: () => true };
    const res = await new Notifier({ expo, store, quietHours, now: () => 0 }).notify(OWNER, "alerts", () => N);
    expect(res.sent).toBe(1);
  });

  it("fails open (sends fills) when the quiet-hours check throws", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const quietHours = { isQuietNow: () => { throw new Error("db"); } };
    const logs: string[] = [];
    const res = await new Notifier({ expo, store, quietHours, now: () => 0, logger: (m) => logs.push(m) }).notify(OWNER, "fills", () => N);
    expect(res.sent).toBe(1);
    expect(logs.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/push/notifier.test.ts`
Expected: FAIL — `NotifierDeps` has no `quietHours`/`now`; TS compile error / suppression not applied.

- [ ] **Step 3: Add the deps and the gate**

In `server/src/push/notifier.ts`, add `quietHours` and `now` to `NotifierDeps`
(after `prefs`):
```ts
export interface NotifierDeps {
  expo: ExpoLike;
  store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  /** Optional per-owner category gate; when absent, all categories send. */
  prefs?: Pick<PushPrefStore, "isEnabled">;
  /** Optional quiet-hours gate; only fills are suppressed. */
  quietHours?: { isQuietNow(owner: string, nowMs: number): boolean };
  /** Clock for quiet-hours evaluation; defaults to Date.now. */
  now?: () => number;
  /** Failure log sink; defaults to console.error. */
  logger?: (msg: string, err?: unknown) => void;
  /** Token validator; defaults to the Expo push-token format regex. */
  isValidToken?: (token: string) => boolean;
}
```

Add the private fields + assign them in the constructor. Replace:
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
with:
```ts
  private readonly expo: ExpoLike;
  private readonly store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  private readonly prefs?: Pick<PushPrefStore, "isEnabled">;
  private readonly quietHours?: { isQuietNow(owner: string, nowMs: number): boolean };
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly isValid: (token: string) => boolean;

  constructor(deps: NotifierDeps) {
    this.expo = deps.expo;
    this.store = deps.store;
    this.prefs = deps.prefs;
    this.quietHours = deps.quietHours;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? ((msg, err) => console.error(msg, err));
    this.isValid = deps.isValidToken ?? ((t) => EXPO_PUSH_TOKEN.test(t));
  }
```

Add the gate immediately after the existing category (`prefs`) gate block — i.e.
right after the `if (!enabled) return result; }` that closes the `if (this.prefs)`
block, and before `let rows: PushTokenRow[];`:
```ts
    if (category === "fills" && this.quietHours) {
      try {
        if (this.quietHours.isQuietNow(owner, this.now())) return result; // quiet → skip fills
      } catch (err) {
        this.log("push quiet-hours lookup failed", err); // fail-open: send anyway
      }
    }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd server && npx jest src/push/notifier.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifier.ts server/src/push/notifier.test.ts && git commit -m "feat(push): suppress fills during quiet hours (alerts bypass, fail-open)"
```

---

## Task 4: `GET/POST /push/quiet-hours` routes + wiring

**Files:**
- Modify: `server/src/http/app.ts`
- Modify: `server/src/http/app.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write the failing route tests**

In `server/src/http/app.test.ts`, add the import next to the other push-store imports:
```ts
import { SqliteQuietHoursStore } from "../push/pushQuietHoursStore";
```

Update `buildWithPush()` to create and inject a quiet-hours store and return it.
Replace:
```ts
    const pushTokens = SqlitePushTokenStore.open(":memory:");
    const pushPrefs = SqlitePushPrefStore.open(":memory:");
    return { app: buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000, pushTokens, pushPrefs }), pushTokens, pushPrefs };
```
with:
```ts
    const pushTokens = SqlitePushTokenStore.open(":memory:");
    const pushPrefs = SqlitePushPrefStore.open(":memory:");
    const quietHours = SqliteQuietHoursStore.open(":memory:");
    return { app: buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000, pushTokens, pushPrefs, quietHours }), pushTokens, pushPrefs, quietHours };
```

Then add these tests just before the final `});` of the push `describe` block
(build the bearer header the same way the surrounding tests do — from
`tokenFor(app)`; do not copy any redacted header text):
```ts
  it("returns disabled quiet-hours by default", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "GET", url: "/push/quiet-hours", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, start: 0, end: 0, tz: "UTC" });
    await app.close();
  });

  it("persists a quiet-hours config via POST and reflects it in GET", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const post = await app.inject({ method: "POST", url: "/push/quiet-hours", headers: auth, payload: { enabled: true, start: 1380, end: 420, tz: "Asia/Shanghai" } });
    expect(post.statusCode).toBe(204);
    const res = await app.inject({ method: "GET", url: "/push/quiet-hours", headers: auth });
    expect(res.json()).toEqual({ enabled: true, start: 1380, end: 420, tz: "Asia/Shanghai" });
    await app.close();
  });

  it("rejects an out-of-range start with 400", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "POST", url: "/push/quiet-hours", headers: { authorization: `Bearer ${token}` }, payload: { enabled: true, start: 1440, end: 0, tz: "UTC" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid timezone with 400", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "POST", url: "/push/quiet-hours", headers: { authorization: `Bearer ${token}` }, payload: { enabled: true, start: 0, end: 60, tz: "Not/AZone" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-boolean enabled with 400", async () => {
    const { app } = buildWithPush();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "POST", url: "/push/quiet-hours", headers: { authorization: `Bearer ${token}` }, payload: { enabled: "yes", start: 0, end: 60, tz: "UTC" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects /push/quiet-hours without a bearer token", async () => {
    const { app } = buildWithPush();
    const res = await app.inject({ method: "GET", url: "/push/quiet-hours" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 for /push/quiet-hours when not configured", async () => {
    const app = build();
    const token = await tokenFor(app);
    const res = await app.inject({ method: "GET", url: "/push/quiet-hours", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/http/app.test.ts`
Expected: FAIL — `quietHours` is not a known `buildApp` dep and the routes 404.

- [ ] **Step 3: Add the `quietHours` dep type**

In `server/src/http/app.ts`, add the import next to the other push imports:
```ts
import type { QuietHoursStore } from "../push/pushQuietHoursStore";
```
and add the optional dep to `AppDeps`, next to `pushPrefs?: PushPrefStore;`:
```ts
  quietHours?: QuietHoursStore;
```

- [ ] **Step 4: Add the routes**

In `server/src/http/app.ts`, immediately after the `POST /push/prefs` handler
(the block ending with `deps.pushPrefs.set(owner, prefs, now()); return reply.code(204).send();`),
add:
```ts
  app.get("/push/quiet-hours", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    if (!deps.quietHours) return reply.code(503).send({ error: "push not configured" });
    return deps.quietHours.get(owner);
  });

  app.post("/push/quiet-hours", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    if (!deps.quietHours) return reply.code(503).send({ error: "push not configured" });
    const b = (req.body ?? {}) as { enabled?: unknown; start?: unknown; end?: unknown; tz?: unknown };
    if (typeof b.enabled !== "boolean") return reply.code(400).send({ error: "invalid enabled" });
    const inRange = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1439;
    if (!inRange(b.start)) return reply.code(400).send({ error: "invalid start" });
    if (!inRange(b.end)) return reply.code(400).send({ error: "invalid end" });
    if (typeof b.tz !== "string" || b.tz.length === 0) return reply.code(400).send({ error: "invalid tz" });
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: b.tz });
    } catch {
      return reply.code(400).send({ error: "invalid tz" });
    }
    deps.quietHours.set(owner, { enabled: b.enabled, start: b.start, end: b.end, tz: b.tz }, now());
    return reply.code(204).send();
  });
```

- [ ] **Step 5: Run app tests + typecheck**

Run: `cd server && npx jest src/http/app.test.ts && npm run typecheck`
Expected: PASS (new quiet-hours tests + existing) and `tsc` clean.

- [ ] **Step 6: Wire the store in `index.ts`**

In `server/src/index.ts`, add the import next to the other push-store imports:
```ts
import { SqliteQuietHoursStore } from "./push/pushQuietHoursStore";
```

Replace:
```ts
  const pushPrefs = SqlitePushPrefStore.open(dbPath);
  const notifier = new Notifier({ expo: new Expo(), store: pushTokens, prefs: pushPrefs });
```
with:
```ts
  const pushPrefs = SqlitePushPrefStore.open(dbPath);
  const quietHours = SqliteQuietHoursStore.open(dbPath);
  const notifier = new Notifier({ expo: new Expo(), store: pushTokens, prefs: pushPrefs, quietHours });
```

Then add `quietHours` to the `buildApp({ ... })` call. Replace:
```ts
  const app = buildApp({ auth, agents, store, activity, pushTokens, pushPrefs, now, version: VERSION, logger: process.env.LOG_REQUESTS === "1", appConfig: appConfigFromEnv(process.env), geoHeaders: geoHeadersFromEnv(process.env) });
```
with:
```ts
  const app = buildApp({ auth, agents, store, activity, pushTokens, pushPrefs, quietHours, now, version: VERSION, logger: process.env.LOG_REQUESTS === "1", appConfig: appConfigFromEnv(process.env), geoHeaders: geoHeadersFromEnv(process.env) });
```

- [ ] **Step 7: Run full server suite + typecheck**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; all suites pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/http/app.ts server/src/http/app.test.ts server/src/index.ts && git commit -m "feat(push): GET/POST /push/quiet-hours routes + wire store into notifier"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, replace the deferred `P5c 免打扰时段` fragment
with a landed note. Replace:
```
；P5c 免打扰时段
```
with:
```
；P5c-server 免打扰时段落地：`push_quiet_hours(owner,enabled,start,end,tz)` 存储 + tz 感知 `isWithinQuietHours`（Intl 计算 minute-of-day）+ `Notifier` 仅静音 fills（alerts 穿透、fail-open）+ `GET/POST /push/quiet-hours` 路由（P5c-mobile 时段 UI 待做）
```

- [ ] **Step 2: Full server validation**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; full jest suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P5c-server quiet hours landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-quiet-hours-server
gh pr create --title "feat(push): M7 P5c-server — quiet hours (fills only, tz-aware)" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** tz minute-of-day + window logic (incl. overnight, disabled,
empty, bad-tz fail-open) → Task 1. SQLite store (default disabled, round-trip,
isQuietNow, case-insensitive) → Task 2. Notifier fills-only gate + `now` +
fail-open, alerts bypass → Task 3. GET/POST routes + validation (range, tz,
boolean, 401, 503) + wiring → Task 4. Roadmap → Task 5. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after.
(Task 5 Step 4 PR body-file composed at execution time; app.test bearer header
described rather than pasted due to the view/edit `Bearer` redaction.)

**Type consistency:** `QuietHours { enabled, start, end, tz }` is used identically
in pushQuietHours.ts, pushQuietHoursStore.ts, app.ts route bodies, and tests.
`isQuietNow(owner, nowMs)` matches the Notifier dep shape
`{ isQuietNow(owner: string, nowMs: number): boolean }` and `SqliteQuietHoursStore`.
`minuteOfDayInTz`/`isWithinQuietHours` names match between Task 1 impl and Task 2
import. `now: () => number` default `Date.now` is consistent.
