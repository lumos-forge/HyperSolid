export interface RiskInput {
  notionalUsdc: number;
  killSwitch: boolean;
  coin?: string;
}
export interface RiskLimits {
  maxNotionalUsdc: number;
  /** Optional tighter per-coin notional cap; overrides the global cap for listed coins. */
  perCoinMaxNotionalUsdc?: Record<string, number>;
  /** Optional per-owner daily spend (notional) cap; enforced by the scheduler (needs spend state). */
  dailyMaxNotionalUsdc?: number;
  /** Optional per-owner open-order ceiling for NEW entries; undefined/<=0 = disabled (enforced by the scheduler). */
  maxOpenOrders?: number;
}

/**
 * Per-order risk gate: blocked entirely by the kill-switch, else capped by per-order notional. A coin
 * with a `perCoinMaxNotionalUsdc` entry uses that cap; otherwise it falls back to the global cap.
 */
export function withinCaps(input: RiskInput, limits: RiskLimits): { ok: boolean; reason?: string } {
  if (input.killSwitch) return { ok: false, reason: "kill-switch active" };
  const perCoin = input.coin !== undefined ? limits.perCoinMaxNotionalUsdc?.[input.coin] : undefined;
  const cap = perCoin ?? limits.maxNotionalUsdc;
  if (input.notionalUsdc > cap) {
    return { ok: false, reason: "over notional cap" };
  }
  return { ok: true };
}
