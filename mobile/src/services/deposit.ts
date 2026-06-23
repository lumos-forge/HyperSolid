import type { Network } from "../state/envStore";
import { bridgeConstants, usdcToBaseUnits } from "../lib/arbitrum/bridge";
import { validateDeposit } from "../lib/arbitrum/deposit";

/** Narrow injectable chain surface — lets us unit-test deposits with a fake (no real transfer). */
export interface ArbitrumDepositClient {
  transferUsdc(params: {
    usdc: `0x${string}`;
    bridge: `0x${string}`;
    amountBaseUnits: bigint;
  }): Promise<string>;
}

export type DepositResult =
  | { ok: true; txHash: string }
  | { ok: false; error: string; uncertain?: boolean };

/**
 * In-app Hyperliquid deposit (spec §B2b): an Arbitrum native-USDC transfer to the Bridge2 contract,
 * which credits the sender. Validation + the mainnet second-confirmation run BEFORE signing. A thrown
 * send is surfaced as uncertain (never assumed failed) — same honesty rule as orders/withdrawals.
 */
export class DepositService {
  constructor(private client: ArbitrumDepositClient, private network: Network) {}

  async depositUsdc(req: { amount: number; available?: number; confirmed?: boolean }): Promise<DepositResult> {
    const v = validateDeposit({ amount: req.amount, available: req.available });
    if (!v.ok) return { ok: false, error: v.error };
    if (this.network === "mainnet" && !req.confirmed) {
      return { ok: false, error: "请二次确认主网真实充值（不可逆）" };
    }
    const { usdc, bridge } = bridgeConstants(this.network);
    try {
      const txHash = await this.client.transferUsdc({
        usdc,
        bridge,
        amountBaseUnits: usdcToBaseUnits(req.amount),
      });
      return { ok: true, txHash };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), uncertain: true };
    }
  }
}
