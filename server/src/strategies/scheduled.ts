import type { ScheduledParams } from "./types";

/** True when the scheduled trigger time has arrived. */
export function scheduledDue(p: ScheduledParams, now: number): boolean {
  return now >= p.runAt;
}
