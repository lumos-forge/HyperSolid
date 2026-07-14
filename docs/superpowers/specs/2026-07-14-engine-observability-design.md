# Engine Observability (Prometheus Metrics) — Design

> **Status:** approved design. Scope: give the agentic engine (`server/`) Prometheus metrics + a
> `/metrics` endpoint, mirroring the signer's M10 observability. The engine currently exports **nothing**
> — it runs strategies, places orders, arms the dead-man, and reconciles, but is unobservable in prod.

## Context

The Go signer has full Prometheus/OTel/SLO coverage (M10, `internal/metrics`, `hypersolid_*`,
`/metrics`). The TS agentic engine has **no metrics at all**. For a production-grade deploy, the engine
must at least expose: is it ticking, how long ticks take, how many strategies are running, dead-man
health, and — on the delegated path — signer request health.

## Goal

`GET /metrics` on the engine returns Prometheus text with a focused, high-value metric set, updated
fail-safe from the existing orchestration (no change to scheduler/placer/deadMan internals). Consistent
with the signer: `hypersolid_engine_*` names, open scrape endpoint, `prom-client` (the Node standard).

## Metrics (`hypersolid_engine_*`)

| Metric | Type | Labels | Source |
|---|---|---|---|
| `hypersolid_engine_tick_duration_seconds` | Histogram | — | scheduler tick wall time |
| `hypersolid_engine_ticks_total` | Counter | `result` (ok\|error) | each tick's settle |
| `hypersolid_engine_strategies` | Gauge | `status` | `store.listAll()` grouped by status, per tick |
| `hypersolid_engine_deadman_health_events_total` | Counter | `event` (alert\|recovered) | existing `onHealthEvent` |
| `hypersolid_engine_signer_requests_total` | Counter | `op` (sign\|reconcile\|createKey), `result` (ok\|error) | delegated `SignerClient` |
| `hypersolid_engine_signer_request_duration_seconds` | Histogram | `op` | delegated `SignerClient` |

## Components (all in `server/`)

### 1. `src/obs/metrics.ts`

- A **dedicated `Registry`** (not the global default — test isolation, no cross-registry clashes) with
  the six metrics registered on it.
- **Fail-safe helper fns** — each wraps the metric mutation in try/catch so a metrics error can never
  throw into the trade path: `observeTick(seconds)`, `incTick(result)`, `setStrategies(counts: Record<string, number>)`,
  `incDeadManHealth(event)`, `observeSignerRequest(op, result, seconds)`.
- `metricsText(): Promise<string>` = `register.metrics()`; `metricsContentType` = `register.contentType`.
- `resetMetrics()` for tests (`register.resetMetrics()`).

### 2. `src/agent/meteredSignerClient.ts` — `MeteredSignerClient extends SignerClient`

Overrides `sign` / `reconcile` / `createKey` to time the call and record `observeSignerRequest(op,
ok|error, seconds)` (on both success and thrown error, re-throwing the error), then delegate to `super`.
Because it **is** a `SignerClient`, it's assignable everywhere the delegation deps expect one — zero
interface change. `deleteKey` (rare provisioning) is left un-metered (inherited).

### 3. `/metrics` route (`src/http/app.ts`)

`app.get("/metrics")` sets `Content-Type: metricsContentType` and returns `await metricsText()`. Open
(standard Prometheus scrape, same as the signer). No auth (internal scrape target; the app already has
authed routes elsewhere but `/metrics` and `/health` are open).

### 4. Wiring (`src/index.ts`) — orchestration-level only

- **Tick**: wrap the `setInterval` body — start a timer, and on the tick promise's settle record
  `observeTick(elapsed)` + `incTick("ok"|"error")`; compute `setStrategies(...)` from `store.listAll()`
  grouped by `status` each tick.
- **Dead-man**: in the existing `onHealthEvent` callback, `incDeadManHealth(ev.kind)` for
  `alert`/`recovered`.
- **Signer**: when delegation is on, wrap the `SignerClient` in `MeteredSignerClient` before passing it
  to `AgentManager` + `makeClientFor` (one construction site).

No changes to `scheduler.ts`, `placer.ts`, `restingExecutor.ts`, `deadMan.ts`, or `signerClient.ts`.

## Error handling

- Every helper is fail-safe (try/catch, swallow) — metrics never affect trading.
- `MeteredSignerClient` records the error metric then **re-throws** (callers' fail-closed behavior is
  unchanged).
- `/metrics` only reads the registry (no side effects).

## Testing (`cd server && npm run typecheck && npm test`)

- **`metrics.ts`:** after `incTick("ok")` / `observeTick` / `setStrategies({running:2})` / `incDeadManHealth("alert")`
  / `observeSignerRequest("sign","ok",0.01)`, `await metricsText()` contains the expected series + values;
  `resetMetrics()` clears counters between tests.
- **`MeteredSignerClient`:** with an injected fake `fetchImpl`, a successful `sign` records
  `signer_requests_total{op="sign",result="ok"}`; a thrown request records `result="error"` and
  re-throws; the returned value is unchanged.
- **`/metrics` route** (`app.test.ts`): returns 200, the Prometheus content-type, and a body containing
  `hypersolid_engine_` after a metric has been recorded.

## Decomposition (single PR, 3 steps)

1. `prom-client` dep + `src/obs/metrics.ts` + tests.
2. `MeteredSignerClient` + tests; `/metrics` route + app test.
3. `index.ts` wiring (tick + strategies gauge + dead-man health + metered signer).

## Out of scope

- Per-strategy-kind placement success/fail counters (would need scheduler/placer instrumentation).
- OTel traces / structured logs for the engine (the signer has these; a later unit).
- Alerting rules / SLOs for the engine (a follow-up, like the signer's `ops/slo`).
