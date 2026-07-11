# M7 P2.5 — Expo Receipt Polling & Delayed Token Pruning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record Expo receipt ids on successful sends and poll them on a timer, pruning tokens that come back `DeviceNotRegistered` (other errors logged only).

**Architecture:** A SQLite `PushReceiptStore` (receipt_id → token), an optional `receipts` dep on `Notifier` that records ids on `ok` tickets, a fail-safe `pollPushReceipts` over a separate `ExpoReceiptLike` seam, and a periodic timer in `index.ts`. Notifier's `notify` signature and `ExpoLike` are unchanged, so existing callers/fakes are untouched.

**Tech Stack:** TypeScript, better-sqlite3, expo-server-sdk (types only in tested code), jest.

Spec: `docs/superpowers/specs/2026-07-11-m7-push-receipt-polling-design.md`

---

## Task 1: `PushReceiptStore` (SQLite)

**Files:**
- Create: `server/src/push/pushReceiptStore.ts`
- Create: `server/src/push/pushReceiptStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/pushReceiptStore.test.ts`:
```ts
import { SqlitePushReceiptStore } from "./pushReceiptStore";

describe("SqlitePushReceiptStore", () => {
  it("records and returns pending receipts oldest-first", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r2", "TokB", 2000);
    expect(s.pending(10)).toEqual([
      { receiptId: "r1", token: "TokA" },
      { receiptId: "r2", token: "TokB" },
    ]);
  });

  it("respects the pending limit", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r2", "TokB", 2000);
    expect(s.pending(1)).toEqual([{ receiptId: "r1", token: "TokA" }]);
  });

  it("record is idempotent by receipt id", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r1", "TokZ", 5000);
    expect(s.pending(10)).toEqual([{ receiptId: "r1", token: "TokA" }]);
  });

  it("remove deletes only the listed ids and no-ops on empty", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r2", "TokB", 2000);
    s.remove([]);
    expect(s.pending(10)).toHaveLength(2);
    s.remove(["r1"]);
    expect(s.pending(10)).toEqual([{ receiptId: "r2", token: "TokB" }]);
  });

  it("pruneOlderThan deletes rows below the cutoff and keeps newer ones", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("old", "TokA", 1000);
    s.record("new", "TokB", 5000);
    s.pruneOlderThan(3000);
    expect(s.pending(10)).toEqual([{ receiptId: "new", token: "TokB" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/pushReceiptStore.test.ts`
Expected: FAIL — `Cannot find module './pushReceiptStore'`.

- [ ] **Step 3: Implement the store**

Create `server/src/push/pushReceiptStore.ts`:
```ts
import Database from "better-sqlite3";

export interface PendingReceipt {
  receiptId: string;
  token: string;
}

export interface PushReceiptStore {
  /** Remember a receipt id → token (idempotent by receipt_id). */
  record(receiptId: string, token: string, now: number): void;
  /** Oldest-first pending receipts, up to `limit`. */
  pending(limit: number): PendingReceipt[];
  /** Delete the given receipt rows (processed). No-op on empty. */
  remove(receiptIds: string[]): void;
  /** Delete receipt rows created before cutoffMs (never got a receipt). */
  pruneOlderThan(cutoffMs: number): void;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_receipts (
      receipt_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_receipts_created ON push_receipts(created_at);
  `);
}

/** Durable receipt-id → token registry for delayed Expo receipt polling. */
export class SqlitePushReceiptStore implements PushReceiptStore {
  private constructor(private db: Database.Database) {}

  static open(path: string): SqlitePushReceiptStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return new SqlitePushReceiptStore(db);
  }

  record(receiptId: string, token: string, now: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO push_receipts (receipt_id, token, created_at) VALUES (?, ?, ?)`)
      .run(receiptId, token, now);
  }

  pending(limit: number): PendingReceipt[] {
    const rows = this.db
      .prepare(`SELECT receipt_id, token FROM push_receipts ORDER BY created_at ASC LIMIT ?`)
      .all(limit) as { receipt_id: string; token: string }[];
    return rows.map((r) => ({ receiptId: r.receipt_id, token: r.token }));
  }

  remove(receiptIds: string[]): void {
    if (receiptIds.length === 0) return;
    const placeholders = receiptIds.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM push_receipts WHERE receipt_id IN (${placeholders})`).run(...receiptIds);
  }

  pruneOlderThan(cutoffMs: number): void {
    this.db.prepare(`DELETE FROM push_receipts WHERE created_at < ?`).run(cutoffMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/pushReceiptStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/pushReceiptStore.ts server/src/push/pushReceiptStore.test.ts && git commit -m "feat(push): SQLite receipt-id -> token store for delayed pruning"
```

---

## Task 2: `Notifier` records receipt ids on success

`notify`'s signature is unchanged (new optional dep only), so callers/tests outside
this file are untouched.

**Files:**
- Modify: `server/src/push/notifier.ts`
- Modify: `server/src/push/notifier.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/src/push/notifier.test.ts`, add these tests just before the final `});`
that closes the `describe("Notifier.notify", ...)` block. (The default `fakeExpo`
tickets already carry `id: "r"`.)
```ts
  it("records a receipt id and token for each ok ticket", async () => {
    const store = fakeStore([T1, T2]);
    const expo = fakeExpo({ tickets: okTickets });
    const recorded: Array<[string, string]> = [];
    const receipts = { record: (id: string, token: string) => { recorded.push([id, token]); } };
    const res = await new Notifier({ expo, store, receipts, now: () => 7 }).notify(OWNER, "fills", () => N);
    expect(res.sent).toBe(2);
    expect(recorded).toEqual([["r", T1], ["r", T2]]);
  });

  it("still sends when no receipts store is injected", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const res = await new Notifier({ expo, store }).notify(OWNER, "fills", () => N);
    expect(res.sent).toBe(1);
  });

  it("swallows a throwing receipts.record and still counts the send", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ tickets: okTickets });
    const receipts = { record: () => { throw new Error("db"); } };
    const logs: string[] = [];
    const res = await new Notifier({ expo, store, receipts, logger: (m) => logs.push(m) }).notify(OWNER, "fills", () => N);
    expect(res.sent).toBe(1);
    expect(logs.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest src/push/notifier.test.ts`
Expected: FAIL — `NotifierDeps` has no `receipts`; nothing is recorded.

- [ ] **Step 3: Add the dep and record on success**

In `server/src/push/notifier.ts`, add the import near the other `./push*` type
imports:
```ts
import type { PushReceiptStore } from "./pushReceiptStore";
```

Add `receipts` to `NotifierDeps` (after `quietHours`):
```ts
  /** Optional delayed-receipt registry; ok tickets are recorded for later polling. */
  receipts?: Pick<PushReceiptStore, "record">;
```

Add a private field + assign it in the constructor. Replace:
```ts
  private readonly quietHours?: { isQuietNow(owner: string, nowMs: number): boolean };
  private readonly now: () => number;
```
with:
```ts
  private readonly quietHours?: { isQuietNow(owner: string, nowMs: number): boolean };
  private readonly receipts?: Pick<PushReceiptStore, "record">;
  private readonly now: () => number;
```
and, in the constructor, replace:
```ts
    this.quietHours = deps.quietHours;
    this.now = deps.now ?? (() => Date.now());
```
with:
```ts
    this.quietHours = deps.quietHours;
    this.receipts = deps.receipts;
    this.now = deps.now ?? (() => Date.now());
```

In the ticket loop, replace the `ok` branch:
```ts
        if (ticket.status === "ok") {
          result.sent++;
          continue;
        }
```
with:
```ts
        if (ticket.status === "ok") {
          if (this.receipts && ticket.id && token) {
            try {
              this.receipts.record(ticket.id, token, this.now());
            } catch (err) {
              this.log("push receipt record failed", err); // fail-safe
            }
          }
          result.sent++;
          continue;
        }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd server && npx jest src/push/notifier.test.ts && npm run typecheck`
Expected: PASS and `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifier.ts server/src/push/notifier.test.ts && git commit -m "feat(push): Notifier records receipt ids on ok tickets (fail-safe)"
```

---

## Task 3: `pollPushReceipts` poller

**Files:**
- Create: `server/src/push/receiptPoller.ts`
- Create: `server/src/push/receiptPoller.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/receiptPoller.test.ts`:
```ts
import { pollPushReceipts, type ExpoReceiptLike } from "./receiptPoller";
import type { ExpoPushReceipt } from "expo-server-sdk";

function fakeReceiptsStore(pendingRows: { receiptId: string; token: string }[]) {
  const removed: string[] = [];
  const pruned: number[] = [];
  let rows = [...pendingRows];
  return {
    removed,
    pruned,
    pending: (_limit: number) => rows,
    remove: (ids: string[]) => { removed.push(...ids); rows = rows.filter((r) => !ids.includes(r.receiptId)); },
    pruneOlderThan: (cutoff: number) => { pruned.push(cutoff); },
  };
}

function fakeTokens() {
  const deleted: string[] = [];
  return { deleted, deleteToken: (t: string) => { deleted.push(t); } };
}

function fakeExpo(map: Record<string, ExpoPushReceipt>, opts: { throwFetch?: boolean } = {}): ExpoReceiptLike {
  return {
    chunkPushNotificationReceiptIds: (ids: string[]) => [ids],
    getPushNotificationReceiptsAsync: async (_ids: string[]) => {
      if (opts.throwFetch) throw new Error("net");
      return map;
    },
  };
}

const OK: ExpoPushReceipt = { status: "ok" } as ExpoPushReceipt;
const DNR: ExpoPushReceipt = { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } as ExpoPushReceipt;
const RATE: ExpoPushReceipt = { status: "error", message: "slow", details: { error: "MessageRateExceeded" } } as ExpoPushReceipt;

describe("pollPushReceipts", () => {
  it("removes an ok receipt without pruning", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({ r1: OK }), receipts, tokens, now: () => 100 });
    expect(res).toMatchObject({ checked: 1, ok: 1, pruned: 0, errors: 0 });
    expect(receipts.removed).toEqual(["r1"]);
    expect(tokens.deleted).toEqual([]);
  });

  it("prunes the token on DeviceNotRegistered and removes the row", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({ r1: DNR }), receipts, tokens, now: () => 100 });
    expect(res).toMatchObject({ checked: 1, ok: 0, pruned: 1, errors: 1 });
    expect(tokens.deleted).toEqual(["TokA"]);
    expect(receipts.removed).toEqual(["r1"]);
  });

  it("logs other errors and removes the row without pruning", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const logs: string[] = [];
    const res = await pollPushReceipts({ expo: fakeExpo({ r1: RATE }), receipts, tokens, now: () => 100, logger: (m) => logs.push(m) });
    expect(res).toMatchObject({ checked: 1, ok: 0, pruned: 0, errors: 1 });
    expect(tokens.deleted).toEqual([]);
    expect(receipts.removed).toEqual(["r1"]);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("leaves a not-yet-available receipt pending", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({}), receipts, tokens, now: () => 100 });
    expect(res).toMatchObject({ checked: 0 });
    expect(receipts.removed).toEqual([]);
  });

  it("prunes stale rows and does not fetch when nothing is pending", async () => {
    const receipts = fakeReceiptsStore([]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({}), receipts, tokens, now: () => 100000, maxAgeMs: 1000 });
    expect(res.checked).toBe(0);
    expect(receipts.pruned).toEqual([99000]); // now - maxAgeMs
  });

  it("never throws when the receipts fetch throws", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({}, { throwFetch: true }), receipts, tokens, now: () => 100 });
    expect(res.checked).toBe(0);
    expect(receipts.removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/receiptPoller.test.ts`
Expected: FAIL — `Cannot find module './receiptPoller'`.

- [ ] **Step 3: Implement the poller**

Create `server/src/push/receiptPoller.ts`:
```ts
import type { ExpoPushReceipt } from "expo-server-sdk";
import type { PushReceiptStore } from "./pushReceiptStore";
import type { PushTokenStore } from "./pushTokenStore";

/** Receipt-side seam over expo-server-sdk (separate from ExpoLike so Notifier fakes
 *  are unaffected). A real Expo instance satisfies this structurally. */
export interface ExpoReceiptLike {
  chunkPushNotificationReceiptIds(ids: string[]): string[][];
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

export interface PollDeps {
  expo: ExpoReceiptLike;
  receipts: Pick<PushReceiptStore, "pending" | "remove" | "pruneOlderThan">;
  tokens: Pick<PushTokenStore, "deleteToken">;
  now: () => number;
  logger?: (msg: string, err?: unknown) => void;
  /** Max receipts to check per poll (default 1000). */
  batchLimit?: number;
  /** Rows older than this are pruned as never-resolved (default 24h). */
  maxAgeMs?: number;
}

export interface PollResult {
  checked: number;
  ok: number;
  pruned: number;
  errors: number;
}

/** Fetch pending push receipts, prune DeviceNotRegistered tokens, and reap stale rows.
 *  Fail-safe: never throws. */
export async function pollPushReceipts(deps: PollDeps): Promise<PollResult> {
  const result: PollResult = { checked: 0, ok: 0, pruned: 0, errors: 0 };
  const log = deps.logger ?? ((msg: string, err?: unknown) => console.error(msg, err));
  const batchLimit = deps.batchLimit ?? 1000;
  const maxAgeMs = deps.maxAgeMs ?? 24 * 60 * 60 * 1000;
  try {
    const rows = deps.receipts.pending(batchLimit);
    if (rows.length > 0) {
      const tokenByReceipt = new Map(rows.map((r) => [r.receiptId, r.token]));
      const processed: string[] = [];
      for (const chunk of deps.expo.chunkPushNotificationReceiptIds(rows.map((r) => r.receiptId))) {
        let map: Record<string, ExpoPushReceipt>;
        try {
          map = await deps.expo.getPushNotificationReceiptsAsync(chunk);
        } catch (err) {
          log("push receipt fetch failed", err);
          continue;
        }
        for (const receiptId of chunk) {
          const receipt = map[receiptId];
          if (!receipt) continue; // not ready yet → leave pending
          result.checked++;
          processed.push(receiptId);
          if (receipt.status === "ok") {
            result.ok++;
            continue;
          }
          result.errors++;
          log(`push receipt error: ${receipt.message ?? "unknown"}`);
          if (receipt.details?.error === "DeviceNotRegistered") {
            const token = tokenByReceipt.get(receiptId);
            if (token) {
              try {
                deps.tokens.deleteToken(token);
                result.pruned++;
              } catch (err) {
                log("push receipt prune failed", err);
              }
            }
          }
        }
      }
      deps.receipts.remove(processed);
    }
    deps.receipts.pruneOlderThan(deps.now() - maxAgeMs);
  } catch (err) {
    log("push receipt poll failed", err);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/receiptPoller.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/receiptPoller.ts server/src/push/receiptPoller.test.ts && git commit -m "feat(push): fail-safe receipt poller (prune DeviceNotRegistered)"
```

---

## Task 4: Wire the store + timer into `index.ts`

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add imports**

In `server/src/index.ts`, next to the other push-store imports, add:
```ts
import { SqlitePushReceiptStore } from "./push/pushReceiptStore";
import { pollPushReceipts } from "./push/receiptPoller";
```

- [ ] **Step 2: Share the Expo instance + inject the receipt store**

Replace:
```ts
  const quietHours = SqliteQuietHoursStore.open(dbPath);
  const notifier = new Notifier({ expo: new Expo(), store: pushTokens, prefs: pushPrefs, quietHours });
```
with:
```ts
  const quietHours = SqliteQuietHoursStore.open(dbPath);
  const pushReceipts = SqlitePushReceiptStore.open(dbPath);
  const expoClient = new Expo();
  const notifier = new Notifier({ expo: expoClient, store: pushTokens, prefs: pushPrefs, quietHours, receipts: pushReceipts });
```

- [ ] **Step 3: Add the receipt-poll timer**

Immediately after the existing `timer.unref?.();` line (the scheduler tick timer),
add:
```ts
  const receiptPollMs = Number(process.env.RECEIPT_POLL_MS ?? 15 * 60 * 1000);
  const receiptTimer = setInterval(() => {
    void pollPushReceipts({ expo: expoClient, receipts: pushReceipts, tokens: pushTokens, now }).catch(() => {
      /* pollPushReceipts is itself fail-safe; guard just in case */
    });
  }, receiptPollMs);
  receiptTimer.unref?.();
```

- [ ] **Step 4: Clear the timer on shutdown**

In the `shutdown` function, replace:
```ts
    clearInterval(timer);
```
with:
```ts
    clearInterval(timer);
    clearInterval(receiptTimer);
```

- [ ] **Step 5: Typecheck + full server suite**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/index.ts && git commit -m "feat(push): wire receipt store + periodic poll into server bootstrap"
```

---

## Task 5: Roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the M7 roadmap row**

In `docs/BACKEND-ARCHITECTURE.md`, replace the deferred `P2.5 延迟回执轮询` fragment
with a landed note. Replace:
```
P2.5 延迟回执轮询
```
with:
```
P2.5 延迟回执轮询落地：`push_receipts(receipt_id,token,created_at)` 存储 + `Notifier` 记录 ok ticket 的 receipt id + `pollPushReceipts` 每 15min 拉回执，仅 DeviceNotRegistered 剪枝 token（其余记日志），24h 超期清理
```

(If the surrounding text differs, replace only the literal `P2.5 延迟回执轮询`.)

- [ ] **Step 2: Full server validation**

Run: `cd server && npm run typecheck && npm test`
Expected: `tsc` clean; full jest suite passes with no regressions.

- [ ] **Step 3: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && git commit -m "docs(m7): mark P2.5 receipt polling landed in roadmap"
```

- [ ] **Step 4: Push, open PR, review, merge**

Follow the finishing-a-development-branch skill:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-receipt-polling
gh pr create --title "feat(push): M7 P2.5 — Expo receipt polling + delayed token pruning" --body-file <tmp body file>
```
Then dispatch the code-review agent, wait for CI green (`gh pr checks --watch`), and on
a clean review + green CI `gh pr merge --squash --delete-branch`, then sync `main`.

---

## Self-Review

**Spec coverage:** PushReceiptStore (record/pending/remove/pruneOlderThan) → Task 1.
Notifier records receipt ids on ok tickets (fail-safe, optional dep) → Task 2.
pollPushReceipts (ok remove, DeviceNotRegistered prune, other-error log, not-ready
keep, stale prune, fail-safe) → Task 3. Wiring + timer + shutdown → Task 4. Roadmap →
Task 5. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows exact code/before-after.
(Task 5 Step 4 PR body-file composed at execution time.)

**Type consistency:** `PushReceiptStore` methods (`record`, `pending`, `remove`,
`pruneOlderThan`) and `PendingReceipt { receiptId, token }` are used identically in
pushReceiptStore.ts, notifier.ts (`Pick<..., "record">`), receiptPoller.ts
(`Pick<..., "pending"|"remove"|"pruneOlderThan">`), and index.ts. `ExpoReceiptLike`
(`chunkPushNotificationReceiptIds`, `getPushNotificationReceiptsAsync`) matches the
real `Expo` instance passed in index.ts. `PollResult { checked, ok, pruned, errors }`
is consistent across the poller and its tests.
