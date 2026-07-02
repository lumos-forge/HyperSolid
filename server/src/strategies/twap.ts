import type { Strategy, TwapParams } from "./types";

/** Running TWAP strategies whose next slice is due and that have slices remaining. */
export function dueTwap(list: Strategy[], now: number): Strategy[] {
  return list.filter(
    (s) =>
      s.kind === "twap" &&
      s.status === "running" &&
      (s.nextRunAt ?? 0) <= now &&
      (s.slicesDone ?? 0) < s.params.slices,
  );
}

/** Per-slice notional (USDC). */
export function twapSliceUsdc(p: TwapParams): number {
  return p.slices > 0 ? p.totalUsdc / p.slices : 0;
}

/** Milliseconds between slices = duration / slices. */
export function twapIntervalMs(p: TwapParams): number {
  return p.slices > 0 ? (p.durationHours * 3600 * 1000) / p.slices : 0;
}
