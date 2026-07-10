# M7 P2 —— 通知核心 + Expo 传输 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `server/src/push/notifier.ts` — a fail-safe `Notifier.notify(owner, notification)` that looks up the owner's push tokens, sends via an injectable Expo client (batched), and prunes tokens returning `DeviceNotRegistered` in the immediate send tickets — never throwing into the caller.

**Architecture:** A pure, injectable library module (like `backend/internal/wsshard` and `server/src/agent/placer.ts`'s `ExchangeLike`). `Notifier` takes `{ expo, store, logger?, isValidToken? }`; a real `expo-server-sdk` `Expo` instance satisfies the `ExpoLike` seam, tests pass a fake (no network). `notify` builds messages paired with their tokens, chunks, sends per chunk under try/catch, zips tickets back to tokens by order, prunes `DeviceNotRegistered` tokens via `store.deleteToken`, and returns a `NotifyResult` summary. Not wired to any route/engine yet (P4 consumes it).

**Tech Stack:** TypeScript, `expo-server-sdk` ^6.1.0 (already `npm install`ed on this branch, uncommitted), jest + ts-jest. Reuses P1 `PushTokenStore`.

**Reference spec:** `docs/superpowers/specs/2026-07-10-m7-push-notifier-design.md`

**Branch:** `feat/m7-push-notifier` (already created; spec committed; `server/package.json` + `package-lock.json` carry the `expo-server-sdk` dep, uncommitted — committed in Task 1).

**Verified facts (do not re-derive):**
- `expo-server-sdk` v6.1.0 exports the `Expo` class and types `ExpoPushMessage`, `ExpoPushTicket`.
  - `Expo.isExpoPushToken(token: unknown): token is ExpoPushToken` (static); `ExpoPushToken = string`. NOTE: `expo-server-sdk` is ESM and jest does not transform `node_modules`, so `notifier.ts` imports only its **types** (erased) and defaults `isValidToken` to a local regex `^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$` — never a runtime `import { Expo }` value import (that breaks under jest). The real `Expo` instance is injected via `ExpoLike` at the P4 wiring site.
  - `expo.chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][]`.
  - `expo.sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>`.
  - `ExpoPushMessage` has `{ to, title?, body?, data?, sound? }` (among others).
  - `ExpoPushTicket = { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: 'DeviceNotRegistered' | 'MessageRateExceeded' | 'MessageTooBig' | 'InvalidCredentials' | 'DeveloperError' | 'ExpoError' | 'ProviderError'; expoPushToken?: string } }`.
- P1 store: `server/src/push/pushTokenStore.ts` exports `interface PushTokenStore { register; unregister; tokensForOwner(owner): PushTokenRow[]; deleteToken(token): void }` and `interface PushTokenRow { token; owner; platform; createdAt; updatedAt }`.
- Injection precedent: `server/src/agent/placer.ts` `ExchangeLike`; `signerShadow.ts` `fetchImpl?` / `ShadowLogger`. Logging: `console.error` (`server/src/index.ts`).
- Scripts: `npm run typecheck` = `tsc --noEmit`; `npm test` = `jest`.

---

## File Structure

- Create: `server/src/push/notifier.ts` — `Notification`, `ExpoLike`, `NotifierDeps`, `NotifyResult`, `Notifier`.
- Create: `server/src/push/notifier.test.ts` — unit tests with a fake `ExpoLike` + fake store.
- Modify: `server/package.json`, `server/package-lock.json` — `expo-server-sdk` dependency (already installed; committed here).

---

## Task 1: `Notifier` core + Expo send + DeviceNotRegistered pruning

**Files:**
- Create: `server/src/push/notifier.ts`
- Test: `server/src/push/notifier.test.ts`
- Modify: `server/package.json`, `server/package-lock.json`

- [ ] **Step 1: Write the failing test**

Create `server/src/push/notifier.test.ts`:

```ts
import { Notifier, type ExpoLike } from "./notifier";
import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { PushTokenRow } from "./pushTokenStore";

const T1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const T2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const T3 = "ExponentPushToken[cccccccccccccccccccccc]";
const OWNER = "0x1111111111111111111111111111111111111111";

function row(token: string): PushTokenRow {
  return { token, owner: OWNER, platform: "ios", createdAt: 1, updatedAt: 1 };
}

// Fake store recording deleteToken calls.
function fakeStore(tokens: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    tokensForOwner: (_owner: string) => tokens.map(row),
    deleteToken: (token: string) => { deleted.push(token); },
  };
}

// Fake Expo: chunk by `chunkSize`; send returns programmed tickets or throws.
function fakeExpo(opts: {
  chunkSize?: number;
  tickets?: (chunk: ExpoPushMessage[]) => ExpoPushTicket[];
  throwOnChunk?: number; // index of chunk that throws
}): ExpoLike & { sends: ExpoPushMessage[][] } {
  const sends: ExpoPushMessage[][] = [];
  let sendCount = 0;
  return {
    sends,
    chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
      const size = opts.chunkSize ?? messages.length || 1;
      const out: ExpoPushMessage[][] = [];
      for (let i = 0; i < messages.length; i += size) out.push(messages.slice(i, i + size));
      return out;
    },
    async sendPushNotificationsAsync(chunk: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
      const idx = sendCount++;
      sends.push(chunk);
      if (opts.throwOnChunk === idx) throw new Error("network");
      return opts.tickets ? opts.tickets(chunk) : chunk.map(() => ({ status: "ok", id: "r" }) as ExpoPushTicket);
    },
  };
}

const okTickets = (chunk: ExpoPushMessage[]): ExpoPushTicket[] => chunk.map(() => ({ status: "ok", id: "r" }));

describe("Notifier.notify", () => {
  const N = { title: "Filled", body: "Your order filled", data: { kind: "fill" } };

  it("returns zeros and does not send when the owner has no tokens", async () => {
    const store = fakeStore([]);
    const expo = fakeExpo({ tickets: okTickets });
    const res = await new Notifier({ expo, store }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 0, sent: 0, errors: 0, pruned: 0 });
    expect(expo.sends).toHaveLength(0);
  });

  it("sends to all valid tokens and reports them sent", async () => {
    const store = fakeStore([T1, T2]);
    const expo = fakeExpo({ tickets: okTickets });
    const res = await new Notifier({ expo, store }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 2, sent: 2, errors: 0, pruned: 0 });
    const msgs = expo.sends.flat();
    expect(msgs.map((m) => m.to)).toEqual([T1, T2]);
    expect(msgs[0]).toMatchObject({ to: T1, title: "Filled", body: "Your order filled", data: { kind: "fill" }, sound: "default" });
  });

  it("prunes a token that returns DeviceNotRegistered", async () => {
    const store = fakeStore([T1, T2]);
    const expo = fakeExpo({
      tickets: (chunk) => chunk.map((m) => (m.to === T1 ? ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }) : ({ status: "ok", id: "r" })) as ExpoPushTicket),
    });
    const res = await new Notifier({ expo, store }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 2, sent: 1, errors: 1, pruned: 1 });
    expect(store.deleted).toEqual([T1]);
  });

  it("does not prune non-DeviceNotRegistered errors", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({
      tickets: () => [{ status: "error", message: "slow down", details: { error: "MessageRateExceeded" } } as ExpoPushTicket],
    });
    const res = await new Notifier({ expo, store }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 1, sent: 0, errors: 1, pruned: 0 });
    expect(store.deleted).toEqual([]);
  });

  it("filters out invalid tokens before sending", async () => {
    const store = fakeStore([T1, "garbage"]);
    const expo = fakeExpo({ tickets: okTickets });
    const res = await new Notifier({ expo, store, isValidToken: (t) => t === T1 }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 1, sent: 1, errors: 0, pruned: 0 });
    expect(expo.sends.flat().map((m) => m.to)).toEqual([T1]);
  });

  it("does not throw when a send chunk rejects; logs and counts errors", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ throwOnChunk: 0 });
    const logs: string[] = [];
    const res = await new Notifier({ expo, store, logger: (m) => logs.push(m) }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 1, sent: 0, errors: 1, pruned: 0 });
    expect(logs.length).toBeGreaterThan(0);
  });

  it("correlates tickets to tokens across chunks (prunes the right token)", async () => {
    const store = fakeStore([T1, T2, T3]);
    // chunkSize 1 → three chunks; only the T2 chunk returns DeviceNotRegistered.
    const expo = fakeExpo({
      chunkSize: 1,
      tickets: (chunk) => chunk.map((m) => (m.to === T2 ? ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }) : ({ status: "ok", id: "r" })) as ExpoPushTicket),
    });
    const res = await new Notifier({ expo, store }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 3, sent: 2, errors: 1, pruned: 1 });
    expect(store.deleted).toEqual([T2]);
  });

  it("does not throw when tokensForOwner throws", async () => {
    const store = {
      tokensForOwner: () => { throw new Error("db"); },
      deleteToken: () => {},
    };
    const expo = fakeExpo({ tickets: okTickets });
    const logs: string[] = [];
    const res = await new Notifier({ expo, store, logger: (m) => logs.push(m) }).notify(OWNER, N);
    expect(res).toEqual({ tokens: 0, sent: 0, errors: 0, pruned: 0 });
    expect(logs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/push/notifier.test.ts`
Expected: FAIL — cannot find module `./notifier`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/push/notifier.ts`:

```ts
import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { PushTokenStore } from "./pushTokenStore";

// Expo push token format (matches Expo.isExpoPushToken). Default validator so
// this module needs only expo-server-sdk's (erased) types — no runtime import of
// the ESM package, keeping it trivially unit-testable under jest.
const EXPO_PUSH_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

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
  /** Token validator; defaults to the Expo push-token format regex. */
  isValidToken?: (token: string) => boolean;
}

export interface NotifyResult {
  tokens: number;
  sent: number;
  errors: number;
  pruned: number;
}

/** Fail-safe push sender over Expo Push Service. notify() never throws. */
export class Notifier {
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

  async notify(owner: string, n: Notification): Promise<NotifyResult> {
    const result: NotifyResult = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    let tokens: string[];
    try {
      tokens = this.store.tokensForOwner(owner).map((r) => r.token).filter((t) => this.isValid(t));
    } catch (err) {
      this.log("push tokensForOwner failed", err);
      return result;
    }
    result.tokens = tokens.length;
    if (tokens.length === 0) return result;

    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      sound: "default",
      title: n.title,
      body: n.body,
      data: n.data,
    }));

    let chunks: ExpoPushMessage[][];
    try {
      chunks = this.expo.chunkPushNotifications(messages);
    } catch (err) {
      this.log("push chunk failed", err);
      result.errors += tokens.length;
      return result;
    }

    let cursor = 0; // index into `tokens`, advanced per chunk to keep ticket↔token alignment
    for (const chunk of chunks) {
      const chunkTokens = tokens.slice(cursor, cursor + chunk.length);
      cursor += chunk.length;
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        this.log("push send chunk failed", err);
        result.errors += chunk.length;
        continue;
      }
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const token = chunkTokens[i];
        if (ticket.status === "ok") {
          result.sent++;
          continue;
        }
        result.errors++;
        if (ticket.details?.error === "DeviceNotRegistered" && token) {
          try {
            this.store.deleteToken(token);
            result.pruned++;
          } catch (err) {
            this.log("push prune failed", err);
          }
        }
      }
    }
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/push/notifier.test.ts && npm run typecheck`
Expected: PASS (all 8 tests); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add server/src/push/notifier.ts server/src/push/notifier.test.ts server/package.json server/package-lock.json && \
  git commit -m "feat(push): fail-safe Notifier over Expo Push Service (P2)"
```

---

## Task 2: roadmap doc + final validation + PR

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the roadmap M7 status**

In `docs/BACKEND-ARCHITECTURE.md`, the M7 row currently reads (from P1):

```
...；P1 设备令牌注册表落地：authed `/push/register`·`/push/unregister`，owner 取自钱包会话，Expo token 主键 upsert 重绑（`server/src/push/pushTokenStore.ts`）；P2 通知核心+传输、P3 mobile 注册、P4 事件接线+偏好 待做】**
```

Replace the `；P2 通知核心+传输、P3 mobile 注册、P4 事件接线+偏好 待做】**` tail with:

```
；P2 通知核心+Expo 传输落地：fail-safe `Notifier.notify(owner, notification)`（注入 Expo 客户端、批量 chunk 发送、即时 ticket DeviceNotRegistered 令牌剪枝、不外抛，`server/src/push/notifier.ts`）；P2.5 延迟回执轮询、P3 mobile 注册、P4 事件接线+偏好 待做】**
```

- [ ] **Step 2: Commit the doc**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: mark M7 P2 通知核心+Expo 传输 landed"
```

- [ ] **Step 3: Full server validation (no regressions)**

Run:
```bash
cd server && npm run typecheck && npm test
```
Expected: typecheck clean; the whole jest suite passes (notifier additions + all existing tests).

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/m7-push-notifier && \
  gh pr create --title "feat(server): M7 P2 通知核心 + Expo 传输" \
    --body "M7 推送子项目 P2。fail-safe \`Notifier.notify(owner, notification)\`：注入 \`ExpoLike\` 缝、批量 \`chunkPushNotifications\` + \`sendPushNotificationsAsync\`、对即时 ticket 里 \`DeviceNotRegistered\` 的令牌调 \`store.deleteToken\` 剪枝、跨块 ticket↔token 对应、全程不外抛（推送失败绝不打断交易关键路径）。新增 \`expo-server-sdk\` 依赖。纯库模块，P4 消费；延迟回执轮询拆为 P2.5。Spec: docs/superpowers/specs/2026-07-10-m7-push-notifier-design.md"
```
Expected: PR created.

- [ ] **Step 5: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §3 dep → Task 1 (commit package.json); §4 types (`Notification`/`ExpoLike`/`NotifierDeps`/`NotifyResult`) → Task 1; §5 notify algorithm (lookup+filter, build messages, chunk, per-chunk send under try/catch, zip tickets, DNR prune) → Task 1; §6 fail-safe (never throws; tokensForOwner/chunk/send/deleteToken all guarded) → Task 1; §7 tests 1–8 → Task 1 (eight `it` blocks map 1:1); §8 validation → Task 2. Doc note → Task 2. All covered.
- **Placeholder scan:** all code complete; the fake Expo/store are fully written; no TODOs.
- **Type consistency:** `Notifier` ctor takes `NotifierDeps`; `notify(owner, n): Promise<NotifyResult>`; `NotifyResult` fields `tokens/sent/errors/pruned`; `ExpoLike` methods match `expo-server-sdk` signatures; store used via `Pick<PushTokenStore,"tokensForOwner"|"deleteToken">` — all identical across impl and tests, matching the spec.
- **Correlation correctness:** the `cursor` advances by `chunk.length` per chunk and `chunkTokens = tokens.slice(cursor, cursor+chunk.length)` — the test `correlates tickets to tokens across chunks` (chunkSize 1, three tokens, only T2 errors) asserts `deleted == [T2]`, guarding the alignment.
- **No live wiring:** module is not imported by any route/index (P4 wires it), matching the wsshard precedent; no unused-var risk since `notifier.ts` itself uses `expo-server-sdk` + `Expo`.
