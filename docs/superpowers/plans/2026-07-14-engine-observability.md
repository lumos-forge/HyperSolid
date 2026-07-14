# Engine Observability (Prometheus Metrics) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Prometheus metrics + a `/metrics` endpoint to the agentic engine (`server/`) — tick duration/count, strategies gauge, dead-man health, and delegated signer request health — updated fail-safe from the existing orchestration.

**Architecture:** A dedicated `prom-client` registry in `src/obs/metrics.ts` with fail-safe helpers; a `MeteredSignerClient extends SignerClient` for the delegated path; a `/metrics` route on the Fastify app; instrumentation only at the `index.ts` orchestration level (no scheduler/placer/deadMan changes).

**Tech Stack:** TypeScript (server/), `prom-client`, Fastify, Jest.

**Spec:** `docs/superpowers/specs/2026-07-14-engine-observability-design.md`

---

## Background / invariants (read first)

- Consistent with the signer (Go, `internal/metrics`): `hypersolid_*` names, open `/metrics` scrape. Engine uses the `hypersolid_engine_` prefix + `prom-client` (Node standard).
- Strategy statuses (`src/strategies/types.ts`): `"running" | "paused" | "completed" | "canceling"`.
- `SignerClient` (`src/agent/signerClient.ts`) ctor `(baseUrl, fetchImpl?, timeoutMs?)`; methods `createKey(req)→ProvisionKeyResult`, `sign(req)→SignResult`, `reconcile(keyId,cloid,status)→void`, `deleteKey(keyId)→void`. Types `ProvisionKeyRequest/Result`, `SignRequest/Result`, `ReconcileStatus` are exported.
- The delegated `SignerClient` is constructed once in `index.ts` (`process.env.SIGNER_DELEGATION === "1"` branch, `new SignerClient(requireEnv("SIGNER_URL"))`).
- The tick runs in `index.ts`'s `setInterval` (`void tick(...).catch(...)`); the dead-man `onHealthEvent(owner, ev)` callback exists there (`ev.kind` ∈ `none|alert|recovered`).
- `/health` route pattern: `app.get("/health", async () => ({...}))`. For text + content-type use `async (_req, reply) => { reply.header("Content-Type", …); return await …; }`.
- Metrics must be **fail-safe** — never throw into the trade path.
- Validate: `cd server && npm run typecheck && npm test`.

**Files:**
- Modify: `server/package.json` (add `prom-client`)
- Create: `server/src/obs/metrics.ts` (+ test)
- Create: `server/src/agent/meteredSignerClient.ts` (+ test)
- Modify: `server/src/http/app.ts` (+ `app.test.ts`)
- Modify: `server/src/index.ts`

---

## Task 1: `prom-client` dep + metrics module

**Files:** Modify `server/package.json`; create `server/src/obs/metrics.ts`, `server/src/obs/metrics.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `cd server && npm install prom-client@^15`
Expected: `prom-client` added to `dependencies`, lockfile updated.

- [ ] **Step 2: Create `server/src/obs/metrics.ts`**

```ts
import { Registry, Counter, Gauge, Histogram } from "prom-client";

/** Dedicated registry (not the global default) — test isolation + no cross-registry clashes. */
export const register = new Registry();

const tickDuration = new Histogram({
  name: "hypersolid_engine_tick_duration_seconds",
  help: "Scheduler tick wall time.",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});
const ticksTotal = new Counter({
  name: "hypersolid_engine_ticks_total",
  help: "Scheduler ticks by result.",
  labelNames: ["result"] as const,
  registers: [register],
});
const strategiesGauge = new Gauge({
  name: "hypersolid_engine_strategies",
  help: "Strategies by status.",
  labelNames: ["status"] as const,
  registers: [register],
});
const deadManHealthEvents = new Counter({
  name: "hypersolid_engine_deadman_health_events_total",
  help: "Dead-man health transition events.",
  labelNames: ["event"] as const,
  registers: [register],
});
const signerRequests = new Counter({
  name: "hypersolid_engine_signer_requests_total",
  help: "Delegated signer requests by op + result.",
  labelNames: ["op", "result"] as const,
  registers: [register],
});
const signerDuration = new Histogram({
  name: "hypersolid_engine_signer_request_duration_seconds",
  help: "Delegated signer request duration.",
  labelNames: ["op"] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/** Metrics must never throw into the trade path. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* swallow — observability is best-effort */
  }
}

export function observeTick(seconds: number): void {
  safe(() => tickDuration.observe(seconds));
}
export function incTick(result: "ok" | "error"): void {
  safe(() => ticksTotal.inc({ result }));
}
export function setStrategies(counts: Record<string, number>): void {
  safe(() => {
    for (const [status, n] of Object.entries(counts)) strategiesGauge.set({ status }, n);
  });
}
export function incDeadManHealth(event: "alert" | "recovered"): void {
  safe(() => deadManHealthEvents.inc({ event }));
}
export function observeSignerRequest(op: string, result: "ok" | "error", seconds: number): void {
  safe(() => {
    signerRequests.inc({ op, result });
    signerDuration.observe({ op }, seconds);
  });
}

export function metricsText(): Promise<string> {
  return register.metrics();
}
export const metricsContentType = register.contentType;

/** Clear recorded values (test helper). */
export function resetMetrics(): void {
  register.resetMetrics();
}
```

- [ ] **Step 3: Test** (`server/src/obs/metrics.test.ts`)

```ts
import { observeTick, incTick, setStrategies, incDeadManHealth, observeSignerRequest, metricsText, resetMetrics } from "./metrics";

describe("engine metrics", () => {
  beforeEach(() => resetMetrics());

  it("records tick, strategies, dead-man, and signer metrics into the registry text", async () => {
    observeTick(0.02);
    incTick("ok");
    incTick("error");
    setStrategies({ running: 3, paused: 1 });
    incDeadManHealth("alert");
    observeSignerRequest("sign", "ok", 0.01);

    const text = await metricsText();
    expect(text).toContain('hypersolid_engine_ticks_total{result="ok"} 1');
    expect(text).toContain('hypersolid_engine_ticks_total{result="error"} 1');
    expect(text).toContain('hypersolid_engine_strategies{status="running"} 3');
    expect(text).toContain('hypersolid_engine_deadman_health_events_total{event="alert"} 1');
    expect(text).toContain('hypersolid_engine_signer_requests_total{op="sign",result="ok"} 1');
    expect(text).toContain("hypersolid_engine_tick_duration_seconds");
  });

  it("is fail-safe on a bad value (never throws)", () => {
    expect(() => observeTick(NaN)).not.toThrow();
    expect(() => setStrategies({} as Record<string, number>)).not.toThrow();
  });
});
```

- [ ] **Step 4: Verify + commit**

Run: `cd server && npx jest src/obs/metrics.test.ts && npx tsc --noEmit`

```bash
git add server/package.json server/package-lock.json server/src/obs/metrics.ts server/src/obs/metrics.test.ts
git commit -m "feat(obs): engine Prometheus metrics registry + fail-safe helpers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: MeteredSignerClient + `/metrics` route

**Files:** Create `server/src/agent/meteredSignerClient.ts`, `server/src/agent/meteredSignerClient.test.ts`; modify `server/src/http/app.ts`, `server/src/http/app.test.ts`

- [ ] **Step 1: Create `server/src/agent/meteredSignerClient.ts`**

```ts
import {
  SignerClient,
  type ProvisionKeyRequest,
  type ProvisionKeyResult,
  type SignRequest,
  type SignResult,
  type ReconcileStatus,
} from "./signerClient";
import { observeSignerRequest } from "../obs/metrics";

async function metered<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const r = await fn();
    observeSignerRequest(op, "ok", (Date.now() - start) / 1000);
    return r;
  } catch (e) {
    observeSignerRequest(op, "error", (Date.now() - start) / 1000);
    throw e;
  }
}

/**
 * A `SignerClient` that records per-op request metrics (sign / reconcile / createKey) for the delegated
 * path. It IS a SignerClient (subclass), so it's assignable wherever one is expected — zero interface
 * change. It records then re-throws on error (callers' fail-closed behavior is unchanged).
 */
export class MeteredSignerClient extends SignerClient {
  createKey(req: ProvisionKeyRequest): Promise<ProvisionKeyResult> {
    return metered("createKey", () => super.createKey(req));
  }
  sign(req: SignRequest): Promise<SignResult> {
    return metered("sign", () => super.sign(req));
  }
  async reconcile(keyId: string, cloid: string, status: ReconcileStatus): Promise<void> {
    await metered("reconcile", () => super.reconcile(keyId, cloid, status));
  }
}
```

- [ ] **Step 2: Test** (`server/src/agent/meteredSignerClient.test.ts`)

```ts
import { MeteredSignerClient } from "./meteredSignerClient";
import { metricsText, resetMetrics } from "../obs/metrics";

type FetchLike = (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function okFetch(body: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => body });
}
function errFetch(): FetchLike {
  return async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
}

describe("MeteredSignerClient", () => {
  beforeEach(() => resetMetrics());

  it("records a successful sign", async () => {
    const c = new MeteredSignerClient("http://x", okFetch({ r: "0xr", s: "0xs", v: 27, nonce: 1, duplicate: false }) as never);
    await c.sign({ keyId: "k", kind: "order", params: {}, cloid: "0xc", isTestnet: true });
    expect(await metricsText()).toContain('hypersolid_engine_signer_requests_total{op="sign",result="ok"} 1');
  });

  it("records an errored sign and re-throws", async () => {
    const c = new MeteredSignerClient("http://x", errFetch() as never);
    await expect(c.sign({ keyId: "k", kind: "order", params: {}, cloid: "0xc", isTestnet: true })).rejects.toBeDefined();
    expect(await metricsText()).toContain('hypersolid_engine_signer_requests_total{op="sign",result="error"} 1');
  });
});
```

> If the exact 500 body shape trips `SignerClient`'s error mapping, that's fine — the test only asserts a rejection + the `result="error"` metric. Adjust `errFetch`'s body to whatever the client maps if needed.

- [ ] **Step 3: Add the `/metrics` route (`app.ts`)**

Add the import near the top:

```ts
import { metricsText, metricsContentType } from "../obs/metrics";
```

Add the route next to `/health`:

```ts
  // --- metrics (public Prometheus scrape) ---
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", metricsContentType);
    return await metricsText();
  });
```

- [ ] **Step 4: Test the route** — add to `server/src/http/app.test.ts` (reuse its `buildApp` harness):

```ts
import { incTick } from "../obs/metrics";

it("exposes Prometheus metrics at /metrics", async () => {
  incTick("ok");
  const app = /* build the app as the other tests do */ makeApp();
  const res = await app.inject({ method: "GET", url: "/metrics" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  expect(res.body).toContain("hypersolid_engine_");
});
```

> Match the file's app-construction helper (it already builds a `buildApp(deps)` for other route tests) — reuse it rather than adding a new harness.

- [ ] **Step 5: Verify + commit**

Run: `cd server && npx jest src/agent/meteredSignerClient.test.ts src/http/app.test.ts && npx tsc --noEmit`

```bash
git add server/src/agent/meteredSignerClient.ts server/src/agent/meteredSignerClient.test.ts server/src/http/app.ts server/src/http/app.test.ts
git commit -m "feat(obs): metered signer client + /metrics endpoint

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Wire the instrumentation in `index.ts`

**Files:** Modify `server/src/index.ts`

- [ ] **Step 1: Imports**

```ts
import { MeteredSignerClient } from "./agent/meteredSignerClient";
import { observeTick, incTick, setStrategies, incDeadManHealth } from "./obs/metrics";
```

- [ ] **Step 2: Meter the delegated signer**

Change the delegation branch's `signer: new SignerClient(requireEnv("SIGNER_URL")),` to:

```ts
          signer: new MeteredSignerClient(requireEnv("SIGNER_URL")),
```

(`SignerClient` may still be imported elsewhere; leave its import if used, otherwise the linter/tsc will flag it — remove only if unused.)

- [ ] **Step 3: Instrument the tick + strategies gauge**

Add a helper (near the other `const`s, after `store` is defined):

```ts
  const strategyStatusCounts = (): Record<string, number> => {
    const counts: Record<string, number> = { running: 0, paused: 0, completed: 0, canceling: 0 };
    for (const s of store.listAll()) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return counts;
  };
```

Replace the tick invocation:

```ts
    void tick(
      notifyingStore,
      placer,
      { maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc, maxOpenOrders },
      killSwitch,
      now(),
      activity,
      { resolveMark: resolvers.resolvePrice, resolvePosition: resolvers.resolvePosition },
      restingExec,
      ordersReader,
      userFillsReader,
    ).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("scheduler tick failed", e),
    );
```

with:

```ts
    const tickStart = Date.now();
    void tick(
      notifyingStore,
      placer,
      { maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc, maxOpenOrders },
      killSwitch,
      now(),
      activity,
      { resolveMark: resolvers.resolvePrice, resolvePosition: resolvers.resolvePosition },
      restingExec,
      ordersReader,
      userFillsReader,
    )
      .then(() => {
        observeTick((Date.now() - tickStart) / 1000);
        incTick("ok");
      })
      .catch((e) => {
        observeTick((Date.now() - tickStart) / 1000);
        incTick("error");
        // eslint-disable-next-line no-console
        console.error("scheduler tick failed", e);
      });
    setStrategies(strategyStatusCounts());
```

- [ ] **Step 4: Instrument dead-man health**

In the `onHealthEvent` callback, add the metric increments alongside the existing logging:

```ts
        onHealthEvent: (owner, ev) => {
          if (ev.kind === "alert") {
            incDeadManHealth("alert");
            // eslint-disable-next-line no-console
            console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
            void notifier.notify(owner, "alerts", (l) => deadManAlertNotification(ev, l)).catch(() => {});
          } else if (ev.kind === "recovered") {
            incDeadManHealth("recovered");
            // eslint-disable-next-line no-console
            console.error(`dead-man arm recovered for ${owner}`);
            void notifier.notify(owner, "alerts", (l) => deadManRecoveredNotification(l)).catch(() => {});
          }
        },
```

- [ ] **Step 5: Full validation**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (new metrics/metered/route tests; existing unaffected).

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(obs): instrument tick, strategies gauge, dead-man health, metered signer

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Finish — validate, PR, review, merge

- [ ] **Step 1:** `cd server && npm run typecheck && npm test` (green).
- [ ] **Step 2:** `git push -u origin feat/engine-observability`.
- [ ] **Step 3:** Open the PR (`gh pr create`) — summarize: engine `/metrics` + `hypersolid_engine_*` (tick duration/count, strategies gauge, dead-man health, delegated signer requests); fail-safe; no scheduler/placer/deadMan internal changes.
- [ ] **Step 4:** Background `code-review` on the diff + `gh pr checks <n> --watch` in parallel.
- [ ] **Step 5:** Address high-confidence findings; on clean review + green CI, squash-merge `--delete-branch` and sync `main`.

---

## Self-review notes (coverage vs spec)

- **Six `hypersolid_engine_*` metrics + dedicated registry + fail-safe helpers** — Task 1. ✔
- **`MeteredSignerClient` (sign/reconcile/createKey, record-then-rethrow), assignable as `SignerClient`** — Task 2. ✔
- **`/metrics` open route** — Task 2. ✔
- **Orchestration-only wiring (tick + strategies gauge + dead-man health + metered signer); no scheduler/placer/deadMan/signerClient change** — Task 3. ✔
- **Tests: metrics text, metered ok/error, /metrics route** — Tasks 1–2. ✔
