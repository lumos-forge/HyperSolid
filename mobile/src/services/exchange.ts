import type { AssetIndex } from "../lib/hyperliquid/assetId";
import { buildOrder, type OrderRequest } from "../lib/hyperliquid/buildOrder";
import {
  buildCancel,
  buildCancelByCloid,
  buildModify,
  type ModifyTarget,
} from "../lib/hyperliquid/cancel";
import {
  normalizeOrderStatus,
  rejectionMessage,
  type NormalizedStatus,
} from "../lib/hyperliquid/order";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";

/** Narrow injectable surface of @nktkas/hyperliquid ExchangeClient — lets us unit-test with a fake. */
export interface ExchangeLike {
  order(params: unknown): Promise<unknown>;
  cancel(params: { cancels: { a: number; o: number }[] }): Promise<unknown>;
  cancelByCloid(params: { cancels: { asset: number; cloid: `0x${string}` }[] }): Promise<unknown>;
  modify(params: { oid: number | `0x${string}`; order: unknown }): Promise<unknown>;
  updateLeverage(params: { asset: number; isCross: boolean; leverage: number }): Promise<unknown>;
}

export type SubmitResult =
  | { ok: true; cloid: `0x${string}`; response?: unknown; status?: NormalizedStatus }
  | { ok: false; error: string; cloid?: `0x${string}` };

/** Placeholder for actions that don't carry a client order id (cancel-by-oid, leverage). */
const NO_CLOID = "0x" as `0x${string}`;

/**
 * Wraps the HL ExchangeClient. Orchestrates the order correctness pipeline before/after signing:
 * precision/asset/builder validation (buildOrder) -> persist cloid (pending) in the intent ledger
 * BEFORE signing -> submit -> normalize the HL status -> reconcile by cloid. Errors normalize to
 * readable Chinese. All collaborators (client/index/ledger) are injectable; tests never touch the
 * network and never place real orders. EIP-712 signing happens inside ExchangeClient.
 */
export class ExchangeService {
  constructor(
    private client: ExchangeLike,
    private index: AssetIndex,
    private ledger: IntentLedger = new IntentLedger(),
  ) {}

  async placeOrder(req: OrderRequest): Promise<SubmitResult> {
    const built = buildOrder(req, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };

    const cloid = built.cloid;
    // §6.2: persist the intent (pending) BEFORE signing; retries reuse the same cloid.
    this.ledger.open({ coin: req.coin, side: req.side, size: req.size, price: req.price, cloid });

    // Dedupe: never double-submit a cloid that is already live or settled.
    if (!this.ledger.shouldSubmit(cloid)) {
      const intent = this.ledger.get(cloid);
      if (intent && (intent.status === "rejected" || intent.status === "canceled")) {
        return { ok: false, error: intent.reason ?? rejectionMessage(intent.status), cloid };
      }
      return { ok: true, cloid };
    }

    this.ledger.markSubmitted(cloid);
    try {
      const response = await this.client.order(built.params);
      const status = normalizeOrderStatus(firstOrderStatus(response));
      this.ledger.reconcile(cloid, status);
      if (status.kind === "rejected") return { ok: false, error: status.message, cloid };
      return { ok: true, cloid, response, status };
    } catch (e) {
      return { ok: false, error: errorMessage(e), cloid };
    }
  }

  async cancelOrder(coin: string, oid: number): Promise<SubmitResult> {
    const built = buildCancel(coin, oid, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    try {
      const response = await this.client.cancel(built.params);
      const err = responseError(response);
      if (err) return { ok: false, error: rejectionMessage(err) };
      const intent = this.ledger.getByOid(oid);
      if (intent) this.ledger.markCanceled(intent.cloid);
      return { ok: true, cloid: intent?.cloid ?? NO_CLOID, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  async cancelOrderByCloid(coin: string, cloid: `0x${string}`): Promise<SubmitResult> {
    const built = buildCancelByCloid(coin, cloid, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection), cloid };
    try {
      const response = await this.client.cancelByCloid(built.params);
      const err = responseError(response);
      if (err) return { ok: false, error: rejectionMessage(err), cloid };
      this.ledger.markCanceled(cloid);
      return { ok: true, cloid, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), cloid };
    }
  }

  async modifyOrder(target: ModifyTarget, req: OrderRequest): Promise<SubmitResult> {
    const built = buildModify(target, req, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };

    const cloid = built.cloid;
    this.ledger.open({ coin: req.coin, side: req.side, size: req.size, price: req.price, cloid });
    this.ledger.markSubmitted(cloid);
    try {
      const response = await this.client.modify(built.params);
      const status = normalizeOrderStatus(firstOrderStatus(response));
      this.ledger.reconcile(cloid, status);
      if (status.kind === "rejected") return { ok: false, error: status.message, cloid };
      return { ok: true, cloid, response, status };
    } catch (e) {
      return { ok: false, error: errorMessage(e), cloid };
    }
  }

  async setLeverage(coin: string, leverage: number, isCross = true): Promise<SubmitResult> {
    const asset = this.index.id(coin);
    if (asset === null) return { ok: false, error: rejectionMessage("unknownAsset") };
    try {
      const response = await this.client.updateLeverage({ asset, isCross, leverage });
      return { ok: true, cloid: NO_CLOID, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The first per-order status from an HL order/modify response (or a top-level failure string). */
function firstOrderStatus(response: unknown): unknown {
  const r = response as { status?: string; response?: { data?: { statuses?: unknown[] } } };
  if (r?.status && r.status !== "ok") return r.status;
  const statuses = r?.response?.data?.statuses;
  if (Array.isArray(statuses) && statuses.length > 0) return statuses[0];
  return undefined;
}

/** Pull an HL rejection/error string out of a cancel/modify response, if any. */
function responseError(response: unknown): string | null {
  const r = response as { status?: string; response?: { data?: { statuses?: unknown[] } } };
  if (r?.status && r.status !== "ok") return r.status;
  const statuses = r?.response?.data?.statuses;
  if (Array.isArray(statuses)) {
    for (const s of statuses) {
      const err = (s as { error?: string })?.error;
      if (typeof err === "string") return err;
    }
  }
  return null;
}
