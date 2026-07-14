import type { AssetIndex } from "../lib/hyperliquid/assetId";
import {
  buildOrder,
  buildBracketOrder,
  buildScaleOrder,
  buildTwap,
  type OrderRequest,
  type OrderSide,
  type BracketRequest,
  type ScaleRequest,
  type TwapRequest,
  type TwapParams,
  type HlOrderParams,
} from "../lib/hyperliquid/buildOrder";
import {
  buildCancel,
  buildCancelByCloid,
  buildTwapCancel,
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
  twapOrder(params: TwapParams): Promise<unknown>;
  twapCancel(params: { a: number; t: number }): Promise<unknown>;
  cancel(params: { cancels: { a: number; o: number }[] }): Promise<unknown>;
  cancelByCloid(params: { cancels: { asset: number; cloid: `0x${string}` }[] }): Promise<unknown>;
  modify(params: { oid: number | `0x${string}`; order: unknown }): Promise<unknown>;
  updateLeverage(params: { asset: number; isCross: boolean; leverage: number }): Promise<unknown>;
  withdraw3(params: { destination: string; amount: string }): Promise<unknown>;
  approveAgent(params: { agentAddress: string; agentName?: string | null }): Promise<unknown>;
  approveBuilderFee(params: { maxFeeRate: `${string}%`; builder: `0x${string}` }): Promise<unknown>;
  scheduleCancel(params: { time?: number }): Promise<unknown>;
}

/** Server-delivered builder config plus a live approval predicate; the service attaches the builder
 *  only while approved (an unapproved user must not send a builder HL would reject). */
export interface BuilderAttach {
  address: `0x${string}`;
  feeTenthBps: number;
  isApproved: () => boolean;
}

export type SubmitResult =
  | { ok: true; cloid: `0x${string}`; response?: unknown; status?: NormalizedStatus }
  | { ok: false; error: string; cloid?: `0x${string}`; uncertain?: boolean };

/** Result of a withdrawal request. Like orders, an uncertain receipt is never treated as success. */
export type WithdrawResult =
  | { ok: true; response?: unknown }
  | { ok: false; error: string; uncertain?: boolean };

/** Result of a TWAP order. No cloid (TWAP carries none); uncertain receipt is never assumed ok. */
export type TwapResult =
  | { ok: true; response?: unknown }
  | { ok: false; error: string; uncertain?: boolean };

/** Result of approving a trade-only agent wallet (Phase C). Uncertain receipt is never assumed ok. */
export type ApproveAgentResult =
  | { ok: true; response?: unknown }
  | { ok: false; error: string; uncertain?: boolean };

/** Result of approving the builder fee (main wallet signs). Uncertain receipt is never assumed ok. */
export type ApproveBuilderFeeResult =
  | { ok: true; response?: unknown }
  | { ok: false; error: string; uncertain?: boolean };

/** Result of arming/clearing the dead-man scheduleCancel. Uncertain receipt is never assumed ok. */
export type ScheduleCancelResult =
  | { ok: true; response?: unknown }
  | { ok: false; error: string; uncertain?: boolean };

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
    private builder?: BuilderAttach,
  ) {}

  /** The builder to attach right now, or undefined when unset/unapproved. */
  private builderAttach(): { address: `0x${string}`; feeTenthBps: number } | undefined {
    return this.builder && this.builder.isApproved()
      ? { address: this.builder.address, feeTenthBps: this.builder.feeTenthBps }
      : undefined;
  }

  async placeOrder(req: OrderRequest): Promise<SubmitResult> {
    const built = buildOrder({ ...req, builder: req.builder ?? this.builderAttach() }, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    return this.submitBuilt(built.params, built.cloid, {
      coin: req.coin,
      side: req.side,
      size: req.size,
      price: req.price,
    });
  }

  /**
   * Submit an entry order together with optional take-profit / stop-loss legs (spec §4.3 bracket).
   * Reuses the exact idempotency pipeline as `placeOrder` (persist cloid pending BEFORE signing,
   * dedupe, reconcile, uncertain-receipt retry) via `buildBracketOrder` — no real order at test time.
   */
  async placeBracket(req: BracketRequest): Promise<SubmitResult> {
    const entry = { ...req.entry, builder: req.entry.builder ?? this.builderAttach() };
    const built = buildBracketOrder({ ...req, entry }, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    return this.submitBuilt(built.params, built.cloid, {
      coin: entry.coin,
      side: entry.side,
      size: entry.size,
      price: entry.price,
    });
  }

  /** Scale (laddered) order — N limit orders across a price range, one signed `order` action. */
  async placeScale(req: ScaleRequest): Promise<SubmitResult> {
    const built = buildScaleOrder({ ...req, builder: req.builder ?? this.builderAttach() }, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    return this.submitBuilt(built.params, built.cloid, {
      coin: req.coin,
      side: req.side,
      size: req.totalSize,
      price: req.startPx,
    });
  }

  /**
   * TWAP order (native HL `twapOrder`): fill `size` at market over `minutes`. TWAP carries no client
   * order id, so there is no cloid dedupe — an uncertain receipt is reported (never assumed ok).
   */
  async placeTwap(req: TwapRequest): Promise<TwapResult> {
    const built = buildTwap(req, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    try {
      const response = await this.client.twapOrder(built.params);
      return { ok: true, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
    }
  }

  /**
   * Shared submit pipeline for single + bracket orders: persist the (pending) cloid BEFORE signing,
   * dedupe by cloid (never double-submit a live/settled intent), submit, normalize + reconcile the
   * HL status, and surface uncertain (network/timeout) receipts so the caller can safely retry the
   * SAME cloid instead of orphaning a duplicate (§6.1/§6.2).
   */
  private async submitBuilt(
    params: HlOrderParams,
    cloid: `0x${string}`,
    open: { coin: string; side: OrderSide; size: number; price: number },
  ): Promise<SubmitResult> {
    this.ledger.open({ ...open, cloid });

    if (!this.ledger.shouldSubmit(cloid)) {
      const intent = this.ledger.get(cloid);
      if (intent && (intent.status === "rejected" || intent.status === "canceled")) {
        return { ok: false, error: intent.reason ?? rejectionMessage(intent.status), cloid };
      }
      return { ok: true, cloid };
    }

    this.ledger.markSubmitted(cloid);
    try {
      const response = await this.client.order(params);
      const status = normalizeOrderStatus(firstOrderStatus(response));
      this.ledger.reconcile(cloid, status);
      if (status.kind === "rejected") return { ok: false, error: status.message, cloid };
      return { ok: true, cloid, response, status };
    } catch (e) {
      // Uncertain receipt (network/timeout): the order may or may not have reached HL. We keep the
      // intent `submitted` (already markSubmitted) and never assume rejection (§6.1). The caller
      // offers an explicit retry that REUSES this cloid, so HL dedupes instead of orphaning a dup.
      return { ok: false, error: errorMessage(e), cloid, uncertain: true };
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

  /** Cancel a running TWAP by its id. No cloid (TWAP carries none); an uncertain receipt is never
   * treated as a successful cancel. */
  async cancelTwap(coin: string, twapId: number): Promise<SubmitResult> {
    const built = buildTwapCancel(coin, twapId, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    try {
      const response = await this.client.twapCancel(built.params);
      const err = responseError(response);
      if (err) return { ok: false, error: rejectionMessage(err) };
      return { ok: true, cloid: NO_CLOID, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
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

  /**
   * Withdraw USDC from Hyperliquid to `destination` (spec §B1). Validation runs BEFORE any signing
   * so an invalid/over-balance request never hits the network. A thrown (network/timeout) receipt is
   * surfaced as uncertain — never assumed to have failed — mirroring the order-submit honesty rule.
   */
  async withdrawUsdc(req: { destination: string; amount: number; withdrawable: number; fee?: number }): Promise<WithdrawResult> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.destination)) {
      return { ok: false, error: "目标地址无效（需 0x + 40 位十六进制）" };
    }
    if (!(req.amount > 0)) return { ok: false, error: "提现金额需大于 0" };
    // The venue deducts a flat fee from the amount; a withdrawal at or below the fee nets nothing yet
    // still debits the account, so reject it before signing.
    if (req.fee != null && req.amount <= req.fee) {
      return { ok: false, error: `提现金额需高于手续费 ${req.fee} USDC` };
    }
    if (req.amount > req.withdrawable) return { ok: false, error: "提现金额超过可提现余额" };
    try {
      const response = await this.client.withdraw3({
        destination: req.destination,
        amount: String(req.amount),
      });
      return { ok: true, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
    }
  }

  /**
   * Approve a trade-only agent wallet (Phase C, spec): signs HL `approveAgent` with the user's
   * on-device main key, authorizing `agentAddress` to TRADE on their behalf (it can never withdraw).
   * Validation runs before signing; a thrown receipt is uncertain, never assumed failed. No funds move.
   */
  async approveAgent(req: { agentAddress: string; agentName?: string }): Promise<ApproveAgentResult> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.agentAddress)) {
      return { ok: false, error: "代理地址无效（需 0x + 40 位十六进制）" };
    }
    try {
      const response = await this.client.approveAgent({
        agentAddress: req.agentAddress,
        agentName: req.agentName ?? null,
      });
      return { ok: true, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
    }
  }

  /**
   * Approve a builder to charge up to `maxFeeRate` (main-wallet signed). Idempotent (re-approving is
   * safe). A thrown receipt is uncertain — never assumed ok — mirroring approveAgent/order honesty.
   */
  async approveBuilderFee(maxFeeRate: `${string}%`, builder: `0x${string}`): Promise<ApproveBuilderFeeResult> {
    try {
      const response = await this.client.approveBuilderFee({ maxFeeRate, builder });
      return { ok: true, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
    }
  }

  /**
   * Arm (with `time`) or clear (omit `time`) the account's HL scheduleCancel — the manual dead-man.
   * Signed by the local wallet. A thrown receipt is uncertain (never assumed ok), so the caller retries.
   */
  async scheduleCancel(time?: number): Promise<ScheduleCancelResult> {
    try {
      const response = await this.client.scheduleCancel(time === undefined ? {} : { time });
      return { ok: true, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
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
