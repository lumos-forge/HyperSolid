# Durable Dead-Man Budget — Design

> **Status:** approved design. Scope: close the one concrete restart-safety gap in the agentic engine —
> the dead-man switch's arm budget is in-memory and resets on restart.

## Context

The agentic engine (`server/`) arms an HL `scheduleCancel` (dead-man switch) per active owner every tick
via `deadManHeartbeat` (`server/src/engine/deadMan.ts`). Hyperliquid limits **counting** scheduleCancel
arms to **10 per UTC day** per account; refreshing a still-future armed schedule is free and does not
count. `makeDeadManBudget()` tracks, per owner, `{ day, count, armedUntil }` to respect that limit — but
it is backed by an in-memory `Map`.

On process restart (crash, deploy, OOM), that map is lost:

- `count` resets to `0`, so the engine's view of "arms used today" diverges below HL's real count. A
  **crash-loop or frequent deploys** can then send many counting arms in a day, exceeding HL's real
  10/day limit. Once HL's limit is hit, HL rejects further scheduleCancel arms → the dead-man switch can
  no longer be refreshed → **silent loss of protection** (a safety-relevant failure).
- `armedUntil` resets to `0`, so the first post-restart heartbeat is treated as a **counting** new-arm
  (`counts: true`) even though the schedule is almost certainly still future on HL (a free refresh),
  needlessly consuming budget.

Everything else in the engine is already restart-safe: strategy state (trailPeak, gridLimit rung/seq,
actionsDone, nextRunAt) is durable in SQLite and re-read each tick; placements use deterministic cloids
(replay-safe via the signer nonce ledger + HL kernel dedup); daily notional caps are read from the
durable activity store; graceful shutdown clears the dead-man and startup clears stale owners.

Multi-instance / multi-AZ HA (shared Postgres state + leader election) is a separate GA-scale effort and
is **out of scope**.

## Goal

Persist the dead-man arm budget durably (same SQLite DB the engine already uses) so the 10/day counting
budget and `armedUntil` survive restarts — a crash-loop can no longer blow HL's real limit and silently
disable the dead-man switch. No change to the heartbeat's observable arming/refresh behavior.

## Non-goals

- Multi-instance / cross-host shared state (Postgres), leader election, multi-AZ.
- Persisting dead-man *health* (consecutive-failure / alerting) state — a restart merely restarts the
  ≤3-tick alert countdown; low-impact, YAGNI.
- Any change to `deadManHeartbeat`, `deadManClearAll`, `staleDeadManOwners`, or the executor.

## Architecture

Keep the existing `DeadManBudget` interface (`decide` / `record`) exactly. Add a SQLite-backed
implementation that is a drop-in replacement, wired in `index.ts`. The in-memory `makeDeadManBudget`
stays for tests and as the reference semantics.

```
deadManHeartbeat (unchanged)
   ├── budget.decide(owner, now, ttl)   → { skip } | { skip:false, time, counts }   [pure read]
   └── budget.record(owner, now, time, counts)  (on a successful arm)                [durable write]

DeadManBudget  (interface, unchanged)
   ├── makeDeadManBudget()          — in-memory Map (tests / reference)
   └── SqliteDeadManBudgetStore.open(dbPath) — durable, used in production
```

### Shared pure transition logic (DRY + parity by construction)

Extract the two pure state transitions from `makeDeadManBudget` into named functions in `deadMan.ts`, so
both backends compute identical decisions and only differ in IO:

- `decideBudget(prev: OwnerBudget | undefined, nowMs, ttlMs): DeadManDecision`
- `nextBudget(prev: OwnerBudget | undefined, nowMs, time, counts): OwnerBudget`

where `OwnerBudget = { day: number; count: number; armedUntil: number }`. `makeDeadManBudget` becomes a
thin `Map` wrapper over these; `SqliteDeadManBudgetStore` is a thin SQLite wrapper over the same two
functions. Behavior is therefore guaranteed identical; the existing in-memory budget tests continue to
pass unchanged, and the SQLite tests focus on durability + parity.

### Storage

- **File:** `server/src/engine/sqliteDeadManBudget.ts`
- **Table:**
  ```sql
  CREATE TABLE IF NOT EXISTS dead_man_budget (
    owner       TEXT PRIMARY KEY,
    day         INTEGER NOT NULL,
    count       INTEGER NOT NULL,
    armed_until INTEGER NOT NULL
  );
  ```
  One row per owner, upserted on `record` — bounded by the number of owners (no unbounded growth). Day
  rollover is handled in `decideBudget`/`nextBudget` (count resets when the stored `day` differs), so
  `decide` stays read-only and no cleanup job is needed.
- **`decide`** reads the owner's row (or undefined) and returns `decideBudget(prev, now, ttl)` — no write.
- **`record`** reads the owner's row, computes `nextBudget(prev, now, time, counts)`, and upserts it.
- Uses `better-sqlite3` (synchronous), same as the other engine stores; the single-threaded sequential
  heartbeat means no write contention. Owner matching follows the existing budget (exact string; the
  heartbeat already passes owner addresses consistently).

### Wiring (`index.ts`)

Replace:
```ts
const deadManBudget = makeDeadManBudget();
```
with:
```ts
const deadManBudget = SqliteDeadManBudgetStore.open(dbPath);
```
(`dbPath` is already in scope, shared by the other stores.)

## Error handling

- The store is only consulted when `deadManEnabled` (unchanged gate). A SQLite error would throw into
  the heartbeat, which `index.ts` already wraps: `deadManHeartbeat(...).catch(e => console.error(...))`.
  A failed `record` therefore does not crash the tick; the next tick retries (the same fail-closed spirit
  as the rest of the heartbeat). No new swallowing is introduced.
- Additive `CREATE TABLE IF NOT EXISTS` — safe on existing engine DBs; no migration of prior data
  (an empty budget after upgrade is safe: at worst the first arms of the day count from zero, which is
  the current behavior).

## Testing

`server/src/engine/sqliteDeadManBudget.test.ts` (better-sqlite3 `:memory:` and a temp file for reopen):

- **Durability:** `record` a counting arm, reopen the store on the same file, and `decide` reflects the
  persisted `count` (a reopened store does not reset the day's budget).
- **Budget cap across restart:** record `DEADMAN_MAX_PER_DAY` counting arms (advancing `armedUntil` past
  each `now` so each counts), reopen, and `decide` returns `{ skip: true }` — a restart cannot re-open the
  budget and exceed HL's 10/day.
- **Free refresh after restart:** with `armedUntil` in the future, a reopened store's `decide` returns
  `{ skip: false, counts: false }` (refresh, not a counting arm).
- **Day rollover:** a stored row from a prior day yields `count = 0` on `decide`/`nextBudget` for the new
  day.
- **Parity:** the same call sequence produces identical `DeadManDecision`s from `makeDeadManBudget()` and
  `SqliteDeadManBudgetStore` (a small shared-scenario table asserts both agree).

The existing `deadMan.test.ts` budget cases must pass unchanged (proves the pure-function extraction did
not alter in-memory behavior). Validation: `cd server && npm run typecheck && npm test`.

## Decomposition

Single unit / single PR:
1. Extract `decideBudget` / `nextBudget` pure functions in `deadMan.ts`; refactor `makeDeadManBudget` to
   use them (in-memory tests stay green).
2. Add `SqliteDeadManBudgetStore` + tests.
3. Wire it in `index.ts`; validate typecheck + full suite.
