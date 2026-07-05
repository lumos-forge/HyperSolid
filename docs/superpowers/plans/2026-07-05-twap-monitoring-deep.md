# Deepened TWAP Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the mobile Positions-tab TWAP monitor with a completed/terminated history list, per-slice fill detail (expandable per TWAP), and live WebSocket updates via `userTwapSliceFills`.

**Architecture:** Pure normalizers in `lib/hyperliquid/twap.ts` (reusing the existing `Fill` type + a new single-item `normalizeFill` extracted from `history.ts`), a widened `TwapService` (`loadHistory`/`loadSliceFills`/`subscribeSliceFills`), new Info/Subscription client factories, and PositionsScreen UI that renders history + expandable slice detail and wires a WS subscription that appends slice fills, optimistically bumps active-TWAP progress, and debounce-refetches `twapHistory` to reconcile authoritative status. Mobile only — no server changes.

**Tech Stack:** Expo React Native (TS), `@nktkas/hyperliquid` (InfoClient + SubscriptionClient / WebSocketTransport), Jest + @testing-library/react-native.

---

### Task 1: Extract a single-fill `normalizeFill` helper

**Files:**
- Modify: `mobile/src/lib/hyperliquid/history.ts` (extract from `normalizeFills`)
- Test: `mobile/src/lib/hyperliquid/history.test.ts` (add one test; existing stay green)

- [ ] **Step 1: Write the failing test**

Append to `mobile/src/lib/hyperliquid/history.test.ts` (add `normalizeFill` to the existing import from `./history`):

```ts
describe("normalizeFill", () => {
  it("maps a single raw userFill (side B->buy, numeric coercion, builderFee default 0)", () => {
    const raw = { coin: "BTC", px: "60000", sz: "0.5", side: "B" as const, time: 123, startPosition: "0", dir: "Open Long", closedPnl: "0", hash: "0x" as const, oid: 1, crossed: true, fee: "0.3", tid: 42, feeToken: "USDC", twapId: null };
    expect(normalizeFill(raw)).toEqual({
      coin: "BTC", px: 60000, sz: 0.5, side: "buy", time: 123, closedPnl: 0, dir: "Open Long",
      fee: 0.3, builderFee: 0, feeToken: "USDC", oid: 1, tid: 42, hash: "0x", crossed: true,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx jest history.test`
Expected: FAIL — `normalizeFill is not a function`.

- [ ] **Step 3: Extract the helper**

In `mobile/src/lib/hyperliquid/history.ts`, replace the `normalizeFills` function with:

```ts
/** Normalize a single raw userFill into a Fill. */
export function normalizeFill(f: RawUserFill): Fill {
  return {
    coin: f.coin,
    px: Number(f.px),
    sz: Number(f.sz),
    side: sideFromBA(f.side),
    time: f.time,
    closedPnl: Number(f.closedPnl),
    dir: f.dir,
    fee: Number(f.fee),
    builderFee: f.builderFee !== undefined ? Number(f.builderFee) : 0,
    feeToken: f.feeToken,
    oid: f.oid,
    tid: f.tid,
    hash: f.hash,
    crossed: f.crossed,
  };
}

/** Normalize userFills, de-duplicating by `tid` (partial-fill id), newest first. */
export function normalizeFills(raw: RawUserFill[]): Fill[] {
  const seen = new Set<number>();
  const out: Fill[] = [];
  for (const f of raw) {
    if (seen.has(f.tid)) continue;
    seen.add(f.tid);
    out.push(normalizeFill(f));
  }
  return out.sort((a, b) => b.time - a.time);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest history.test`
Expected: PASS (new `normalizeFill` test + all existing `normalizeFills`/merge/funding/orders tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/hyperliquid/history.ts mobile/src/lib/hyperliquid/history.test.ts
git commit --no-verify -m "refactor(fills): extract single-item normalizeFill for reuse

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: TWAP history + slice-fill normalizers in `twap.ts`

**Files:**
- Modify: `mobile/src/lib/hyperliquid/twap.ts`
- Test: `mobile/src/lib/hyperliquid/twap.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `mobile/src/lib/hyperliquid/twap.test.ts` (extend the import from `./twap` to add `normalizeTwapHistory, normalizeSliceFills, groupSliceFillsByTwapId`):

```ts
function sliceRaw(twapId: unknown, over: Record<string, unknown> = {}) {
  return { twapId, fill: { coin: "BTC", px: "60000", sz: "0.1", side: "B", time: 100, startPosition: "0", dir: "Open Long", closedPnl: "0", hash: "0x", oid: 1, crossed: true, fee: "0.1", tid: 1, feeToken: "USDC", twapId, ...over } };
}

describe("normalizeTwapHistory", () => {
  it("keeps finished/terminated/error entries, maps side + fields, newest first", () => {
    const raw = [
      { status: { status: "activated" }, twapId: 1, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "finished" }, twapId: 2, state: { coin: "ETH", side: "A", sz: "2", executedSz: "2", executedNtl: "5000", minutes: 10, reduceOnly: false, timestamp: 900 } },
      { status: { status: "terminated" }, twapId: 3, state: { coin: "SOL", side: "B", sz: "3", executedSz: "1", executedNtl: "180", minutes: 15, reduceOnly: true, timestamp: 1200 } },
    ];
    const out = normalizeTwapHistory(raw);
    expect(out.map((e) => e.twapId)).toEqual([3, 2]); // activated dropped; newest (1200) first
    expect(out[1]).toEqual({ twapId: 2, coin: "ETH", side: "sell", sz: 2, executedSz: 2, executedNtl: 5000, minutes: 10, reduceOnly: false, startedAt: 900, status: "finished" });
  });
  it("keeps error status and null twapId; returns [] for non-array", () => {
    const raw = [{ status: { status: "error" }, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0", executedNtl: "0", minutes: 5, reduceOnly: false, timestamp: 1 } }];
    expect(normalizeTwapHistory(raw)[0]).toMatchObject({ twapId: null, status: "error" });
    expect(normalizeTwapHistory(null)).toEqual([]);
  });
});

describe("normalizeSliceFills", () => {
  it("drops entries without a numeric twapId and normalizes the fill", () => {
    const out = normalizeSliceFills([sliceRaw(7), sliceRaw(null), sliceRaw("x")]);
    expect(out).toHaveLength(1);
    expect(out[0].twapId).toBe(7);
    expect(out[0].fill).toMatchObject({ coin: "BTC", px: 60000, sz: 0.1, side: "buy", tid: 1 });
  });
  it("returns [] for a non-array", () => {
    expect(normalizeSliceFills(undefined)).toEqual([]);
  });
});

describe("groupSliceFillsByTwapId", () => {
  it("groups by twapId, dedups by tid, sorts each group newest first", () => {
    const list = normalizeSliceFills([
      sliceRaw(7, { tid: 1, time: 100 }),
      sliceRaw(7, { tid: 1, time: 100 }), // dup tid
      sliceRaw(7, { tid: 2, time: 300 }),
      sliceRaw(8, { tid: 3, time: 200 }),
    ]);
    const map = groupSliceFillsByTwapId(list);
    expect(map.get(7)!.map((f) => f.tid)).toEqual([2, 1]); // newest first, deduped
    expect(map.get(8)!.map((f) => f.tid)).toEqual([3]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest twap.test`
Expected: FAIL — the new functions are not exported.

- [ ] **Step 3: Implement the normalizers**

In `mobile/src/lib/hyperliquid/twap.ts`, add these imports at the very top of the file:

```ts
import { normalizeFill } from "./history";
import type { Fill, RawUserFill, Subscription } from "./types";
```

Then append to the END of `mobile/src/lib/hyperliquid/twap.ts`:

```ts
export type TwapStatus = "finished" | "terminated" | "error";

/** A finished/terminated/error TWAP, normalized from HL `twapHistory` for the history list. */
export interface TwapHistoryEntry {
  twapId: number | null; // some historical entries have no numeric id (not expandable)
  coin: string;
  side: "buy" | "sell";
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  reduceOnly: boolean;
  startedAt: number;
  status: TwapStatus;
}

/** One TWAP slice fill: a standard Fill tagged with its parent twapId. */
export interface TwapSliceFill {
  twapId: number;
  fill: Fill;
}

const HISTORY_STATUSES: ReadonlySet<string> = new Set(["finished", "terminated", "error"]);
const HISTORY_LIMIT = 50;

/** Keep finished/terminated/error entries (newest first, capped), normalized for display. */
export function normalizeTwapHistory(history: unknown): TwapHistoryEntry[] {
  if (!Array.isArray(history)) return [];
  const out: TwapHistoryEntry[] = [];
  for (const raw of history as RawTwap[]) {
    const status = raw?.status?.status;
    if (typeof status !== "string" || !HISTORY_STATUSES.has(status)) continue;
    const s = raw.state ?? {};
    out.push({
      twapId: typeof raw.twapId === "number" ? raw.twapId : null,
      coin: s.coin ?? "",
      side: s.side === "A" ? "sell" : "buy",
      sz: Number(s.sz ?? 0),
      executedSz: Number(s.executedSz ?? 0),
      executedNtl: Number(s.executedNtl ?? 0),
      minutes: Number(s.minutes ?? 0),
      reduceOnly: Boolean(s.reduceOnly),
      startedAt: Number(s.timestamp ?? 0),
      status: status as TwapStatus,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, HISTORY_LIMIT);
}

interface RawSliceFill {
  fill?: unknown;
  twapId?: unknown;
}

/** Normalize `userTwapSliceFills`, keeping only entries with a numeric twapId. */
export function normalizeSliceFills(raw: unknown): TwapSliceFill[] {
  if (!Array.isArray(raw)) return [];
  const out: TwapSliceFill[] = [];
  for (const r of raw as RawSliceFill[]) {
    if (typeof r?.twapId !== "number") continue;
    if (!r.fill || typeof r.fill !== "object") continue;
    out.push({ twapId: r.twapId, fill: normalizeFill(r.fill as RawUserFill) });
  }
  return out;
}

/** Group slice fills by twapId, de-duplicating by `tid`, each group newest first. */
export function groupSliceFillsByTwapId(list: TwapSliceFill[]): Map<number, Fill[]> {
  const map = new Map<number, Fill[]>();
  for (const { twapId, fill } of list) {
    const arr = map.get(twapId) ?? [];
    if (arr.some((f) => f.tid === fill.tid)) continue;
    arr.push(fill);
    map.set(twapId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => b.time - a.time);
  return map;
}
```

Note: `Subscription` is imported here because Task 3 adds `TwapSubsLike` to this same file. If `npx tsc` flags `Subscription` as unused after this task, that is expected and resolved in Task 3 (do not remove it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest twap.test`
Expected: PASS (new + existing `normalizeActiveTwaps`/`twapProgressPct`).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/hyperliquid/twap.ts mobile/src/lib/hyperliquid/twap.test.ts
git commit --no-verify -m "feat(twap): normalizers for TWAP history + slice fills

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Info + Subscription client factories for slice fills

**Files:**
- Modify: `mobile/src/lib/hyperliquid/twap.ts` (extend `TwapInfoLike`, add `TwapSubsLike`)
- Modify: `mobile/src/lib/hyperliquid/client.ts` (extend `createTwapInfoClient`, add `createTwapSubsClient`)

Client factories wire the SDK and have no unit tests (consistent with the existing `createTwapInfoClient`); this task is verified by `npx tsc --noEmit`.

- [ ] **Step 1: Widen the injectable interfaces**

In `mobile/src/lib/hyperliquid/twap.ts`, replace the existing `TwapInfoLike` interface:

```ts
/** Minimal injectable Info surface for TWAP history (address-scoped). */
export interface TwapInfoLike {
  twapHistory(address: string): Promise<unknown>;
}
```

with:

```ts
/** Minimal injectable Info surface for TWAP history + slice fills (address-scoped). */
export interface TwapInfoLike {
  twapHistory(address: string): Promise<unknown>;
  userTwapSliceFills(address: string): Promise<unknown>;
}

/** Minimal injectable WebSocket surface for live TWAP slice fills. */
export interface TwapSubsLike {
  userTwapSliceFills(address: string, listener: (event: unknown) => void): Promise<Subscription>;
}
```

(The `Subscription` type import was added in Task 2.)

- [ ] **Step 2: Extend the Info client + add the Subs client**

In `mobile/src/lib/hyperliquid/client.ts`, replace the `createTwapInfoClient` function:

```ts
export function createTwapInfoClient(network: Network): TwapInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    twapHistory(args: { user: string }): Promise<unknown>;
  };
  return {
    twapHistory: (address) => info.twapHistory({ user: address }) as never,
  };
}
```

with:

```ts
export function createTwapInfoClient(network: Network): TwapInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    twapHistory(args: { user: string }): Promise<unknown>;
    userTwapSliceFills(args: { user: string }): Promise<unknown>;
  };
  return {
    twapHistory: (address) => info.twapHistory({ user: address }) as never,
    userTwapSliceFills: (address) => info.userTwapSliceFills({ user: address }) as never,
  };
}

export function createTwapSubsClient(network: Network): TwapSubsLike {
  const subs = new SubscriptionClient({
    transport: new WebSocketTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    userTwapSliceFills(args: { user: string }, cb: (e: unknown) => void): Promise<unknown>;
  };
  return {
    userTwapSliceFills: (address, listener) =>
      subs.userTwapSliceFills({ user: address }, (e) => listener(e)) as never,
  };
}
```

Then update the import at the top of `client.ts` from:

```ts
import type { TwapInfoLike } from "./twap";
```

to:

```ts
import type { TwapInfoLike, TwapSubsLike } from "./twap";
```

- [ ] **Step 3: Verify types compile**

Run: `cd mobile && npx tsc --noEmit`
Expected: exit 0 (no errors; the previously-unused `Subscription` import in `twap.ts` is now used by `TwapSubsLike`).

- [ ] **Step 4: Commit**

```bash
git add mobile/src/lib/hyperliquid/twap.ts mobile/src/lib/hyperliquid/client.ts
git commit --no-verify -m "feat(twap): Info + WS client factories for userTwapSliceFills

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: `TwapService` — loadHistory / loadSliceFills / subscribeSliceFills

**Files:**
- Modify: `mobile/src/services/twapData.ts`
- Test: `mobile/src/services/twapData.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `mobile/src/services/twapData.test.ts`:

```ts
describe("TwapService.loadHistory", () => {
  it("returns only finished/terminated/error entries, normalized", async () => {
    const raw = [
      { status: { status: "activated" }, twapId: 7, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "finished" }, twapId: 8, state: { coin: "ETH", side: "A", sz: "2", executedSz: "2", executedNtl: "5000", minutes: 20, reduceOnly: false, timestamp: 500 } },
    ];
    const info = { twapHistory: jest.fn(async () => raw), userTwapSliceFills: jest.fn() };
    const out = await new TwapService(info).loadHistory("0xabc");
    expect(info.twapHistory).toHaveBeenCalledWith("0xabc");
    expect(out).toEqual([{ twapId: 8, coin: "ETH", side: "sell", sz: 2, executedSz: 2, executedNtl: 5000, minutes: 20, reduceOnly: false, startedAt: 500, status: "finished" }]);
  });
});

describe("TwapService.loadSliceFills", () => {
  it("groups normalized slice fills by twapId", async () => {
    const raw = [
      { twapId: 8, fill: { coin: "ETH", px: "3000", sz: "0.5", side: "A", time: 200, startPosition: "0", dir: "Close Long", closedPnl: "1", hash: "0x", oid: 1, crossed: true, fee: "0.1", tid: 5, feeToken: "USDC", twapId: 8 } },
    ];
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn(async () => raw) };
    const map = await new TwapService(info).loadSliceFills("0xabc");
    expect(info.userTwapSliceFills).toHaveBeenCalledWith("0xabc");
    expect(map.get(8)).toMatchObject([{ tid: 5, coin: "ETH", side: "sell", px: 3000, sz: 0.5 }]);
  });
});

describe("TwapService.subscribeSliceFills", () => {
  it("normalizes the event's twapSliceFills before invoking the callback", async () => {
    let captured: ((e: unknown) => void) | null = null;
    const unsub = { unsubscribe: jest.fn(async () => {}) };
    const subs = { userTwapSliceFills: jest.fn(async (_addr: string, cb: (e: unknown) => void) => { captured = cb; return unsub; }) };
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn() };
    const cb = jest.fn();
    const sub = await new TwapService(info, subs).subscribeSliceFills("0xabc", cb);
    expect(subs.userTwapSliceFills).toHaveBeenCalledWith("0xabc", expect.any(Function));
    captured!({ twapSliceFills: [{ twapId: 8, fill: { coin: "ETH", px: "3000", sz: "0.5", side: "A", time: 200, startPosition: "0", dir: "x", closedPnl: "0", hash: "0x", oid: 1, crossed: true, fee: "0", tid: 5, feeToken: "USDC", twapId: 8 } }], isSnapshot: true });
    expect(cb).toHaveBeenCalledWith([expect.objectContaining({ twapId: 8, fill: expect.objectContaining({ tid: 5, side: "sell" }) })]);
    expect(sub).toBe(unsub);
  });

  it("throws if no subscription client was configured", async () => {
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn() };
    await expect(new TwapService(info).subscribeSliceFills("0xabc", jest.fn())).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest twapData.test`
Expected: FAIL — `loadHistory`/`loadSliceFills`/`subscribeSliceFills` do not exist and the constructor takes one arg.

- [ ] **Step 3: Widen `TwapService`**

Replace the entire contents of `mobile/src/services/twapData.ts` with:

```ts
import {
  normalizeActiveTwaps,
  normalizeTwapHistory,
  normalizeSliceFills,
  groupSliceFillsByTwapId,
  type ActiveTwap,
  type TwapHistoryEntry,
  type TwapSliceFill,
  type TwapInfoLike,
  type TwapSubsLike,
} from "../lib/hyperliquid/twap";
import type { Fill, Subscription } from "../lib/hyperliquid/types";

/** Loads a user's TWAPs (active + history), slice fills, and live slice-fill updates. */
export class TwapService {
  constructor(private info: TwapInfoLike, private subs?: TwapSubsLike) {}

  /** Currently-running TWAPs for an address, normalized. */
  async loadActive(address: string): Promise<ActiveTwap[]> {
    return normalizeActiveTwaps(await this.info.twapHistory(address));
  }

  /** Finished/terminated/error TWAPs for an address, newest first. */
  async loadHistory(address: string): Promise<TwapHistoryEntry[]> {
    return normalizeTwapHistory(await this.info.twapHistory(address));
  }

  /** Slice fills for an address, grouped by twapId (newest first per group). */
  async loadSliceFills(address: string): Promise<Map<number, Fill[]>> {
    return groupSliceFillsByTwapId(normalizeSliceFills(await this.info.userTwapSliceFills(address)));
  }

  /** Subscribe to live slice fills; the callback receives normalized `TwapSliceFill[]`. */
  async subscribeSliceFills(address: string, cb: (fills: TwapSliceFill[]) => void): Promise<Subscription> {
    if (!this.subs) throw new Error("twap subscription client not configured");
    return this.subs.userTwapSliceFills(address, (event) => {
      const raw = (event as { twapSliceFills?: unknown })?.twapSliceFills;
      cb(normalizeSliceFills(raw));
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest twapData.test`
Expected: PASS (new + existing `loadActive`).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/twapData.ts mobile/src/services/twapData.test.ts
git commit --no-verify -m "feat(twap): TwapService loadHistory/loadSliceFills/subscribeSliceFills

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: PositionsScreen — history list + expandable slice detail (static)

**Files:**
- Modify: `mobile/src/screens/PositionsScreen.tsx`
- Modify: `mobile/src/i18n/messages.ts` (en + zh)
- Test: `mobile/src/screens/PositionsScreen.test.tsx`

This task renders history + slice detail from data returned by injected deps. The WS wiring is Task 6.

- [ ] **Step 1: Add i18n keys (en + zh)**

In `mobile/src/i18n/messages.ts`, in the ENGLISH block, add after the existing `"positions.emptyTwaps"` entry:

```ts
    "positions.twapHistoryTitle": "TWAP history",
    "positions.noTwapHistory": "No completed TWAPs",
    "positions.twapStatusFinished": "Filled",
    "positions.twapStatusTerminated": "Cancelled",
    "positions.twapStatusError": "Error",
    "positions.twapSlicesEmpty": "No slice fills yet",
    "positions.twapSlicesTitle": "Slice fills",
```

In the CHINESE block, add after its `"positions.emptyTwaps"` entry:

```ts
    "positions.twapHistoryTitle": "TWAP 历史",
    "positions.noTwapHistory": "暂无已完成 TWAP",
    "positions.twapStatusFinished": "已完成",
    "positions.twapStatusTerminated": "已取消",
    "positions.twapStatusError": "错误",
    "positions.twapSlicesEmpty": "暂无 slice 成交",
    "positions.twapSlicesTitle": "Slice 成交",
```

- [ ] **Step 2: Write the failing tests**

First, update every TWAP fake in `mobile/src/screens/PositionsScreen.test.tsx` so `runQuery`'s new calls exist. Change the shared `fakeDeps.twap` (currently `twap: { loadActive: jest.fn(async () => activeTwaps) } as unknown as TwapService`) to:

```ts
  twap: {
    loadActive: jest.fn(async () => activeTwaps),
    loadHistory: jest.fn(async () => twapHistory),
    loadSliceFills: jest.fn(async () => sliceFillsByTwapId),
    subscribeSliceFills: jest.fn(async () => ({ unsubscribe: jest.fn(async () => {}) })),
  } as unknown as TwapService,
```

Add these fixtures near the other fixtures (after `activeTwaps`), and extend the existing `import type { ActiveTwap } from "../lib/hyperliquid/twap";` line to `import type { ActiveTwap, TwapHistoryEntry } from "../lib/hyperliquid/twap";`:

```ts
const twapHistory: TwapHistoryEntry[] = [
  { twapId: 8, coin: "ETH", side: "sell", sz: 2, executedSz: 2, executedNtl: 5000, minutes: 20, reduceOnly: false, startedAt: 500, status: "finished" },
];
const sliceFillsByTwapId = new Map<number, Fill[]>([
  [7, [{ coin: "BTC", px: 60000, sz: 0.2, side: "buy", time: 1100, closedPnl: 0, dir: "Open Long", fee: 0.1, builderFee: 0, feeToken: "USDC", oid: 2, tid: 21, hash: "0x", crossed: true }]],
]);
```

For the three inline `deps` objects in the file that use `twap: { loadActive: jest.fn(async () => []) } as unknown as TwapService`, replace each with:

```ts
      twap: { loadActive: jest.fn(async () => []), loadHistory: jest.fn(async () => []), loadSliceFills: jest.fn(async () => new Map()), subscribeSliceFills: jest.fn(async () => ({ unsubscribe: jest.fn(async () => {}) })) } as unknown as TwapService,
```

Also add to `beforeEach` after the existing `(fakeDeps.twap.loadActive as jest.Mock).mockClear();`:

```ts
    (fakeDeps.twap.loadHistory as jest.Mock).mockClear();
    (fakeDeps.twap.loadSliceFills as jest.Mock).mockClear();
    (fakeDeps.twap.subscribeSliceFills as jest.Mock).mockClear();
```

Then append these tests inside the `describe("PositionsScreen", ...)` block:

```ts
  it("renders the TWAP history list with a status label", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    fireEvent.press(await screen.findByTestId("tab-twap"));
    expect(await screen.findByTestId("twap-history-8")).toBeTruthy();
    expect(screen.getByText("Filled")).toBeTruthy();
  });

  it("expands a TWAP row to show its slice fills", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    fireEvent.press(await screen.findByTestId("tab-twap"));
    fireEvent.press(await screen.findByTestId("twap-row-7"));
    expect(await screen.findByTestId("twap-slices-7")).toBeTruthy();
  });
```

Note: the tab `Pressable` currently has no testID. In Step 3 you will add `testID={`tab-${key}`}` to the tab `Pressable`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd mobile && npx jest PositionsScreen`
Expected: FAIL — `tab-twap` / `twap-history-8` / `twap-row-7` / `twap-slices-7` not found.

- [ ] **Step 4: Implement the UI**

4a. In `mobile/src/screens/PositionsScreen.tsx`, add a `testID` to the tab `Pressable`. Find:

```tsx
                <Pressable
                  key={key}
                  onPress={() => setTab(key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.tabItem, { borderBottomColor: active ? theme.brand : "transparent" }]}
                >
```

Replace with (add the `testID` line):

```tsx
                <Pressable
                  key={key}
                  testID={`tab-${key}`}
                  onPress={() => setTab(key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.tabItem, { borderBottomColor: active ? theme.brand : "transparent" }]}
                >
```

4b. Add the new imports/state. Find the existing TWAP state lines:

```tsx
  const [activeTwaps, setActiveTwaps] = useState<ActiveTwap[]>([]);
  const [twapError, setTwapError] = useState<FetchErrorCode | null>(null);
```

Replace with:

```tsx
  const [activeTwaps, setActiveTwaps] = useState<ActiveTwap[]>([]);
  const [twapHistory, setTwapHistory] = useState<TwapHistoryEntry[]>([]);
  const [sliceFills, setSliceFills] = useState<Map<number, Fill[]>>(new Map());
  const [expandedTwapId, setExpandedTwapId] = useState<number | null>(null);
  const [twapError, setTwapError] = useState<FetchErrorCode | null>(null);
```

Update the import from `../lib/hyperliquid/twap` (currently `import { twapProgressPct, type ActiveTwap } from "../lib/hyperliquid/twap";`) to:

```tsx
import { twapProgressPct, type ActiveTwap, type TwapHistoryEntry } from "../lib/hyperliquid/twap";
```

Ensure `Fill` is imported from `../lib/hyperliquid/types` (it is already imported there for `FillRow`; if not, add it).

4c. In `runQuery`, after the existing `void services.twap.loadActive(addr).then(setActiveTwaps).catch(...)` line, add:

```tsx
      void services.twap.loadHistory(addr).then(setTwapHistory).catch((e) => setTwapError(classifyFetchError(e)));
      void services.twap.loadSliceFills(addr).then(setSliceFills).catch(() => {});
```

4d. Replace the `tab === "twap"` render block. Find:

```tsx
          {tab === "twap" ? (
            twapError && activeTwaps.length === 0 ? (
              <LoadError theme={theme} code={twapError} compact onRetry={() => runQuery(walletAddress ?? "")} testID="twap-error" />
            ) : activeTwaps.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyTwaps")}</Text>
            ) : (
              activeTwaps.map((tw) => <TwapRow key={tw.twapId} twap={tw} theme={theme} onCancel={cancelTwap} />)
            )
          ) : null}
```

Replace with:

```tsx
          {tab === "twap" ? (
            <>
              {twapError && activeTwaps.length === 0 ? (
                <LoadError theme={theme} code={twapError} compact onRetry={() => runQuery(walletAddress ?? "")} testID="twap-error" />
              ) : activeTwaps.length === 0 ? (
                <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyTwaps")}</Text>
              ) : (
                activeTwaps.map((tw) => (
                  <TwapRow
                    key={tw.twapId}
                    twap={tw}
                    theme={theme}
                    onCancel={cancelTwap}
                    expanded={expandedTwapId === tw.twapId}
                    onToggle={() => setExpandedTwapId(expandedTwapId === tw.twapId ? null : tw.twapId)}
                    slices={sliceFills.get(tw.twapId) ?? []}
                  />
                ))
              )}

              <Text style={[styles.sectionTitle, { color: theme.muted }]}>{t("positions.twapHistoryTitle")}</Text>
              {twapHistory.length === 0 ? (
                <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.noTwapHistory")}</Text>
              ) : (
                twapHistory.map((h, i) => (
                  <TwapHistoryRow
                    key={h.twapId ?? `h${i}`}
                    entry={h}
                    theme={theme}
                    expanded={h.twapId !== null && expandedTwapId === h.twapId}
                    onToggle={h.twapId === null ? undefined : () => setExpandedTwapId(expandedTwapId === h.twapId ? null : h.twapId)}
                    slices={h.twapId !== null ? sliceFills.get(h.twapId) ?? [] : []}
                  />
                ))
              )}
            </>
          ) : null}
```

4e. Replace the existing `TwapRow` function with an expandable version plus new `TwapHistoryRow` + `TwapSliceList` components. Find the whole existing `function TwapRow(...) { ... }` block and replace it with:

```tsx
function TwapSliceList({ slices, theme }: { slices: Fill[]; theme: ThemeTokens }) {
  const t = useT();
  return (
    <View testID="__slices__" style={[styles.sliceBox, { borderLeftColor: theme.line }]}>
      <Text style={[styles.rowSub, { color: theme.muted }]}>{t("positions.twapSlicesTitle")}</Text>
      {slices.length === 0 ? (
        <Text style={[styles.rowSub, { color: theme.muted }]}>{t("positions.twapSlicesEmpty")}</Text>
      ) : (
        slices.map((f) => (
          <View key={f.tid} style={styles.sliceRow}>
            <Text style={[styles.rowSub, { color: theme.muted }]}>{new Date(f.time).toLocaleTimeString()}</Text>
            <Text style={[styles.rowSub, { color: theme.text }]}>{`${f.sz} @ ${f.px} · $${Math.round(f.sz * f.px)}`}</Text>
          </View>
        ))
      )}
    </View>
  );
}

function TwapRow({
  twap, theme, onCancel, expanded, onToggle, slices,
}: {
  twap: ActiveTwap; theme: ThemeTokens; onCancel?: (t: ActiveTwap) => void;
  expanded: boolean; onToggle: () => void; slices: Fill[];
}) {
  const t = useT();
  const sideColor = twap.side === "buy" ? theme.up : theme.down;
  const pct = Math.round(twapProgressPct(twap));
  return (
    <View testID={`twap-${twap.twapId}`}>
      <Pressable onPress={onToggle} accessibilityRole="button" testID={`twap-row-${twap.twapId}`} style={[styles.row, { borderBottomColor: theme.line }]}>
        <View>
          <Text style={[styles.rowCoin, { color: theme.text }]}>
            {twap.coin} <Text style={{ color: sideColor }}>{t(twap.side === "buy" ? "common.buy" : "common.sell")}</Text>
            {twap.reduceOnly ? <Text style={{ color: theme.muted }}> {t("positions.reduceOnly")}</Text> : null}
          </Text>
          <Text style={[styles.rowSub, { color: theme.muted }]}>
            {t("positions.twapProgress", { done: twap.executedSz, total: twap.sz, pct, ntl: Math.round(twap.executedNtl), minutes: twap.minutes })}
          </Text>
        </View>
        <View style={styles.rowRight}>
          {onCancel ? (
            <Pressable
              accessibilityRole="button"
              testID={`twap-cancel-${twap.twapId}`}
              onPress={() => onCancel(twap)}
              style={[styles.cancelBtn, { borderColor: theme.lineStrong }]}
            >
              <Text style={[styles.cancelText, { color: theme.down }]}>{t("positions.cancelOrder")}</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
      {expanded ? (
        <View testID={`twap-slices-${twap.twapId}`}>
          <TwapSliceList slices={slices} theme={theme} />
        </View>
      ) : null}
    </View>
  );
}

function twapStatusLabelKey(status: TwapHistoryEntry["status"]): TranslationKey {
  return status === "finished" ? "positions.twapStatusFinished" : status === "terminated" ? "positions.twapStatusTerminated" : "positions.twapStatusError";
}

function TwapHistoryRow({
  entry, theme, expanded, onToggle, slices,
}: {
  entry: TwapHistoryEntry; theme: ThemeTokens; expanded: boolean; onToggle?: () => void; slices: Fill[];
}) {
  const t = useT();
  const sideColor = entry.side === "buy" ? theme.up : theme.down;
  const pct = entry.sz > 0 ? Math.round(Math.max(0, Math.min(100, (entry.executedSz / entry.sz) * 100))) : 0;
  return (
    <View testID={`twap-history-${entry.twapId ?? "x"}`}>
      <Pressable onPress={onToggle} accessibilityRole="button" testID={`twap-history-row-${entry.twapId ?? "x"}`} style={[styles.row, { borderBottomColor: theme.line }]}>
        <View>
          <Text style={[styles.rowCoin, { color: theme.text }]}>
            {entry.coin} <Text style={{ color: sideColor }}>{t(entry.side === "buy" ? "common.buy" : "common.sell")}</Text>
          </Text>
          <Text style={[styles.rowSub, { color: theme.muted }]}>
            {t("positions.twapProgress", { done: entry.executedSz, total: entry.sz, pct, ntl: Math.round(entry.executedNtl), minutes: entry.minutes })}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={[styles.statusPill, { color: theme.muted, borderColor: theme.line }]}>{t(twapStatusLabelKey(entry.status))}</Text>
        </View>
      </Pressable>
      {expanded ? (
        <View testID={`twap-slices-${entry.twapId}`}>
          <TwapSliceList slices={slices} theme={theme} />
        </View>
      ) : null}
    </View>
  );
}
```

4f. Add the new style entries. In the `StyleSheet.create({ ... })` for this screen, add these keys (place near the other `row*` entries):

```ts
  sectionTitle: { fontFamily: fonts.body.regular, fontSize: 11, letterSpacing: 0.4, marginTop: 20, marginBottom: 6, textTransform: "uppercase" },
  sliceBox: { borderLeftWidth: 2, paddingLeft: 10, paddingVertical: 6, marginBottom: 6 },
  sliceRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  statusPill: { fontFamily: fonts.mono.bold, fontSize: 9, letterSpacing: 0.4, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
```

Ensure `TranslationKey` is imported in this file (it is already used by the `tabs` array type `Array<[Tab, TranslationKey, number]>`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mobile && npx jest PositionsScreen`
Expected: PASS (new history/expand tests + all existing PositionsScreen tests, including `twap-7` and `twap-cancel-7`).

- [ ] **Step 6: Guards**

Run: `cd mobile && npx tsc --noEmit && npx jest noHardcodedColors messages`
Expected: PASS — tsc clean; `noHardcodedColors` green (all colors from theme); `messages` green (en/zh parity for the new keys).

- [ ] **Step 7: Commit**

```bash
git add mobile/src/screens/PositionsScreen.tsx mobile/src/screens/PositionsScreen.test.tsx mobile/src/i18n/messages.ts
git commit --no-verify -m "feat(twap): Positions TWAP history list + expandable slice detail

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: PositionsScreen — live WS slice fills (append + optimistic progress + debounced reconcile)

**Files:**
- Modify: `mobile/src/screens/PositionsScreen.tsx`
- Test: `mobile/src/screens/PositionsScreen.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("PositionsScreen", ...)` block in `mobile/src/screens/PositionsScreen.test.tsx`:

```ts
  it("appends a live WS slice fill and optimistically bumps active-TWAP progress, then reconciles", async () => {
    jest.useFakeTimers();
    let captured: ((fills: unknown[]) => void) | null = null;
    const deps = {
      positions: { loadPortfolio: jest.fn(async () => portfolio) } as unknown as PositionsService,
      fills: { loadRecent: jest.fn(async () => []) } as unknown as FillsService,
      orders: { loadOpenOrders: jest.fn(async () => []) } as unknown as OrdersService,
      twap: {
        loadActive: jest.fn(async () => activeTwaps),
        loadHistory: jest.fn(async () => []),
        loadSliceFills: jest.fn(async () => new Map()),
        subscribeSliceFills: jest.fn(async (_addr: string, cb: (f: unknown[]) => void) => { captured = cb; return { unsubscribe: jest.fn(async () => {}) }; }),
      } as unknown as TwapService,
    };
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={deps} />);
    await waitFor(() => expect(deps.twap.subscribeSliceFills).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId("tab-twap"));

    const loadActiveCallsBefore = (deps.twap.loadActive as jest.Mock).mock.calls.length;
    act(() => {
      captured!([{ twapId: 7, fill: { coin: "BTC", px: 60000, sz: 0.2, side: "buy", time: 1100, closedPnl: 0, dir: "Open Long", fee: 0, builderFee: 0, feeToken: "USDC", oid: 3, tid: 31, hash: "0x", crossed: true } }]);
    });
    fireEvent.press(await screen.findByTestId("twap-row-7"));
    expect(await screen.findByTestId("twap-slices-7")).toBeTruthy();

    act(() => { jest.advanceTimersByTime(1600); });
    await waitFor(() => expect((deps.twap.loadActive as jest.Mock).mock.calls.length).toBeGreaterThan(loadActiveCallsBefore));
    jest.useRealTimers();
  });
```

Add `act` to the imports from `@testing-library/react-native` in this test file if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mobile && npx jest PositionsScreen -t "live WS slice fill"`
Expected: FAIL — no subscription is wired, so the slice detail never updates and `loadActive` is not re-called after the debounce.

- [ ] **Step 3: Wire the WS subscription**

3a. In `mobile/src/screens/PositionsScreen.tsx`, provide the subscription client to the service. Find the services `useMemo`:

```tsx
        twap: new TwapService(createTwapInfoClient(network)),
```

Replace with:

```tsx
        twap: new TwapService(createTwapInfoClient(network), createTwapSubsClient(network)),
```

Update the client import to include `createTwapSubsClient`. Find:

```tsx
import { createPositionsInfoClient, createFillsInfoClient, createOrdersInfoClient, createTwapInfoClient, createExchangeClient } from "../lib/hyperliquid/client";
```

(If the exact import line differs, add `createTwapSubsClient` to the existing import from `../lib/hyperliquid/client`.)

Add these imports at the top of the file if not present:

```tsx
import { useEffect, useRef } from "react";
```

(The file already imports React hooks; add `useRef` to the existing `react` import and ensure `useEffect` is imported.)

Also import the slice-fill type + merge helper. Update the `../lib/hyperliquid/twap` import to include `TwapSliceFill` and `groupSliceFillsByTwapId`:

```tsx
import { twapProgressPct, groupSliceFillsByTwapId, type ActiveTwap, type TwapHistoryEntry, type TwapSliceFill } from "../lib/hyperliquid/twap";
```

3b. Add the live-subscription effect. Insert this block immediately AFTER the existing `useEffect` that calls `runQuery` on wallet change:

```tsx
  // Live TWAP slice fills over WS: append to slice detail, optimistically bump active-TWAP
  // progress, and debounce-refetch twapHistory to reconcile the authoritative state.
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode === "none" || !walletAddress || !isValidAddress(walletAddress)) return;
    const addr = walletAddress;
    let sub: { unsubscribe: () => void | Promise<void> } | null = null;
    let cancelled = false;

    const onSlice = (fills: TwapSliceFill[]) => {
      if (fills.length === 0) return;
      setSliceFills((prev) => {
        const merged: TwapSliceFill[] = [];
        for (const [twapId, arr] of prev) for (const f of arr) merged.push({ twapId, fill: f });
        for (const f of fills) merged.push(f);
        return groupSliceFillsByTwapId(merged);
      });
      setActiveTwaps((prev) =>
        prev.map((tw) => {
          const mine = fills.filter((f) => f.twapId === tw.twapId);
          if (mine.length === 0) return tw;
          const addSz = mine.reduce((n, f) => n + f.fill.sz, 0);
          const addNtl = mine.reduce((n, f) => n + f.fill.sz * f.fill.px, 0);
          return { ...tw, executedSz: Math.min(tw.sz, tw.executedSz + addSz), executedNtl: tw.executedNtl + addNtl };
        }),
      );
      if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
      reconcileTimer.current = setTimeout(() => {
        void services.twap.loadActive(addr).then(setActiveTwaps).catch(() => {});
        void services.twap.loadHistory(addr).then(setTwapHistory).catch(() => {});
      }, 1500);
    };

    void services.twap
      .subscribeSliceFills(addr, onSlice)
      .then((s) => { if (cancelled) void s.unsubscribe(); else sub = s; })
      .catch((e) => setTwapError(classifyFetchError(e)));

    return () => {
      cancelled = true;
      if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
      void sub?.unsubscribe();
    };
  }, [mode, walletAddress, services]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mobile && npx jest PositionsScreen -t "live WS slice fill"`
Expected: PASS.

- [ ] **Step 5: Full PositionsScreen suite + guards**

Run: `cd mobile && npx jest PositionsScreen && npx tsc --noEmit && npx jest noHardcodedColors messages`
Expected: PASS across the board (existing tests unaffected; the subscribe fake resolves to an unsubscribe handle).

- [ ] **Step 6: Commit**

```bash
git add mobile/src/screens/PositionsScreen.tsx mobile/src/screens/PositionsScreen.test.tsx
git commit --no-verify -m "feat(twap): live WS slice fills with optimistic progress + debounced reconcile

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification

- [ ] `cd mobile && npx tsc --noEmit` — exit 0.
- [ ] `cd mobile && npx jest` — all pass, ≥ 770 baseline + new tests.
- [ ] `cd mobile && npx jest noHardcodedColors messages` — both green.
- [ ] server / backend(Go): untouched — no run required.
- [ ] Open PR `feat/twap-monitoring-deep` → `main`; wait for CI green (mobile/server/backend jobs); code-review; merge with `gh pr merge <n> --merge`.

## Notes / Out of Scope

- Server strategy-engine TWAP (`server/src/strategies/twap.ts`) is untouched — this feature is the Trade-side native HL TWAP monitor only.
- No new navigation screen — history + slice detail are inline in the Positions "twap" tab (approach A).
- Slice rows show time · size @ price · $notional only (no per-slice fee/PnL analytics).
- WS degrades gracefully: a failed subscribe surfaces via the existing `twapError`/`classifyFetchError` channel; Info snapshot + manual refresh still work.
