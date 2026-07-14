export const DEADMAN_MAX_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-owner arm budget: the UTC day, that day's counting-arm count, and the armed-until time (ms). */
export interface ArmBudget {
  day: number;
  count: number;
  armedUntil: number;
}
export type ArmDecision = { skip: true } | { skip: false; time: number; counts: boolean };

/** A still-future schedule → free refresh; else a counting new-arm unless the day's 10 is exhausted. */
export function decideArm(prev: ArmBudget | undefined, nowMs: number, ttlMs: number): ArmDecision {
  const time = nowMs + ttlMs;
  const day = Math.floor(nowMs / DAY_MS);
  const count = prev && prev.day === day ? prev.count : 0;
  const armedUntil = prev ? prev.armedUntil : 0;
  if (armedUntil > nowMs) return { skip: false, time, counts: false };
  if (count >= DEADMAN_MAX_PER_DAY) return { skip: true };
  return { skip: false, time, counts: true };
}

/** Commit a successful arm: armedUntil=time; increment the day's counter iff counts (reset on new day). */
export function nextArm(prev: ArmBudget | undefined, nowMs: number, time: number, counts: boolean): ArmBudget {
  const day = Math.floor(nowMs / DAY_MS);
  const base = prev && prev.day === day ? prev.count : 0;
  return { day, count: base + (counts ? 1 : 0), armedUntil: time };
}
