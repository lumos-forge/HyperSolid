# TWAP Monitoring + Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "active TWAP" monitoring tab to the Positions screen (polled from `twapHistory`, filtered to running) with a per-row Cancel that signs an HL `twapCancel`.

**Architecture:** Pure normalizer (`lib/hyperliquid/twap.ts`) → poll service (`TwapService`) → a 4th Positions segment tab that reuses the screen's on-demand signing `ExchangeService` for cancel. Mirrors the existing orders tab end-to-end. Mobile-only; no server changes.

**Tech Stack:** Expo SDK 56 / React Native 0.85 / TypeScript / `@nktkas/hyperliquid` (`InfoClient.twapHistory`, `ExchangeClient.twapCancel`) / Jest + @testing-library/react-native v14. Spec: `docs/superpowers/specs/2026-07-03-twap-monitor-cancel-design.md`.

---

## Baselines (must stay green)

- **Mobile:** `cd mobile && npx tsc --noEmit` → 0 errors; `npx jest` → **756 tests / 130 suites**; plus `npx jest noHardcodedColors` and `npx jest messages` stay green.
- (Server is untouched — do not run or modify it.)

## Conventions (apply to every task)

- **TDD:** write the failing test first, run it and watch it fail, implement minimally, run it and watch it pass, commit.
- **Commit:** `git commit --no-verify -m "<msg>"` with trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Commit per task; push only when the user says so.
- **Mobile conventions:** colors via theme tokens only (no hex outside `src/theme/`); no emoji; all user-facing strings via `useT()` with keys in BOTH en + zh (parity enforced by `messages.test`).
- **No real network / no real signing in tests:** inject fakes; the Positions screen already mocks `../services/exchange` and `../lib/hyperliquid/client`.

## File Structure

- `mobile/src/lib/hyperliquid/twap.ts` *(new)* — `ActiveTwap` type, `TwapInfoLike`, `normalizeActiveTwaps`, `twapProgressPct`.
- `mobile/src/services/twapData.ts` *(new)* — `TwapService.loadActive(address)`.
- `mobile/src/lib/hyperliquid/client.ts` — `createTwapInfoClient(network)`.
- `mobile/src/lib/hyperliquid/cancel.ts` — `buildTwapCancel(coin, twapId, index)`.
- `mobile/src/services/exchange.ts` — `ExchangeLike.twapCancel` + `ExchangeService.cancelTwap`.
- `mobile/src/i18n/messages.ts` — `positions.*` twap keys (en + zh).
- `mobile/src/screens/PositionsScreen.tsx` — the TWAP tab + `TwapRow` + cancel handler.

---

## Task 1: Pure TWAP normalizer (`lib/hyperliquid/twap.ts`)

**Files:**
- Create: `mobile/src/lib/hyperliquid/twap.ts`
- Test: `mobile/src/lib/hyperliquid/twap.test.ts`

- [ ] **Step 1: Write the failing test** — create `mobile/src/lib/hyperliquid/twap.test.ts`:

```ts
import { normalizeActiveTwaps, twapProgressPct, type ActiveTwap } from "./twap";

const running = {
  status: { status: "activated" },
  twapId: 7,
  state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 },
};
const finished = {
  status: { status: "finished" },
  twapId: 8,
  state: { coin: "ETH", side: "A", sz: "2", executedSz: "2", executedNtl: "5000", minutes: 10, reduceOnly: false, timestamp: 900 },
};
const noId = {
  status: { status: "activated" },
  state: { coin: "SOL", side: "A", sz: "3", executedSz: "0", executedNtl: "0", minutes: 15, reduceOnly: true, timestamp: 800 },
};

describe("normalizeActiveTwaps", () => {
  it("keeps only activated entries that have a numeric twapId, mapping side + fields", () => {
    expect(normalizeActiveTwaps([running, finished, noId])).toEqual([
      { twapId: 7, coin: "BTC", side: "buy", sz: 1, executedSz: 0.4, executedNtl: 24000, minutes: 30, reduceOnly: false, startedAt: 1000 },
    ]);
  });
  it("maps sell side (A) and reduceOnly", () => {
    const s = { status: { status: "activated" }, twapId: 9, state: { coin: "ETH", side: "A", sz: "2", executedSz: "1", executedNtl: "1800", minutes: 20, reduceOnly: true, timestamp: 500 } };
    expect(normalizeActiveTwaps([s])[0]).toMatchObject({ side: "sell", reduceOnly: true });
  });
  it("returns [] for a non-array or empty input", () => {
    expect(normalizeActiveTwaps(null)).toEqual([]);
    expect(normalizeActiveTwaps([])).toEqual([]);
  });
});

describe("twapProgressPct", () => {
  const t: ActiveTwap = { twapId: 1, coin: "BTC", side: "buy", sz: 2, executedSz: 0.5, executedNtl: 1, minutes: 30, reduceOnly: false, startedAt: 0 };
  it("is executed/total as a percent", () => {
    expect(twapProgressPct(t)).toBe(25);
  });
  it("clamps to [0,100] and is 0 for non-positive size", () => {
    expect(twapProgressPct({ ...t, executedSz: 5 })).toBe(100);
    expect(twapProgressPct({ ...t, sz: 0 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/hyperliquid/twap.test.ts`
Expected: FAIL (`Cannot find module './twap'`).

- [ ] **Step 3: Implement** — create `mobile/src/lib/hyperliquid/twap.ts`:

```ts
/** A currently-running TWAP, normalized from HL `twapHistory` for display + cancel. */
export interface ActiveTwap {
  twapId: number;
  coin: string;
  side: "buy" | "sell";
  sz: number;          // total base size
  executedSz: number;  // base size filled so far
  executedNtl: number; // USDC notional filled so far
  minutes: number;     // configured duration
  reduceOnly: boolean;
  startedAt: number;   // ms epoch (state.timestamp)
}

/** Minimal injectable Info surface for TWAP history (address-scoped). */
export interface TwapInfoLike {
  twapHistory(address: string): Promise<unknown>;
}

interface RawTwap {
  status?: { status?: string };
  twapId?: unknown;
  state?: {
    coin?: string; side?: string; sz?: string; executedSz?: string;
    executedNtl?: string; minutes?: number; reduceOnly?: boolean; timestamp?: number;
  };
}

/** Keep only `activated` entries with a numeric `twapId` (others can't be cancelled), normalized. */
export function normalizeActiveTwaps(history: unknown): ActiveTwap[] {
  if (!Array.isArray(history)) return [];
  const out: ActiveTwap[] = [];
  for (const raw of history as RawTwap[]) {
    if (raw?.status?.status !== "activated") continue;
    if (typeof raw.twapId !== "number") continue;
    const s = raw.state ?? {};
    out.push({
      twapId: raw.twapId,
      coin: s.coin ?? "",
      side: s.side === "A" ? "sell" : "buy",
      sz: Number(s.sz ?? 0),
      executedSz: Number(s.executedSz ?? 0),
      executedNtl: Number(s.executedNtl ?? 0),
      minutes: Number(s.minutes ?? 0),
      reduceOnly: Boolean(s.reduceOnly),
      startedAt: Number(s.timestamp ?? 0),
    });
  }
  return out;
}

/** Fill progress as a percent in [0,100]. */
export function twapProgressPct(t: ActiveTwap): number {
  if (!(t.sz > 0)) return 0;
  return Math.max(0, Math.min(100, (t.executedSz / t.sz) * 100));
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/hyperliquid/twap.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/hyperliquid/twap.ts mobile/src/lib/hyperliquid/twap.test.ts
git commit --no-verify -m "feat(mobile): normalize active TWAPs from twapHistory

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `TwapService` + `createTwapInfoClient`

**Files:**
- Create: `mobile/src/services/twapData.ts`
- Modify: `mobile/src/lib/hyperliquid/client.ts`
- Test: `mobile/src/services/twapData.test.ts`

- [ ] **Step 1: Write the failing test** — create `mobile/src/services/twapData.test.ts`:

```ts
import { TwapService } from "./twapData";

describe("TwapService.loadActive", () => {
  it("calls twapHistory with the address and returns normalized active twaps", async () => {
    const raw = [
      { status: { status: "activated" }, twapId: 7, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "terminated" }, twapId: 8, state: { coin: "ETH", side: "A", sz: "2", executedSz: "1", executedNtl: "1800", minutes: 20, reduceOnly: false, timestamp: 500 } },
    ];
    const info = { twapHistory: jest.fn(async () => raw) };
    const svc = new TwapService(info);
    const out = await svc.loadActive("0xabc");
    expect(info.twapHistory).toHaveBeenCalledWith("0xabc");
    expect(out).toEqual([
      { twapId: 7, coin: "BTC", side: "buy", sz: 1, executedSz: 0.4, executedNtl: 24000, minutes: 30, reduceOnly: false, startedAt: 1000 },
    ]);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/services/twapData.test.ts`
Expected: FAIL (`Cannot find module './twapData'`).

- [ ] **Step 3: Implement**

3a. Create `mobile/src/services/twapData.ts`:
```ts
import { normalizeActiveTwaps, type ActiveTwap, type TwapInfoLike } from "../lib/hyperliquid/twap";

/** Polls a user's running TWAPs (mirrors OrdersService/FillsService). */
export class TwapService {
  constructor(private info: TwapInfoLike) {}

  /** Currently-running TWAPs for an address, normalized. */
  async loadActive(address: string): Promise<ActiveTwap[]> {
    return normalizeActiveTwaps(await this.info.twapHistory(address));
  }
}
```

3b. In `mobile/src/lib/hyperliquid/client.ts`, add a factory next to `createOrdersInfoClient`. First add the type import at the top of the file (merge with existing imports from "./twap" if any, otherwise add):
```ts
import type { TwapInfoLike } from "./twap";
```
Then add (mirroring `createOrdersInfoClient`):
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

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/services/twapData.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors (confirms `createTwapInfoClient` type-checks against `InfoClient`).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/twapData.ts mobile/src/lib/hyperliquid/client.ts mobile/src/services/twapData.test.ts
git commit --no-verify -m "feat(mobile): TwapService + createTwapInfoClient (poll active TWAPs)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `buildTwapCancel` builder

**Files:**
- Modify: `mobile/src/lib/hyperliquid/cancel.ts`
- Test: `mobile/src/lib/hyperliquid/cancel.test.ts`

- [ ] **Step 1: Write the failing test** — append to `mobile/src/lib/hyperliquid/cancel.test.ts` (it already imports from `./cancel` and builds an `AssetIndex` — reuse that file's existing `index`/import setup; if it constructs the index via `buildAssetIndex`, reuse it):

```ts
import { buildTwapCancel } from "./cancel";

describe("buildTwapCancel", () => {
  it("builds a twapCancel action with the asset id + twap id", () => {
    // reuse this file's existing asset index (BTC → 0); if the file names it differently, match that.
    const res = buildTwapCancel("BTC", 42, index);
    expect(res).toEqual({ ok: true, params: { a: 0, t: 42 } });
  });
  it("rejects an unknown asset", () => {
    expect(buildTwapCancel("NOPE", 42, index)).toEqual({ ok: false, rejection: "unknownAsset" });
  });
});
```
(If `cancel.test.ts` does not already have an `index` in scope, add at the top: `import { buildAssetIndex } from "./assetId";` and `const index = buildAssetIndex({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] });` — but first check the file; reuse an existing index to avoid duplication.)

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/hyperliquid/cancel.test.ts -t "buildTwapCancel"`
Expected: FAIL (`buildTwapCancel` not exported).

- [ ] **Step 3: Implement** — in `mobile/src/lib/hyperliquid/cancel.ts`, add the params type + result type + builder (next to `buildCancel`):

```ts
/** twapCancel action: { a, t } — asset id + twap id. */
export interface HlTwapCancelParams {
  a: number;
  t: number;
}

export type TwapCancelResult =
  | { ok: true; params: HlTwapCancelParams }
  | { ok: false; rejection: "unknownAsset" };

export function buildTwapCancel(coin: string, twapId: number, index: AssetIndex): TwapCancelResult {
  const asset = index.id(coin);
  if (asset === null) return { ok: false, rejection: "unknownAsset" };
  return { ok: true, params: { a: asset, t: twapId } };
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/hyperliquid/cancel.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/hyperliquid/cancel.ts mobile/src/lib/hyperliquid/cancel.test.ts
git commit --no-verify -m "feat(mobile): buildTwapCancel action builder

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: `ExchangeService.cancelTwap`

**Files:**
- Modify: `mobile/src/services/exchange.ts`
- Test: `mobile/src/services/exchange.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the top-level `describe` in `mobile/src/services/exchange.test.ts`. This file builds `const index = buildAssetIndex(meta)` (BTC → 0) and a `fakeClient()` factory; add `twapCancel` to that fake and a test:

First, add `twapCancel` to the `fakeClient()` return object (next to `twapOrder`):
```ts
    twapCancel: jest.fn(async () => ({ status: "ok", response: { data: { status: "success" } } })),
```
Then add the tests:
```ts
describe("cancelTwap", () => {
  it("cancels by asset id + twap id", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.cancelTwap("BTC", 42);
    expect(r.ok).toBe(true);
    expect(client.twapCancel).toHaveBeenCalledWith({ a: 0, t: 42 });
  });
  it("fails safe on an unknown coin without signing", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.cancelTwap("NOPE", 42);
    expect(r.ok).toBe(false);
    expect(client.twapCancel).not.toHaveBeenCalled();
  });
  it("reports an uncertain receipt when twapCancel throws", async () => {
    const client = fakeClient();
    (client.twapCancel as jest.Mock).mockRejectedValueOnce(new Error("网络超时"));
    const svc = new ExchangeService(client, index);
    const r = await svc.cancelTwap("BTC", 42);
    expect(r).toMatchObject({ ok: false, uncertain: true });
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/services/exchange.test.ts -t "cancelTwap"`
Expected: FAIL (`svc.cancelTwap` is not a function; `twapCancel` not on the interface).

- [ ] **Step 3: Implement** — edit `mobile/src/services/exchange.ts`:

3a. Add `buildTwapCancel` to the import from `../lib/hyperliquid/cancel` (which already imports `buildCancel`, `buildCancelByCloid`):
```ts
  buildTwapCancel,
```

3b. Add `twapCancel` to the `ExchangeLike` interface (after `twapOrder`):
```ts
  twapCancel(params: { a: number; t: number }): Promise<unknown>;
```

3c. Add the method (place it next to `cancelOrder`):
```ts
  /** Cancel a running TWAP by its id. No cloid (TWAP carries none); an uncertain receipt is never
   * treated as a successful cancel. */
  async cancelTwap(coin: string, twapId: number): Promise<SubmitResult> {
    const built = buildTwapCancel(coin, twapId, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    try {
      const response = await this.client.twapCancel(built.params);
      const err = responseError(response);
      if (err) return { ok: false, error: rejectionMessage(err) };
      return { ok: true, cloid: NO_CLOID, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
    }
  }
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/services/exchange.test.ts`
Expected: PASS (existing + 3 new). Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/exchange.ts mobile/src/services/exchange.test.ts
git commit --no-verify -m "feat(mobile): ExchangeService.cancelTwap (honest receipt)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: i18n — TWAP tab strings (en + zh)

**Files:**
- Modify: `mobile/src/i18n/messages.ts`

- [ ] **Step 1: Confirm the parity guard is green**

Run: `cd mobile && npx jest messages` → PASS.

- [ ] **Step 2: Add the English keys** — in the **en** map, next to the other `positions.*` keys (e.g. after `"positions.tabOrders"`/`"positions.emptyOrders"`), add:

```ts
    "positions.tabTwap": "TWAP",
    "positions.emptyTwaps": "No active TWAP orders",
    "positions.twapProgress": "{done}/{total} · {pct}% · ${ntl} · {minutes}m",
    "positions.twapCancelTitle": "Cancel TWAP",
    "positions.twapCancelBody": "Cancel the {coin} {side} TWAP ({done}/{total} filled)?",
    "positions.twapCancelled": "TWAP cancel submitted",
    "positions.twapCancelFailed": "Couldn't cancel the TWAP",
```
Note: `positions.reduceOnly` and `positions.cancelOrder` already exist in both locales — do NOT re-add them; the TWAP row reuses them.

- [ ] **Step 3: Add the matching Chinese keys** — in the **zh** map, next to the zh `positions.*` keys, add:

```ts
    "positions.tabTwap": "TWAP",
    "positions.emptyTwaps": "没有进行中的 TWAP",
    "positions.twapProgress": "{done}/{total} · {pct}% · ${ntl} · {minutes}分钟",
    "positions.twapCancelTitle": "取消 TWAP",
    "positions.twapCancelBody": "取消 {coin} {side} TWAP（已成交 {done}/{total}）？",
    "positions.twapCancelled": "已提交 TWAP 取消",
    "positions.twapCancelFailed": "取消 TWAP 失败",
```

The en and zh key sets must be identical. No emoji.

- [ ] **Step 4: Run the parity guard, expect pass**

Run: `cd mobile && npx jest messages`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/i18n/messages.ts
git commit --no-verify -m "feat(i18n): TWAP monitoring + cancel strings (en + zh)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Positions screen — TWAP tab + `TwapRow` + cancel

**Files:**
- Modify: `mobile/src/screens/PositionsScreen.tsx`
- Test: `mobile/src/screens/PositionsScreen.test.tsx`

- [ ] **Step 1: Write the failing tests** — edit `mobile/src/screens/PositionsScreen.test.tsx`.

First extend the mocks at the top of the file:
- In `jest.mock("../services/exchange", …)` add `cancelTwap: mockCancelTwap` to the mocked `ExchangeService` instance, and declare `const mockCancelTwap = jest.fn();` next to `mockCancelOrder` (and `mockCancelTwap.mockReset()` in `beforeEach`). The mock factory becomes e.g.:
```ts
const mockCancelTwap = jest.fn();
jest.mock("../services/exchange", () => ({
  ExchangeService: jest.fn().mockImplementation(() => ({ placeOrder: mockPlaceOrder, cancelOrder: mockCancelOrder, cancelTwap: mockCancelTwap })),
}));
```
- In `jest.mock("../lib/hyperliquid/client", …)` add `createTwapInfoClient: jest.fn(() => ({}))`.
- Add a `twap` service to `fakeDeps` (next to `orders`):
```ts
  twap: { loadActive: jest.fn(async () => activeTwaps) } as unknown as TwapService,
```
with a module-level fixture and import:
```ts
import type { TwapService } from "../services/twapData";
import type { ActiveTwap } from "../lib/hyperliquid/twap";
const activeTwaps: ActiveTwap[] = [
  { twapId: 7, coin: "BTC", side: "buy", sz: 1, executedSz: 0.4, executedNtl: 24000, minutes: 30, reduceOnly: false, startedAt: 1000 },
];
```
and clear it in `beforeEach`: `(fakeDeps.twap.loadActive as jest.Mock).mockClear();`.

Then add the tests. Tabs are selected by their label **text** (the tab buttons have no testID; the existing orders/history tests use `getByText`), and confirmation reuses the file's existing `confirmAlert()` helper. The cancel test must set a local wallet (like the existing Close/Cancel tests: `useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR })`) so the on-demand `buildSvc()` can sign:
```ts
it("shows active TWAPs on the TWAP tab", async () => {
  render(<PositionsScreen deps={fakeDeps} />);
  await waitFor(() => expect(screen.getByText("TWAP")).toBeTruthy());
  fireEvent.press(screen.getByText("TWAP"));
  expect(await screen.findByTestId("twap-7")).toBeTruthy();
});

it("cancels a TWAP after confirmation", async () => {
  mockCancelTwap.mockResolvedValueOnce({ ok: true });
  useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
  render(<PositionsScreen deps={fakeDeps} />);
  await waitFor(() => expect(screen.getByText("TWAP")).toBeTruthy());
  fireEvent.press(screen.getByText("TWAP"));
  fireEvent.press(await screen.findByTestId("twap-cancel-7"));
  await confirmAlert();
  await waitFor(() => expect(mockCancelTwap).toHaveBeenCalledWith("BTC", 7));
});
```
(`localWallet`, `ADDR`, `confirmAlert`, `useWalletStore` are already defined/imported in this test file — reuse them.)

- [ ] **Step 2: Run them, expect fail**

Run: `cd mobile && npx jest src/screens/PositionsScreen.test.tsx -t "TWAP"`
Expected: FAIL (`tab-twap` / `twap-7` not found).

- [ ] **Step 3: Implement** — edit `mobile/src/screens/PositionsScreen.tsx`:

3a. Widen the `Tab` type:
```ts
type Tab = "positions" | "fills" | "orders" | "twap";
```

3b. Add imports:
```ts
import { TwapService } from "../services/twapData";
import { createTwapInfoClient } from "../lib/hyperliquid/client";
import { twapProgressPct, type ActiveTwap } from "../lib/hyperliquid/twap";
```

3c. Add `twap` to `PositionsScreenDeps` (next to `orders: OrdersService;`):
```ts
  twap: TwapService;
```
and to the `services` `useMemo` default (next to `orders: new OrdersService(...)`):
```ts
        twap: new TwapService(createTwapInfoClient(network)),
```

3d. Add state (next to `orders`/`ordersError`):
```ts
  const [activeTwaps, setActiveTwaps] = useState<ActiveTwap[]>([]);
  const [twapError, setTwapError] = useState<FetchErrorCode | null>(null);
```

3e. In `runQuery`, load twaps alongside fills/orders:
```ts
      setTwapError(null);
      void services.twap.loadActive(addr).then(setActiveTwaps).catch((e) => setTwapError(classifyFetchError(e)));
```

3f. Add the cancel handler (mirror `cancelOrder`, after it):
```ts
  const cancelTwap = useCallback(
    async (twp: ActiveTwap) => {
      const side = t(twp.side === "buy" ? "common.buy" : "common.sell");
      Alert.alert(
        t("positions.twapCancelTitle"),
        t("positions.twapCancelBody", { coin: twp.coin, side, done: twp.executedSz, total: twp.sz }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("common.confirm"),
            style: "destructive",
            onPress: async () => {
              try {
                const svc = buildSvc();
                if (!svc) {
                  Alert.alert(t("positions.twapCancelFailed"));
                  return;
                }
                const res = await svc.cancelTwap(twp.coin, twp.twapId);
                if (res.ok) {
                  useToastStore.getState().show(t("positions.twapCancelled"), "success");
                  runQuery(walletAddress ?? "");
                } else if (res.uncertain) {
                  Alert.alert(t("common.uncertainReceipt"), res.error);
                  runQuery(walletAddress ?? "");
                } else {
                  Alert.alert(t("positions.twapCancelFailed"), res.error);
                }
              } catch (e) {
                Alert.alert(t("positions.twapCancelFailed"), e instanceof Error ? e.message : String(e));
              }
            },
          },
        ],
      );
    },
    [buildSvc, runQuery, walletAddress, t],
  );
```

3g. Add the tab to the `tabs` badge array (after the `orders` entry):
```ts
    ["twap", "positions.tabTwap", activeTwaps.length],
```

3h. Add the TWAP list block after the `tab === "orders"` block (before the closing `</>`):
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

3i. Add the `TwapRow` component (mirror `OrderRow` exactly — reuse its existing style keys and i18n keys; do NOT invent new styles). Place it next to `OrderRow`:
```tsx
function TwapRow({ twap, theme, onCancel }: { twap: ActiveTwap; theme: ThemeTokens; onCancel?: (t: ActiveTwap) => void }) {
  const t = useT();
  const sideColor = twap.side === "buy" ? theme.up : theme.down;
  const pct = Math.round(twapProgressPct(twap));
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]} testID={`twap-${twap.twapId}`}>
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
    </View>
  );
}
```
This reuses the EXACT `OrderRow` style keys (`styles.row`, `styles.rowCoin`, `styles.rowSub`, `styles.rowRight`, `styles.cancelBtn`, `styles.cancelText`) and existing i18n keys (`common.buy`/`common.sell`, `positions.reduceOnly`, `positions.cancelOrder`) — no new styles, no hardcoded hex. Verify these style keys exist on `OrderRow` before writing; if any differ, match `OrderRow`'s actual keys.

- [ ] **Step 4: Run the Positions suite, expect pass**

Run: `cd mobile && npx jest src/screens/PositionsScreen.test.tsx`
Expected: PASS (existing + 2 new TWAP tests).

- [ ] **Step 5: Full mobile gate + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors && npx jest messages`
Expected: tsc 0; all suites green (≥ 756 + new); noHardcodedColors PASS; messages PASS.
Emoji scan: `rg -n "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src/screens/PositionsScreen.tsx src/lib/hyperliquid/twap.ts src/services/twapData.ts src/i18n/messages.ts || echo "no emoji"` → "no emoji".

```bash
git add mobile/src/screens/PositionsScreen.tsx mobile/src/screens/PositionsScreen.test.tsx
git commit --no-verify -m "feat(mobile): active TWAP tab on Positions with cancel

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final verification

- [ ] **Mobile:** `cd mobile && npx tsc --noEmit && npx jest` (≥ 756 + new) `&& npx jest noHardcodedColors && npx jest messages`; emoji scan on the new/changed files → "no emoji".
- [ ] Report final mobile pass count vs baseline (756). Await the user's explicit "push".

## Self-review notes (spec coverage)

- Poll `twapHistory` → filter `activated` → normalize → Tasks 1–2. ✓
- Drop entries without a `twapId` (uncancellable) → Task 1 normalizer. ✓
- Cancel via signed `twapCancel` with honest receipt → Tasks 3–4. ✓
- 4th Positions tab, reuse on-demand `buildSvc`, confirm-then-cancel; view-only handled inside `cancelTwap` (buildSvc null → failure alert), mirroring the orders tab → Task 6. ✓
- Per-row progress (executed/total, %, notional, minutes, reduce-only) → Task 6 `TwapRow` + `twapProgressPct`. ✓
- i18n en+zh parity, theme tokens only, no emoji → Task 5 + Task 6. ✓
- Empty + error states mirror the orders tab → Task 6. ✓
- Non-goals (history/slice fills/WS/edit) → not implemented. ✓
