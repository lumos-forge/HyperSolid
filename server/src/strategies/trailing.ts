import type { TrailingParams } from "./types";

/** Advance the favorable extreme: for a long (szi>0) the running max mark; for a
 *  short (szi<0) the running min mark. `prev` undefined seeds it at `mark`. */
export function updateTrailPeak(szi: number, mark: number, prev: number | undefined): number {
  if (prev === undefined) return mark;
  return szi > 0 ? Math.max(prev, mark) : Math.min(prev, mark);
}

/** True when the mark has retraced trailPct% from the extreme, closing the position.
 *  Long: mark <= peak*(1 - trailPct/100). Short: mark >= trough*(1 + trailPct/100). */
export function trailingTriggered(p: TrailingParams, szi: number, mark: number, peak: number): boolean {
  const r = p.trailPct / 100;
  if (szi > 0) return mark <= peak * (1 - r);
  if (szi < 0) return mark >= peak * (1 + r);
  return false;
}
