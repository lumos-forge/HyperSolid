export interface PeriodReturn {
  label: string;
  /** Percent change vs `days` ago; null when history is too short. */
  pct: number | null;
}

/** Signed percent return for each anchor, latest close vs the close `days` bars earlier. */
export function periodReturns(
  closes: number[],
  anchors: Array<{ label: string; days: number }>,
): PeriodReturn[] {
  const latest = closes[closes.length - 1];
  return anchors.map(({ label, days }) => {
    const past = closes[closes.length - 1 - days];
    if (latest === undefined || past === undefined || past === 0) return { label, pct: null };
    return { label, pct: ((latest - past) / past) * 100 };
  });
}
