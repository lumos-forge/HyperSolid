import type { AssetIndex } from "../lib/hyperliquid/assetId";
import { buildOrder, type OrderRequest } from "../lib/hyperliquid/buildOrder";
import { rejectionMessage } from "../lib/hyperliquid/order";

/** Narrow injectable surface of @nktkas/hyperliquid ExchangeClient — lets us unit-test with a fake. */
export interface ExchangeLike {
  order(params: unknown): Promise<unknown>;
  cancel(params: { cancels: { a: number; o: number }[] }): Promise<unknown>;
  updateLeverage(params: { asset: number; isCross: boolean; leverage: number }): Promise<unknown>;
}

export type SubmitResult =
  | { ok: true; cloid: `0x${string}`; response: unknown }
  | { ok: false; error: string };

/**
 * Wraps the HL ExchangeClient. Enforces the order "三件套" via buildOrder before
 * signing/submitting, generates an idempotent cloid, and normalizes errors to
 * readable Chinese. EIP-712 signing is performed inside ExchangeClient using the
 * injected viem account.
 */
export class ExchangeService {
  constructor(private client: ExchangeLike, private index: AssetIndex) {}

  async placeOrder(req: OrderRequest): Promise<SubmitResult> {
    const built = buildOrder(req, this.index);
    if (!built.ok) {
      return { ok: false, error: rejectionMessage(built.rejection) };
    }
    try {
      const response = await this.client.order(built.params);
      const err = extractError(response);
      if (err) return { ok: false, error: rejectionMessage(err) };
      return { ok: true, cloid: built.cloid, response };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async cancelOrder(coin: string, oid: number): Promise<SubmitResult> {
    const asset = this.index.id(coin);
    if (asset === null) return { ok: false, error: rejectionMessage("unknownAsset") };
    try {
      const response = await this.client.cancel({ cancels: [{ a: asset, o: oid }] });
      const err = extractError(response);
      if (err) return { ok: false, error: rejectionMessage(err) };
      return { ok: true, cloid: "0x" as `0x${string}`, response };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async setLeverage(coin: string, leverage: number, isCross = true): Promise<SubmitResult> {
    const asset = this.index.id(coin);
    if (asset === null) return { ok: false, error: rejectionMessage("unknownAsset") };
    try {
      const response = await this.client.updateLeverage({ asset, isCross, leverage });
      return { ok: true, cloid: "0x" as `0x${string}`, response };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Pull an HL rejection/error string out of an order response, if any. */
function extractError(response: unknown): string | null {
  const r = response as {
    status?: string;
    response?: { data?: { statuses?: { error?: string }[] } };
  };
  if (r?.status && r.status !== "ok") return r.status;
  const statuses = r?.response?.data?.statuses;
  if (Array.isArray(statuses)) {
    for (const s of statuses) {
      if (s?.error) return s.error;
    }
  }
  return null;
}
