# Strategy Activity Feed

Date: 2026-07-02
Status: Approved (brainstorming)
Depends on: `2026-06-23-strategy-automation-design.md`, `2026-07-01-strategy-templates-twap-tpsl-design.md`

## 1. Goal

Surface strategy execution history in the app. The backend already records an
activity row on every fill (DCA/TWAP slices) and every TP/SL trigger, but the
mobile app never displays it. Add an aggregated **"Recent activity"** list on the
Agent tab showing all of the owner's strategy fills/triggers, newest first.

Non-goals (YAGNI): push notifications, per-strategy drill-down, infinite scroll /
pagination beyond a simple `limit`, filtering/search, PnL computation.

## 2. Decisions (locked)

| # | Decision |
|---|----------|
| D1 | Aggregated owner-wide feed on the Agent tab (not per-strategy drill-down). |
| D2 | Backed by a new server endpoint `GET /activity?limit=N` (not client-side fan-out), so history from deleted/completed strategies is still visible. |
| D3 | Reuse the existing activity DTO shape `{ id, time, coin, side, sz, px }`. |

## 3. Server

### 3.1 `ActivityStore.listRecent(owner, limit)`
Add to the `ActivityStore` interface and both impls (`MemoryActivityStore`,
`SqliteActivityStore`). Owner-scoped, newest-first, capped at `limit`.

- Memory: filter by owner (case-insensitive), sort by `time` desc, `slice(0, limit)`.
- Sqlite: `SELECT * FROM activity WHERE owner = ? ORDER BY time DESC LIMIT ?`
  (the existing `activity_lookup(owner, strategy_id, time)` index covers the owner
  + time ordering).

### 3.2 `GET /activity`
New authed route in `buildApp` (owner derived from the bearer token, never the
query). Query param `limit` (default 50, clamped to 1..200; non-numeric → default).
Returns the same DTO shape the per-strategy route already emits:

```ts
[{ id, time, coin, side, sz, px }]   // newest first
```

Public/health/config routes and all existing strategy routes are unchanged.

## 4. Mobile

### 4.1 API — `StrategyApi.getRecentActivity(limit?)`
`GET /activity?limit=<n>` → `Activity[]` (existing `Activity` type). Default limit
omitted → server default (50).

### 4.2 Controller — `useStrategyController`
Extend `refresh()` to also fetch recent activity in the existing `Promise.all`, and
expose `activity: Activity[]` from the hook. A failed activity fetch must not break
status/strategies loading — the hook's existing `refresh().catch(() => undefined)`
already guards the effect; keep the three fetches in one `Promise.all` so a failure
degrades the whole refresh consistently (the screen already handles a failed refresh
by keeping last-known state).

### 4.3 Screen — `AgentScreen`
Below the "My strategies" section (inside the connected `StrategyPanel`), add a
**"Recent activity"** section:

- `SectionLabel`/eyebrow: `t("agent.recentActivity")`.
- Each row (`testID={activity-<id>}`): `COIN` + side pill (`t("agent.buy")` /
  `t("agent.sell")`) + size + `@ px` + a compact time.
  - Line 1: `{coin} · {buy|sell}`
  - Line 2 (muted): `{sz} @ {px} · {time}`
- Empty state: `t("agent.noActivity")` when `activity.length === 0`.
- Show at most the fetched rows (server-capped); no client pagination.

Colors: buy uses `theme.up`, sell uses `theme.down` (existing tokens); all other
text uses existing theme tokens — no hardcoded hex. No emoji. All strings via
`useT()` with keys added to BOTH en and zh.

Time formatting: reuse an existing formatter if the codebase has one (e.g. a
`formatTime`/relative-time helper); otherwise render a compact local `HH:MM` from
`new Date(time)`. (Resolved during planning by checking existing helpers.)

### 4.4 i18n keys (en + zh)
`agent.recentActivity`, `agent.noActivity`. Reuse existing `agent.buy` / `agent.sell`.

## 5. Testing (TDD)

**Server**
- `activityStore` (memory + sqlite): `listRecent` newest-first, respects `limit`,
  owner-scoped (excludes other owners), returns rows across multiple strategies.
- `http/app`: `GET /activity` requires auth (401 without token); returns newest-first
  DTOs; honors `limit`; owner-scoped.

**Mobile**
- `strategyApi`: `getRecentActivity(limit)` hits `/activity?limit=<n>` with the bearer
  header; parses rows.
- `useStrategyController`: `refresh()` populates `activity`; exposed from the hook.
- `AgentScreen`: renders activity rows when present (asserts a row testID + coin/side)
  and the empty state when none.

**Gates**: server `npx tsc --noEmit && npx jest`; mobile `npx tsc --noEmit && npx jest`
(≥ baseline) + `npx jest noHardcodedColors` + emoji grep.

## 6. Risks & mitigations

- **Activity fetch failure** — degrade gracefully: the feed shows its last-known /
  empty state; strategy management remains usable (single `Promise.all` refresh,
  guarded by the existing catch).
- **Large history** — bounded by the `limit` clamp (≤200) server-side; no unbounded
  client list.
- **Deleted-strategy rows** — intentionally retained and shown (audit value); rows
  carry `coin/side/sz/px`, which stay meaningful without the parent strategy.
