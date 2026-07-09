import type { DeadManExecutor } from "../agent/deadManExecutor";

/** Max counting scheduleCancel arms per UTC day (HL dead-man limit). Refreshing a still-future
 *  armed schedule is free and does not count. */
export const DEADMAN_MAX_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DeadManDecision = { skip: true } | { skip: false; time: number; counts: boolean };

export interface DeadManBudget {
  /** Decide the action for owner at nowMs: a free refresh, a counting new-arm, or skip when the
   *  daily budget is exhausted and a new arm would be needed. Does NOT mutate state. */
  decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision;
  /** Commit a SUCCESSFUL send: set armedUntil=time; increment the day's counter iff counts. */
  record(owner: string, nowMs: number, time: number, counts: boolean): void;
}

interface OwnerState {
  day: number;
  count: number;
  armedUntil: number;
}

export function makeDeadManBudget(): DeadManBudget {
  const state = new Map<string, OwnerState>();
  return {
    decide(owner: string, nowMs: number, ttlMs: number): DeadManDecision {
      const time = nowMs + ttlMs;
      const day = Math.floor(nowMs / DAY_MS);
      const prev = state.get(owner);
      const count = prev && prev.day === day ? prev.count : 0;
      const armedUntil = prev ? prev.armedUntil : 0;
      if (armedUntil > nowMs) return { skip: false, time, counts: false };
      if (count >= DEADMAN_MAX_PER_DAY) return { skip: true };
      return { skip: false, time, counts: true };
    },
    record(owner: string, nowMs: number, time: number, counts: boolean): void {
      const day = Math.floor(nowMs / DAY_MS);
      const prev = state.get(owner);
      const base = prev && prev.day === day ? prev.count : 0;
      state.set(owner, { day, count: base + (counts ? 1 : 0), armedUntil: time });
    },
  };
}

/** Consecutive unprotected heartbeats before raising an alert (~alertAfter × tick of no protection). */
export const DEADMAN_ALERT_AFTER = 3;

export type DeadManHealthEvent =
  | { kind: "none" }
  | { kind: "alert"; consecutiveFailures: number }
  | { kind: "recovered" };

export interface DeadManHealth {
  /** Record one heartbeat outcome for owner (armed = did we successfully arm/refresh this tick).
   *  Returns a transition event (alert on crossing the threshold, recovered on first success after an
   *  alert) or { kind: "none" } in steady state. */
  record(owner: string, armed: boolean): DeadManHealthEvent;
}

interface HealthState {
  failures: number;
  alerting: boolean;
}

export function makeDeadManHealth(alertAfter: number = DEADMAN_ALERT_AFTER): DeadManHealth {
  const state = new Map<string, HealthState>();
  return {
    record(owner: string, armed: boolean): DeadManHealthEvent {
      const s = state.get(owner) ?? { failures: 0, alerting: false };
      if (armed) {
        const wasAlerting = s.alerting;
        state.set(owner, { failures: 0, alerting: false });
        return wasAlerting ? { kind: "recovered" } : { kind: "none" };
      }
      const failures = s.failures + 1;
      if (!s.alerting && failures >= alertAfter) {
        state.set(owner, { failures, alerting: true });
        return { kind: "alert", consecutiveFailures: failures };
      }
      state.set(owner, { failures, alerting: s.alerting });
      return { kind: "none" };
    },
  };
}

export interface DeadManHeartbeatDeps {
  /** Owners with >=1 running strategy. Duplicates are de-duped internally. */
  activeOwners(): string[];
  budget: DeadManBudget;
  executor: DeadManExecutor;
  now(): number;
  ttlMs: number;
  /** Optional health tracker: records whether each owner was protected this tick. */
  health?: DeadManHealth;
  /** Optional sink for health transition events (e.g. a logger). */
  onHealthEvent?: (owner: string, event: DeadManHealthEvent) => void;
}

/** One heartbeat pass: for each active owner, arm/refresh scheduleCancel per the budget, recording
 *  only on a successful send. A budget skip or an arm failure both count as "unprotected this tick"
 *  for the optional health tracker, which surfaces transition events (alert/recovered). Sequential. */
export async function deadManHeartbeat(deps: DeadManHeartbeatDeps): Promise<void> {
  const now = deps.now();
  for (const owner of new Set(deps.activeOwners())) {
    const d = deps.budget.decide(owner, now, deps.ttlMs);
    let armed = false;
    if (!d.skip) {
      armed = await deps.executor.arm(owner, d.time);
      if (armed) deps.budget.record(owner, now, d.time, d.counts);
    }
    const ev = deps.health?.record(owner, armed);
    if (ev && ev.kind !== "none") deps.onHealthEvent?.(owner, ev);
  }
}

/** Best-effort clear of the dead-man for every (deduped) owner, e.g. on graceful shutdown. A single
 *  owner's failure does not stop the rest (executor.clear is itself never-throwing). Sequential. */
export async function deadManClearAll(deps: {
  activeOwners(): string[];
  executor: Pick<DeadManExecutor, "clear">;
}): Promise<void> {
  for (const owner of new Set(deps.activeOwners())) {
    await deps.executor.clear(owner);
  }
}

/** Owners with a running strategy that are NOT opted in. Their dead-man may have been armed by a
 *  prior always-on version; since this version won't refresh them, they must be cleared once on
 *  startup so an orphaned schedule doesn't fire unrefreshed. Deduped. */
export function staleDeadManOwners(runningOwners: string[], optedInOwners: string[]): string[] {
  const optedIn = new Set(optedInOwners);
  return [...new Set(runningOwners)].filter((o) => !optedIn.has(o));
}
