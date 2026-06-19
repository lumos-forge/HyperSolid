export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

export function formatSignedPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function formatFundingPct(funding: number): string {
  // funding is a per-hour rate fraction, e.g. 0.0000125 -> 0.0013%
  const sign = funding >= 0 ? "+" : "";
  return `${sign}${(funding * 100).toFixed(4)}%`;
}

export function formatTimeHMS(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => x.toString().padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
