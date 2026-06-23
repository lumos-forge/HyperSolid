# Continuous Agent Loop 2 — Strategy Backend Ops Hardening

> **Loop type:** sequential. One crafted prompt, executed task-by-task with a quality gate every
> iteration until all acceptance criteria pass. **Scope:** `server/` (+ `.github/workflows/ci.yml`).
> Self-contained, network-free, TDD. Live-testnet wiring, deployment, and Phase D strategies are
> **out of loop**.

## Per-iteration protocol

1. Pick the first `pending` task from the Backlog.
2. Write the failing test first (Jest/ts-jest). Run it; confirm it FAILS for the right reason.
   (Config-only tasks like CI have no Jest test — validate the file instead.)
3. Implement the minimal code to pass. YAGNI. DRY.
4. **Quality gate:** `cd server && npx tsc --noEmit` → 0; `npx jest` → all green, count only grows; no
   real HL network / no real keys in tests; no secret committed.
5. Commit (`git commit --no-verify`) with the Co-authored-by trailer.
6. Mark the task done in loop state. Repeat.

## Guardrails

Same as Loop 1: never touch mobile wallet-security / HL encoding core / IntentLedger; agent keys stay
encrypted + server-only; `owner` from the verified token; fail closed on uncertain receipts; push only
when the user says so.

## Backlog

### M1 — Health endpoint + opt-in request logging
**Files:** `server/src/http/app.ts` (+ `app.test.ts`); `server/src/index.ts`.
- Add `version?: string` and `logger?: boolean` to `AppDeps`. `GET /health` (public) →
  `{ ok: true, version }` (version defaults to `"0.1.0"`). Fastify logger off by default; `logger:true`
  enables request logging.
- index.ts: pass `version: VERSION` and `logger: process.env.LOG_REQUESTS === "1"`.
- Test: `GET /health` → 200 `{ ok: true, version: "0.1.0" }` with no auth.

### M2 — Auth nonce TTL sweep
**Files:** `server/src/auth/auth.ts` (+ `auth.test.ts`).
- Add `pendingCount(): number`. On each `challenge`, prune entries whose `expiresAt <= now` so the
  pending map can't grow unbounded from abandoned challenges.
- Test: issue N challenges at t=0; at t=nonceTtl+1 issue one more → `pendingCount()` is 1 (old ones
  swept). A still-valid challenge is NOT pruned.

### M3 — Daily notional (spend) cap
> The spec lists a "daily-loss cap"; on a buy-only DCA engine the actionable analog is a per-owner
> **daily spend (notional) cap** — implement that and document the interpretation.
**Files:** `server/src/strategies/activityStore.ts` (+test), `server/src/engine/scheduler.ts` (+test),
`server/src/index.ts`.
- `ActivityStore.notionalSince(owner, sinceMs): number` (sum of `sz*px` for the owner since a time),
  on Memory + Sqlite. Add a `dayStartUtcMs(now)` helper (exported from scheduler or a small util).
- `tick` gains an optional `dailyMaxNotionalUsdc?` limit: before placing, if
  `activity.notionalSince(owner, dayStart) + notional > dailyMaxNotionalUsdc`, skip (no place, no
  advance). Recompute per strategy so cumulative spend within the tick is respected.
- index.ts: read `DAILY_MAX_NOTIONAL_USDC` env (optional) and pass it.
- Test: dailyMax=100, two due strategies of 60 each for one owner → first fires, second skipped; a
  different owner is unaffected.

### M4 — Server CI job
**Files:** `.github/workflows/ci.yml`.
- Add a second job `server` mirroring the `mobile` job: `working-directory: server`, node 22,
  `cache-dependency-path: server/package-lock.json`, `npm ci`, `npx tsc --noEmit`, `npx jest --ci`.
- Validate: the YAML parses (e.g. `node -e "require('js-yaml')"` is unavailable — instead confirm
  structure by eye + `npx --yes yaml-lint` if present, else a `python -c` yaml.safe_load).

## Acceptance criteria

- M1–M4 done, each its own commit.
- `cd server && npx tsc --noEmit` → 0; `npx jest` → all green (≥ 61 + new).
- `/health` returns ok without auth; pending-nonce memory is bounded; daily spend cap skips over-budget
  placements; CI has a green-able `server` job.
- Working tree clean; commits carry the trailer; nothing pushed.
