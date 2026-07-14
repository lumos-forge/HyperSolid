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
