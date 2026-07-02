# Strategy Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Commit convention:** `git commit --no-verify` + trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Do NOT push (the user pushes explicitly).

**Goal:** Surface an aggregated, owner-wide "Recent activity" list of strategy fills/triggers on the Agent tab.

**Architecture:** Add `ActivityStore.listRecent(owner, limit)` and a new authed `GET /activity?limit=N` endpoint (reusing the existing activity DTO), then consume it in the mobile app: a new `StrategyApi.getRecentActivity`, a controller that loads activity in its `refresh()`, and a "Recent activity" section in `AgentScreen`.

**Tech Stack:** Server: TypeScript, Fastify, better-sqlite3, jest/ts-jest. Mobile: Expo RN, TypeScript, Zustand, @testing-library/react-native, jest-expo.

**Spec:** `docs/superpowers/specs/2026-07-02-strategy-activity-feed-design.md`

**Baselines (must stay ≥):** server `cd server && npx jest` = 116 tests / 20 suites; mobile `cd mobile && npx jest` = 728 tests / 126 suites (record actual before starting; final ≥ these).

---

## Phase A — Server

### Task A1: `ActivityStore.listRecent(owner, limit)`

**Files:**
- Modify: `server/src/strategies/activityStore.ts`
- Modify: `server/src/strategies/activityStore.test.ts`

- [ ] **Step 1: Write the failing test** (add to activityStore.test.ts; mirror for both stores if the file parameterizes — otherwise add against `MemoryActivityStore` and `SqliteActivityStore.open(":memory:")`)

```ts
import { MemoryActivityStore, SqliteActivityStore } from "./activityStore";

describe("listRecent", () => {
  function seed(store: MemoryActivityStore | SqliteActivityStore) {
    store.record({ strategyId: "s1", owner: "0xOwner", time: 100, coin: "BTC", side: "buy", sz: 0.1, px: 50000 });
    store.record({ strategyId: "s2", owner: "0xOwner", time: 300, coin: "ETH", side: "sell", sz: 1, px: 1600 });
    store.record({ strategyId: "s1", owner: "0xOwner", time: 200, coin: "BTC", side: "buy", sz: 0.2, px: 51000 });
    store.record({ strategyId: "s9", owner: "0xOther", time: 400, coin: "SOL", side: "buy", sz: 5, px: 100 });
  }

  it.each([
    ["memory", () => new MemoryActivityStore()],
    ["sqlite", () => SqliteActivityStore.open(":memory:")],
  ])("%s: newest-first across strategies, owner-scoped, capped by limit", (_n, make) => {
    const store = make();
    seed(store);
    const recent = store.listRecent("0xOwner", 2);
    expect(recent.map((r) => r.time)).toEqual([300, 200]); // newest first, other owner excluded, capped at 2
    expect(recent.every((r) => r.owner === "0xowner")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/strategies/activityStore.test.ts`
Expected: FAIL — `listRecent` not a function.

- [ ] **Step 3: Implement**

Add to the `ActivityStore` interface (after `list`):

```ts
  /** Newest-first activity across all of the owner's strategies, capped at `limit`. */
  listRecent(owner: string, limit: number): Activity[];
```

Add to `MemoryActivityStore`:

```ts
  listRecent(owner: string, limit: number): Activity[] {
    return this.rows
      .filter((r) => r.owner === owner.toLowerCase())
      .sort((x, y) => y.time - x.time)
      .slice(0, limit);
  }
```

Add to `SqliteActivityStore`:

```ts
  listRecent(owner: string, limit: number): Activity[] {
    const rows = this.db
      .prepare("SELECT * FROM activity WHERE owner = ? ORDER BY time DESC LIMIT ?")
      .all(owner.toLowerCase(), limit) as Row[];
    return rows.map((r) => ({
      id: r.id, strategyId: r.strategy_id, owner: r.owner, time: r.time,
      coin: r.coin, side: r.side, sz: r.sz, px: r.px,
    }));
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx jest src/strategies/activityStore.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/strategies/activityStore.ts server/src/strategies/activityStore.test.ts
git commit --no-verify -m "feat(activity): ActivityStore.listRecent (owner-wide, newest-first)"
```

---

### Task A2: `GET /activity` endpoint

**Files:**
- Modify: `server/src/http/app.ts`
- Modify: `server/src/http/app.test.ts`

- [ ] **Step 1: Write the failing test** (add to app.test.ts; uses the file's existing `build`/`tokenFor`/`account` and `MemoryActivityStore`)

```ts
it("GET /activity requires auth", async () => {
  const app = build();
  const res = await app.inject({ method: "GET", url: "/activity" });
  expect(res.statusCode).toBe(401);
});

it("GET /activity returns owner-wide newest-first DTOs honoring limit", async () => {
  const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
  const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
  const store = new MemoryStrategyStore(() => 1000);
  const activity = new MemoryActivityStore();
  const app = buildApp({ auth: auth0, agents, store, activity, now: () => 1000 });
  const token = await tokenFor(app);
  const headers = { authorization: `Bearer ${token}` };

  activity.record({ strategyId: "s1", owner: account.address, time: 100, coin: "BTC", side: "buy", sz: 0.1, px: 50000 });
  activity.record({ strategyId: "s2", owner: account.address, time: 300, coin: "ETH", side: "sell", sz: 1, px: 1600 });
  activity.record({ strategyId: "s1", owner: account.address, time: 200, coin: "BTC", side: "buy", sz: 0.2, px: 51000 });

  const all = (await app.inject({ method: "GET", url: "/activity", headers })).json();
  expect(all.map((a: { time: number }) => a.time)).toEqual([300, 200, 100]);
  expect(all[0]).toEqual({ id: expect.any(String), time: 300, coin: "ETH", side: "sell", sz: 1, px: 1600 });

  const limited = (await app.inject({ method: "GET", url: "/activity?limit=1", headers })).json();
  expect(limited).toHaveLength(1);
  expect(limited[0].time).toBe(300);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/http/app.test.ts`
Expected: FAIL — `/activity` 404 / not found.

- [ ] **Step 3: Add the route** in `buildApp`, immediately after the `GET /strategies/:id/activity` handler:

```ts
  // --- owner-wide recent activity feed ---
  app.get("/activity", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const raw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 50;
    return (deps.activity?.listRecent(owner, limit) ?? []).map((a) => ({
      id: a.id, time: a.time, coin: a.coin, side: a.side, sz: a.sz, px: a.px,
    }));
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx tsc --noEmit && npx jest src/http/app.test.ts`
Expected: tsc clean; PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/app.ts server/src/http/app.test.ts
git commit --no-verify -m "feat(activity): GET /activity owner-wide feed endpoint"
```

---

## Phase B — Mobile

### Task B1: `StrategyApi.getRecentActivity`

**Files:**
- Modify: `mobile/src/services/strategyApi.ts`
- Modify: `mobile/src/services/strategyApi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("fetches recent activity with a limit", async () => {
  const fetchMock = jest.fn(async (_u: string, _i?: RequestInit) => res([{ id: "a1", time: 1, coin: "BTC", side: "buy", sz: 0.1, px: 50000 }]));
  const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
  const list = await api.getRecentActivity(25);
  expect(list).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith("https://api/activity?limit=25", expect.objectContaining({ method: "GET" }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts`
Expected: FAIL — `getRecentActivity` not a function.

- [ ] **Step 3: Implement** — add to the `StrategyApi` class (after `getActivity`):

```ts
  getRecentActivity(limit?: number) {
    const q = limit ? `?limit=${limit}` : "";
    return this.request<Activity[]>(`/activity${q}`, "GET");
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/services/strategyApi.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts
git commit --no-verify -m "feat(mobile): StrategyApi.getRecentActivity"
```

---

### Task B2: Controller loads activity in `refresh()`

**Files:**
- Modify: `mobile/src/hooks/useStrategyController.ts`
- Modify: `mobile/src/hooks/useStrategyController.test.ts`

Note: `refresh()` will now call `api.getRecentActivity()`. The controller test's `makeApi()` helper and the AgentScreen test's `mockApiFake` must both gain a `getRecentActivity` mock or their `Promise.all` refresh throws. This task updates `makeApi`; the AgentScreen `mockApiFake` is updated in Task B3. Run only the controller test here; the mobile full-suite gate is at the end of B3.

- [ ] **Step 1: Update `makeApi()` + write the failing test** in useStrategyController.test.ts.

Add `getRecentActivity` to the `makeApi()` returned object:

```ts
    getRecentActivity: jest.fn(async () => [] as unknown[]),
```

Add the test:

```ts
it("refresh loads recent activity into the hook", async () => {
  const api = makeApi();
  api.getRecentActivity = jest.fn(async () => [{ id: "a1", time: 1, coin: "BTC", side: "buy", sz: 0.1, px: 50000 }]);
  const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "n"));
  await waitFor(() => expect(result.current.activity.length).toBe(1));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/hooks/useStrategyController.test.ts`
Expected: FAIL — `result.current.activity` is undefined.

- [ ] **Step 3: Implement** — in `useStrategyController.ts`:

Add the import of `Activity`:

```ts
import type { StrategyApi, Strategy, DcaParams, TwapParams, TpslParams, AgentStatus, Activity } from "../services/strategyApi";
```

Add state (next to the other `useState`s):

```ts
  const [activity, setActivity] = useState<Activity[]>([]);
```

Replace `refresh`:

```ts
  const refresh = useCallback(async () => {
    const [s, list, acts] = await Promise.all([api.agentStatus(), api.listStrategies(), api.getRecentActivity()]);
    setStatus(s);
    setStrategies(list);
    setActivity(acts);
  }, [api]);
```

Add `activity` to the returned object:

```ts
  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, toggle, killAll, refresh };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/hooks/useStrategyController.test.ts`
Expected: PASS. (Full mobile suite is still red — AgentScreen `mockApiFake` lacks `getRecentActivity`; fixed in B3.)

- [ ] **Step 5: Commit**

```bash
git add mobile/src/hooks/useStrategyController.ts mobile/src/hooks/useStrategyController.test.ts
git commit --no-verify -m "feat(mobile): controller loads recent activity in refresh"
```

---

### Task B3: `AgentScreen` "Recent activity" section + i18n

**Files:**
- Modify: `mobile/src/i18n/messages.ts` (en + zh)
- Modify: `mobile/src/screens/AgentScreen.tsx`
- Modify: `mobile/src/screens/AgentScreen.test.tsx`

- [ ] **Step 1: Add i18n keys** to BOTH the `en` and `zh` maps in `messages.ts` (parity enforced by `messages.test.ts`). Place near the other `agent.*` keys.

```ts
// en
"agent.recentActivity": "Recent activity",
"agent.noActivity": "No activity yet — fills and triggers will show here.",
```

```ts
// zh
"agent.recentActivity": "最近活动",
"agent.noActivity": "暂无活动——成交与触发会显示在这里。",
```

- [ ] **Step 2: Update `mockApiFake` + write the failing screen test** in AgentScreen.test.tsx.

Add to the `mockApiFake` object:

```ts
  getRecentActivity: jest.fn(async () => [] as unknown[]),
```

Add to `beforeEach` (after `mockApiFake.listStrategies.mockResolvedValue([]);`):

```ts
    mockApiFake.getRecentActivity.mockResolvedValue([]);
```

Add the test:

```ts
it("shows recent activity rows once connected", async () => {
  mockApiFake.getRecentActivity.mockResolvedValue([
    { id: "a1", time: 1710000000000, coin: "BTC", side: "buy", sz: 0.01, px: 50000 },
  ]);
  render(<AgentScreen />);
  fireEvent.press(screen.getByTestId("strategy-connect-btn"));
  await waitFor(() => expect(screen.getByTestId("activity-a1")).toBeTruthy());
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd mobile && npx jest src/screens/AgentScreen.test.tsx`
Expected: FAIL — `activity-a1` not found.

- [ ] **Step 4: Implement the section + row** in `AgentScreen.tsx`.

Add imports:

```ts
import { formatTimeHMS } from "../lib/hyperliquid/format";
```

Extend the strategyApi import to include `Activity`:

```ts
import { StrategyApi, type Strategy, type DcaParams, type TwapParams, type TpslParams, type Activity } from "../services/strategyApi";
```

(Match the existing import statement's style; the key point is `Activity` is imported as a type.)

Add the `ActivityRow` component (next to `StrategyRow`):

```tsx
function ActivityRow({ theme, activity }: { theme: ThemeTokens; activity: Activity }) {
  const t = useT();
  const buy = activity.side === "buy";
  return (
    <SurfaceCard theme={theme} rule={false} testID={`activity-${activity.id}`} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>
          {activity.coin} · <Text style={{ color: buy ? theme.up : theme.down }}>{buy ? t("agent.buy") : t("agent.sell")}</Text>
        </Text>
        <Text style={[styles.hint, { color: theme.muted }]}>
          {`${activity.sz} @ ${activity.px} · ${formatTimeHMS(activity.time)}`}
        </Text>
      </View>
    </SurfaceCard>
  );
}
```

In `StrategyPanel`, render the section after the "My strategies" block (after the strategies `.map(...)` and before the "New …" form cards, or after the kill-switch — place it after the strategies list):

```tsx
<Text style={[styles.eyebrow, { color: theme.faint }]}>{t("agent.recentActivity")}</Text>
{ctrl.activity.length === 0 ? (
  <Text style={[styles.hint, { color: theme.muted }]}>{t("agent.noActivity")}</Text>
) : (
  ctrl.activity.map((a) => <ActivityRow key={a.id} theme={theme} activity={a} />)
)}
```

- [ ] **Step 5: Run the gates + commit**

Run:
```
cd mobile && npx tsc --noEmit && npx jest && npx jest noHardcodedColors
```
Then emoji scan (macOS BSD grep lacks -P; use ripgrep): `rg -n "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src/screens/AgentScreen.tsx src/i18n/messages.ts || echo "no emoji"`
Expected: tsc clean; jest ≥ baseline (was 728, now higher); noHardcodedColors PASS; "no emoji".

```bash
git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx mobile/src/i18n/messages.ts
git commit --no-verify -m "feat(mobile): Recent activity section on the Agent tab"
```

---

## Final verification

- [ ] **Server:** `cd server && npx tsc --noEmit && npx jest` — green, ≥ 116 tests.
- [ ] **Mobile:** `cd mobile && npx tsc --noEmit && npx jest` (≥ 728) `&& npx jest noHardcodedColors`; i18n parity `npx jest messages`; emoji scan → "no emoji".
- [ ] Report final server + mobile pass counts vs baselines. Await the user's explicit "push".
