# gridLimit Monitoring Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen gridLimit monitoring: a per-rung ladder detail (server endpoint + mobile inline expand) and precise realized P&L from HL `userFills.closedPnl` (with graceful fallback to the limit-price approximation).

**Architecture:** A new `UserFillsReader` (Info, cloid-indexed fills) that the scheduler consults lazily on fill detection to record the actual fill sz/px and use `closedPnl` for realized P&L. A new `GET /strategies/:id/rungs` endpoint returns the rung ladder (state + buy/sell prices). Mobile adds `getRungs` and an inline-expandable rung ladder on the gridLimit strategy row.

**Tech Stack:** TypeScript, Fastify strategy engine (`server/`), `@nktkas/hyperliquid` (InfoClient.userFills), Jest; Expo React Native (`mobile/`), Jest.

**Key facts:** HL `userFills({ user })` → array of fills, each with optional `cloid`, plus `px`, `sz`, `closedPnl`, `side`. A resting maker limit fills AT its limit price, so px is already exact; `closedPnl` (fee-inclusive realized P&L on a reduce-only close) is the real value-add. The gridLimit reconcile fill-detection lives in `server/src/engine/scheduler.ts` (inside `if (restingExec && ordersReader && marks)`), where an armed buy filling records a `"buy"` activity + `placeSell`, and a holding sell filling records a `"sell"` activity + `addFilledUsdc((sellPx-buyPx)*size)`.

---

### Task 1: `UserFillsReader` (cloid-indexed fills)

**Files:**
- Create: `server/src/agent/userFillsReader.ts`
- Test: `server/src/agent/userFillsReader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/userFillsReader.test.ts`:

```ts
import { makeUserFillsReader } from "./userFillsReader";

describe("makeUserFillsReader.fillsByCloid", () => {
  it("indexes fills by cloid, aggregating partials (sum sz/closedPnl, sz-weighted avg px)", async () => {
    const info = {
      userFills: async ({ user }: { user: string }) => {
        expect(user).toBe("0xo");
        return [
          { cloid: "0xaa", px: "100", sz: "0.4", closedPnl: "2" },
          { cloid: "0xaa", px: "110", sz: "0.6", closedPnl: "3" }, // partial fill of same order
          { cloid: null, px: "200", sz: "1", closedPnl: "9" }, // no cloid -> dropped
        ];
      },
    };
    const reader = makeUserFillsReader(info as never);
    const map = await reader.fillsByCloid("0xo");
    expect([...map.keys()]).toEqual(["0xaa"]);
    expect(map.get("0xaa")).toEqual({ sz: 1, closedPnl: 5, px: (100 * 0.4 + 110 * 0.6) / 1 });
  });
  it("returns an empty map for a non-array response", async () => {
    const reader = makeUserFillsReader({ userFills: async () => null } as never);
    expect((await reader.fillsByCloid("0xo")).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest userFillsReader.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reader**

Create `server/src/agent/userFillsReader.ts`:

```ts
export interface CloidFill {
  sz: number;
  px: number;
  closedPnl: number;
}

/** Minimal injectable Info surface for user fills. */
export interface UserFillsInfoLike {
  userFills(args: { user: string }): Promise<unknown>;
}

export interface UserFillsReader {
  fillsByCloid(owner: string): Promise<Map<string, CloidFill>>;
}

interface RawFill {
  cloid?: string | null;
  px?: string;
  sz?: string;
  closedPnl?: string;
}

/**
 * Poll a user's fills and index them by client order id (cloid), aggregating partial fills of the
 * same order: total size, total closedPnl, and size-weighted average price. Fills with no cloid
 * (not from our resting orders) are dropped.
 */
export function makeUserFillsReader(info: UserFillsInfoLike): UserFillsReader {
  return {
    async fillsByCloid(owner: string): Promise<Map<string, CloidFill>> {
      const raw = await info.userFills({ user: owner });
      const acc = new Map<string, { sz: number; closedPnl: number; pxSz: number }>();
      if (!Array.isArray(raw)) return new Map();
      for (const f of raw as RawFill[]) {
        if (typeof f?.cloid !== "string") continue;
        const sz = Number(f.sz ?? 0);
        const px = Number(f.px ?? 0);
        const closedPnl = Number(f.closedPnl ?? 0);
        const cur = acc.get(f.cloid) ?? { sz: 0, closedPnl: 0, pxSz: 0 };
        cur.sz += sz;
        cur.closedPnl += closedPnl;
        cur.pxSz += px * sz;
        acc.set(f.cloid, cur);
      }
      const out = new Map<string, CloidFill>();
      for (const [cloid, v] of acc) out.set(cloid, { sz: v.sz, closedPnl: v.closedPnl, px: v.sz > 0 ? v.pxSz / v.sz : 0 });
      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest userFillsReader.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/userFillsReader.ts server/src/agent/userFillsReader.test.ts
git commit --no-verify -m "feat(gridLimit): UserFillsReader (userFills indexed by cloid)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Scheduler — precise fill sz/px + closedPnl P&L

**Files:**
- Modify: `server/src/engine/scheduler.ts`
- Test: `server/src/engine/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/engine/scheduler.test.ts` inside the `describe("gridLimit tick (running)", ...)` block (before its closing `});`). It uses the existing `fakeExec`/`fakeReader`/`glParams` helpers:

```ts
  function fakeFills(map: Record<string, { sz: number; px: number; closedPnl: number }>) {
    return { fillsByCloid: jest.fn(async () => new Map(Object.entries(map))) };
  }

  it("records precise sz/px from userFills on a buy fill", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "armed", side: "buy", cloid: "0xBUY", px: 140, seq: 1 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({ "0xBUY": { sz: 0.36, px: 139.9, closedPnl: 0 } });
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, marks, exec as any, fakeReader([]) as any, fills as any);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", sz: 0.36, px: 139.9 }));
  });

  it("uses userFills closedPnl for realized pnl on a sell fill", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xSELL", px: 160, seq: 2 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({ "0xSELL": { sz: 0.36, px: 160.1, closedPnl: 7.25 } });
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, marks, exec as any, fakeReader([]) as any, fills as any);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", sz: 0.36, px: 160.1 }));
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo(7.25, 6);
  });

  it("falls back to the limit-price approximation when userFills lacks the cloid", async () => {
    const store = new MemoryStrategyStore(() => 0);
    const s = store.create("0xo", "gridLimit", glParams);
    store.setGridLimitRung(s.id, { rung: 2, state: "holding", side: "sell", cloid: "0xSELL", px: 160, seq: 2 });
    const activity = { record: jest.fn(), notionalSince: () => 0 };
    const exec = fakeExec();
    const fills = fakeFills({}); // cloid absent -> fallback
    const marks = { resolveMark: async () => 150, resolvePosition: async () => undefined };
    await tick(store, {} as any, { maxNotionalUsdc: 1e9 }, false, 0, activity as any, marks, exec as any, fakeReader([]) as any, fills as any);
    expect(store.get(s.id)!.filledTotalUsdc).toBeCloseTo((160 - 140) * (50 / 140), 6);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", px: 160 }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest scheduler -t "gridLimit tick (running)"`
Expected: FAIL — `tick` does not accept a 10th arg and does not consult userFills.

- [ ] **Step 3: Add the `userFillsReader` param + lazy `getFills` + enrich fill detection**

In `server/src/engine/scheduler.ts`:

3a. Add the import:

```ts
import type { UserFillsReader, CloidFill } from "../agent/userFillsReader";
```

3b. Add a 10th optional param to `tick`:

```ts
  ordersReader?: OpenOrdersReader,
  userFillsReader?: UserFillsReader,
): Promise<void> {
```

3c. Inside the `if (restingExec && ordersReader && marks) {` block, next to the existing `getOpen` helper, add a lazy per-owner fills cache:

```ts
    const fillsByOwner = new Map<string, Map<string, CloidFill>>();
    const getFills = async (owner: string) => {
      let m = fillsByOwner.get(owner);
      if (!m) { m = userFillsReader ? await userFillsReader.fillsByCloid(owner) : new Map(); fillsByOwner.set(owner, m); }
      return m;
    };
```

3d. Replace the fill-detection block. Find:

```ts
        // fill detection: a tracked resting order that vanished from open orders filled
        if ((r.state === "armed" || r.state === "holding") && r.cloid && !open.has(r.cloid)) {
          if (r.state === "armed") {
            if (activity && r.px) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: "buy", sz: rungSizeCoin(p, i), px: r.px });
            await placeSell(i, r);
            continue;
          }
          if (activity && r.px) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: "sell", sz: rungSizeCoin(p, i), px: r.px });
          store.addFilledUsdc(s.id, Math.max(0, (rungSellPrice(p, i) - rungBuyPrice(p, i)) * rungSizeCoin(p, i)));
          store.setGridLimitRung(s.id, { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq });
          r = { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq };
        }
```

with:

```ts
        // fill detection: a tracked resting order that vanished from open orders filled.
        // Enrich with the actual fill (userFills, indexed by cloid) for precise sz/px + closedPnl;
        // fall back to the limit-price approximation when userFills hasn't propagated the fill yet.
        if ((r.state === "armed" || r.state === "holding") && r.cloid && !open.has(r.cloid)) {
          const fill = userFillsReader ? (await getFills(s.owner)).get(r.cloid) : undefined;
          const sz = fill?.sz ?? rungSizeCoin(p, i);
          const px = fill?.px ?? r.px ?? rungBuyPrice(p, i);
          if (r.state === "armed") {
            if (activity) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: "buy", sz, px });
            await placeSell(i, r);
            continue;
          }
          if (activity) activity.record({ strategyId: s.id, owner: s.owner, time: now, coin: p.coin, side: "sell", sz, px });
          store.addFilledUsdc(s.id, fill ? fill.closedPnl : Math.max(0, (rungSellPrice(p, i) - rungBuyPrice(p, i)) * rungSizeCoin(p, i)));
          store.setGridLimitRung(s.id, { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq });
          r = { rung: i, state: "idle", side: null, cloid: null, px: null, seq: r.seq };
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest scheduler`
Expected: PASS — new userFills tests + all existing scheduler tests (existing gridLimit tests pass no `userFillsReader`, so they exercise the fallback which equals the prior behavior).

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/scheduler.ts server/src/engine/scheduler.test.ts
git commit --no-verify -m "feat(gridLimit): precise fill sz/px + closedPnl realized pnl via userFills

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wire `UserFillsReader` into `index.ts`

**Files:**
- Modify: `server/src/index.ts`

Process wiring; verified by `npx tsc --noEmit`.

- [ ] **Step 1: Build + pass the reader**

In `server/src/index.ts`:
- Add the import next to `makeOpenOrdersReader`:
```ts
import { makeUserFillsReader } from "./agent/userFillsReader";
```
- After the existing `const ordersReader = makeOpenOrdersReader(...)`, add:
```ts
  const userFillsReader = makeUserFillsReader(info as unknown as { userFills(a: { user: string }): Promise<unknown> });
```
- In the `tick(...)` call, append `userFillsReader` after `ordersReader`:
```ts
      restingExec,
      ordersReader,
      userFillsReader,
```

- [ ] **Step 2: Verify types compile + full server suite**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: exit 0; all pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit --no-verify -m "feat(gridLimit): wire UserFillsReader into the scheduler

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: `GET /strategies/:id/rungs` endpoint

**Files:**
- Modify: `server/src/http/app.ts`
- Test: `server/src/http/app.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("gridLimit HTTP", ...)` block in `server/src/http/app.test.ts` (it already has `buildWithStore()`, `glParams`, and `tokenFor`):

```ts
  it("GET /strategies/:id/rungs returns the gridLimit rung ladder", async () => {
    const { app, store } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "gridLimit", params: glParams } });
    const id = created.json().id as string;
    store.setGridLimitRung(id, { rung: 0, state: "armed", side: "buy", cloid: "0xa", px: 100, seq: 1 });
    const rungs = (await app.inject({ method: "GET", url: `/strategies/${id}/rungs`, headers: auth })).json();
    expect(rungs).toHaveLength(5); // levels 6 -> 5 rungs
    expect(rungs[0]).toEqual({ rung: 0, state: "armed", buyPrice: 100, sellPrice: 120 });
    expect(rungs[1]).toEqual({ rung: 1, state: "idle", buyPrice: 120, sellPrice: 140 });
  });

  it("returns [] rungs for a non-gridLimit strategy", async () => {
    const { app } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "dca", params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } } });
    const id = created.json().id as string;
    const rungs = (await app.inject({ method: "GET", url: `/strategies/${id}/rungs`, headers: auth })).json();
    expect(rungs).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest app.test`
Expected: FAIL — the route does not exist (404).

- [ ] **Step 3: Add the endpoint**

In `server/src/http/app.ts`:
- Add imports: `GridLimitParams` from the types import (extend the existing `../strategies/types` import to add it), and the gridLimit geometry helpers:
```ts
import { rungCount, rungBuyPrice, rungSellPrice } from "../strategies/gridLimit";
```
- Add the route immediately after the existing `GET /strategies/:id/activity` handler:
```ts
  app.get("/strategies/:id/rungs", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const s = ownedStrategy(owner, id, reply);
    if (!s) return;
    if (s.kind !== "gridLimit") return [];
    const p = s.params as GridLimitParams;
    const state = new Map(deps.store.gridLimitRungs(id).map((r) => [r.rung, r.state]));
    const out: Array<{ rung: number; state: string; buyPrice: number; sellPrice: number }> = [];
    for (let i = 0; i < rungCount(p); i++) {
      out.push({ rung: i, state: state.get(i) ?? "idle", buyPrice: rungBuyPrice(p, i), sellPrice: rungSellPrice(p, i) });
    }
    return out;
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest app.test && npx tsc --noEmit`
Expected: PASS + exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/app.ts server/src/http/app.test.ts
git commit --no-verify -m "feat(gridLimit): GET /strategies/:id/rungs ladder endpoint

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Mobile — `Rung` type + `getRungs` API

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Test: `mobile/src/services/strategyApi.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `mobile/src/services/strategyApi.test.ts` (the file uses `new StrategyApi(baseUrl, token, fetchImpl)` with a `res(...)` helper):

```ts
  it("getRungs GETs the strategy rung ladder", async () => {
    const fetchMock = jest.fn(async () => res([{ rung: 0, state: "armed", buyPrice: 100, sellPrice: 120 }]));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const rungs = await api.getRungs("s1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api/strategies/s1/rungs");
    expect(rungs).toEqual([{ rung: 0, state: "armed", buyPrice: 100, sellPrice: 120 }]);
  });
```

(If the existing tests assert the request URL differently — e.g. via `expect(fetchMock).toHaveBeenCalledWith(...)` — mirror that exact assertion style; the point is that `getRungs("s1")` requests `GET {base}/strategies/s1/rungs` and returns the parsed array.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest strategyApi`
Expected: FAIL — `getRungs` does not exist.

- [ ] **Step 3: Add the type + method**

In `mobile/src/services/strategyApi.ts`:
- Add the `Rung` type (near the other exported interfaces):
```ts
export interface Rung {
  rung: number;
  state: "idle" | "armed" | "holding";
  buyPrice: number;
  sellPrice: number;
}
```
- Add the method to the `StrategyApi` class (next to `getActivity`):
```ts
  getRungs(id: string) {
    return this.request<Rung[]>(`/strategies/${id}/rungs`, "GET");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest strategyApi && npx tsc --noEmit`
Expected: PASS + exit 0.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts
git commit --no-verify -m "feat(gridLimit): mobile Rung type + getRungs API

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Mobile — inline rung ladder on the gridLimit row

**Files:**
- Modify: `mobile/src/screens/AgentScreen.tsx`
- Modify: `mobile/src/i18n/messages.ts`
- Test: `mobile/src/screens/AgentScreen.test.tsx`

- [ ] **Step 1: Add i18n keys (en + zh)**

In `mobile/src/i18n/messages.ts`, in the ENGLISH block near the other `agent.*` keys, add:

```ts
    "agent.rungStateIdle": "Idle",
    "agent.rungStateArmed": "Resting",
    "agent.rungStateHolding": "Holding",
    "agent.rungsEmpty": "No rungs",
```

In the CHINESE block, add:

```ts
    "agent.rungStateIdle": "空闲",
    "agent.rungStateArmed": "挂单",
    "agent.rungStateHolding": "持仓",
    "agent.rungsEmpty": "暂无档梯",
```

- [ ] **Step 2: Write the failing test**

In `mobile/src/screens/AgentScreen.test.tsx`, add `getRungs` to `mockApiFake` (in the object literal near the other jest.fn methods):

```ts
  getRungs: jest.fn(async () => [
    { rung: 0, state: "armed", buyPrice: 100, sellPrice: 120 },
    { rung: 1, state: "idle", buyPrice: 120, sellPrice: 140 },
  ]),
```

Then append this test (inside the top-level `describe`):

```ts
  it("expands a gridLimit row to show the rung ladder", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "gl1", type: "gridLimit", status: "running", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }, filledTotalUsdc: 12, armedCount: 1, holdingCount: 0 },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-gl1")).toBeTruthy());
    fireEvent.press(screen.getByTestId("gl-row-gl1"));
    expect(await screen.findByTestId("gl-rungs-gl1")).toBeTruthy();
    expect(await screen.findByTestId("gl-rung-gl1-0")).toBeTruthy();
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd mobile && npx jest AgentScreen`
Expected: FAIL — `gl-row-gl1` / `gl-rungs-gl1` not found.

- [ ] **Step 4: Pass `getRungs` to StrategyRow + rebuild the row with an expandable ladder**

4a. In `mobile/src/screens/AgentScreen.tsx`, find where strategies are rendered:

```tsx
        ctrl.strategies.map((s) => <StrategyRow key={s.id} theme={theme} strategy={s} onToggle={() => void ctrl.toggle(s)} />)
```

and add the `getRungs` prop:

```tsx
        ctrl.strategies.map((s) => <StrategyRow key={s.id} theme={theme} strategy={s} onToggle={() => void ctrl.toggle(s)} getRungs={(id) => api.getRungs(id)} />)
```

4b. Import the `Rung` type — extend the existing `../services/strategyApi` import (which already imports `StrategyApi`, `Strategy`, params types, `Activity`) to add `type Rung`.

4c. Replace the entire `StrategyRow` function with this expandable version:

```tsx
function RungLine({ theme, id, r }: { theme: ThemeTokens; id: string; r: Rung }) {
  const t = useT();
  const stateColor = r.state === "armed" ? theme.brand : r.state === "holding" ? theme.up : theme.muted;
  const stateLabel = r.state === "armed" ? t("agent.rungStateArmed") : r.state === "holding" ? t("agent.rungStateHolding") : t("agent.rungStateIdle");
  return (
    <View style={styles.rungLine} testID={`gl-rung-${id}-${r.rung}`}>
      <Text style={[styles.hint, { color: theme.muted }]}>{`#${r.rung} · ${r.buyPrice} → ${r.sellPrice}`}</Text>
      <Text style={[styles.hint, { color: stateColor }]}>{stateLabel}</Text>
    </View>
  );
}

function StrategyRow({
  theme, strategy, onToggle, getRungs,
}: {
  theme: ThemeTokens; strategy: Strategy; onToggle: () => void; getRungs?: (id: string) => Promise<Rung[]>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [rungs, setRungs] = useState<Rung[]>([]);
  const isGl = strategy.type === "gridLimit";
  const onExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && getRungs) {
      try { setRungs(await getRungs(strategy.id)); } catch { /* leave rungs as-is */ }
    }
  };
  const title =
    strategy.type === "twap" ? t("agent.strategyTwap", { coin: strategy.params.coin })
    : strategy.type === "tpsl" ? t("agent.strategyTpsl", { coin: strategy.params.coin })
    : strategy.type === "grid" ? t("agent.strategyGrid", { coin: (strategy.params as GridParams).coin })
    : strategy.type === "gridLimit" ? t("agent.strategyGridLimit", { coin: (strategy.params as GridLimitParams).coin })
    : t("agent.strategyDca", { coin: (strategy.params as DcaParams).coin });
  const sub =
    strategy.type === "twap"
      ? t("agent.twapProgress", { done: String(strategy.slicesDone ?? 0), total: String((strategy.params as TwapParams).slices), filled: String(Math.round(strategy.filledTotalUsdc ?? 0)) })
      : strategy.type === "tpsl"
      ? [
          (strategy.params as TpslParams).takeProfitPrice ? `${t("agent.takeProfit")} ${(strategy.params as TpslParams).takeProfitPrice}` : "",
          (strategy.params as TpslParams).stopLossPrice ? `${t("agent.stopLoss")} ${(strategy.params as TpslParams).stopLossPrice}` : "",
        ].filter(Boolean).join(" · ")
      : strategy.type === "grid"
      ? t("agent.gridProgress", {
          level: String((strategy.lastLevel ?? 0) + 1),
          levels: String((strategy.params as GridParams).levels),
          filled: String(Math.round(strategy.filledTotalUsdc ?? 0)),
        })
      : strategy.type === "gridLimit"
      ? t("agent.gridLimitProgress", { armed: String(strategy.armedCount ?? 0), holding: String(strategy.holdingCount ?? 0), filled: String(Math.round(strategy.filledTotalUsdc ?? 0)) })
      : `$${(strategy.params as DcaParams).quoteAmountUsdc} / ${(strategy.params as DcaParams).intervalHours}h`;
  const completed = strategy.status === "completed";
  const canceling = strategy.status === "canceling";
  const info = (
    <>
      <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.hint, { color: theme.muted }]}>{sub}</Text>
    </>
  );
  return (
    <SurfaceCard theme={theme} rule={false} testID={`strategy-${strategy.id}`} style={styles.rowCard}>
      <View style={styles.rowTop}>
        {isGl ? (
          <Pressable onPress={onExpand} accessibilityRole="button" testID={`gl-row-${strategy.id}`} style={styles.rowMain}>
            {info}
          </Pressable>
        ) : (
          <View style={styles.rowMain}>{info}</View>
        )}
        {completed || canceling ? (
          <Text style={[styles.hint, { color: theme.faint }]}>{t(canceling ? "agent.statusCanceling" : "agent.statusCompleted")}</Text>
        ) : (
          <Toggle
            theme={theme}
            value={strategy.status === "running"}
            onValueChange={onToggle}
            accessibilityLabel={`toggle-${strategy.id}`}
          />
        )}
      </View>
      {isGl && expanded ? (
        <View style={styles.rungBox} testID={`gl-rungs-${strategy.id}`}>
          {rungs.length === 0 ? (
            <Text style={[styles.hint, { color: theme.muted }]}>{t("agent.rungsEmpty")}</Text>
          ) : (
            rungs.map((r) => <RungLine key={r.rung} theme={theme} id={strategy.id} r={r} />)
          )}
        </View>
      ) : null}
    </SurfaceCard>
  );
}
```

The `info` fragment (Title + Sub) is wrapped once in `styles.rowMain` (flex:1) — via a `Pressable` for gridLimit rows (tap to expand) or a plain `View` for other kinds. This keeps the top row layout identical to before for non-gridLimit rows.

4d. Add the three new styles to the `StyleSheet.create({...})` (near `row`/`rowMain`):

```ts
  rowCard: { padding: 14, marginBottom: 8 },
  rowTop: { flexDirection: "row", alignItems: "center" },
  rungBox: { marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "transparent", paddingTop: 8 },
  rungLine: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
```

(The `borderTopColor: "transparent"` keeps the guard happy without a hardcoded hex; if a visible divider is wanted, use a theme color at the call site instead. Keep it transparent here.)

Ensure `useState` is imported from `react` (the file already imports React hooks; add `useState` if not already present).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mobile && npx jest AgentScreen`
Expected: PASS (new expand test + all existing AgentScreen tests, including the non-gridLimit rows which use the plain `<View>` info path and are unaffected).

- [ ] **Step 6: Guards + emoji scan**

Run: `cd mobile && npx tsc --noEmit && npx jest noHardcodedColors messages`
Expected: PASS — tsc clean; `noHardcodedColors` green (colors only from theme / "transparent"); `messages` en/zh parity green.

Run: `cd mobile && grep -rnP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]" src/screens/AgentScreen.tsx src/i18n/messages.ts || echo "no emoji"`
Expected: `no emoji`.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/screens/AgentScreen.tsx mobile/src/i18n/messages.ts mobile/src/screens/AgentScreen.test.tsx
git commit --no-verify -m "feat(gridLimit): mobile inline rung ladder on the strategy row

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification

- [ ] Server: `cd server && npx tsc --noEmit && npx jest` — all pass, ≥ 207 + new tests.
- [ ] Mobile: `cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors messages` — all pass, ≥ 789 + new tests.
- [ ] Backend (Go): untouched — no run.
- [ ] Open PR `feat/grid-limit-monitoring` → `main`; wait for CI green; code-review; merge.

## Notes / Out of Scope

- `userFills` px is already exact for maker fills; the real gain is `closedPnl` (fee-inclusive realized P&L) and precise partial-fill sizes. Fallback to the limit-price approximation covers the userFills propagation lag.
- Per-fill fee/closedPnl in the activity feed (activity-table migration) is deferred.
- Rung ladder is read-only; no per-rung actions in this phase.
