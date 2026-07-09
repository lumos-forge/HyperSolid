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
