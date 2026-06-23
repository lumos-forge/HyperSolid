/** Hyperliquid bridge minimum deposit. Below this the bridge does NOT credit and funds are lost. */
export const MIN_DEPOSIT_USDC = 5;

export type DepositValidation = { ok: true } | { ok: false; error: string };

/**
 * Pure, chain-independent deposit-amount check (spec §B2b). Address/RPC-free so it is safe to land
 * before the bridge constants are verified. Enforces positivity, the 5 USDC bridge minimum, and the
 * wallet's available USDC when known.
 */
export function validateDeposit(req: { amount: number; available?: number }): DepositValidation {
  if (!(req.amount > 0)) return { ok: false, error: "充值金额需大于 0" };
  if (req.amount < MIN_DEPOSIT_USDC) {
    return { ok: false, error: `最低充值 ${MIN_DEPOSIT_USDC} USDC（少于将丢失，无法入账）` };
  }
  if (req.available != null && req.amount > req.available) {
    return { ok: false, error: "充值金额超过钱包 USDC 余额" };
  }
  return { ok: true };
}
