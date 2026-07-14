/**
 * Canonical HL L1 action builder shared by the shadow verifier and the signer-backed exchange client.
 * The object returned here is msgpack-hashed (with a nonce) to produce exactly the digest the Go signer
 * signs, so the field ORDER and shape must stay identical to the signer's `Build*Action`
 * (backend/internal/hl/action.go). This is the single source of truth for that shape.
 */

/** Semantic params for a single limit `order` (mirrors the signer's ActionFromKind "order" case). */
export interface OrderParams {
  asset: number;
  isBuy: boolean;
  px: string;
  sz: string;
  reduceOnly: boolean;
  tif: string; // "Gtc" | "Ioc" | "Alo"
  grouping?: string; // default "na"
  cloid?: string;
  builder?: { b: `0x${string}`; f: number };
}

/** Semantic params for a `cancelByCloid` action. */
export interface CancelByCloidParams {
  cancels: Array<{ asset: number; cloid: string }>;
}

/** Semantic params for a `scheduleCancel` (dead-man switch) action. */
export interface ScheduleCancelParams {
  time?: number;
}

/**
 * Build the raw HL action object from a semantic kind + params. Returns undefined for kinds this engine
 * does not emit. Fields are emitted in HL byte order to match the signer's Go builders exactly.
 */
export function actionFromKindParams(kind: string, params: unknown): Record<string, unknown> | undefined {
  if (kind === "order") {
    const p = params as OrderParams;
    const o: Record<string, unknown> = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    const action: Record<string, unknown> = { type: "order", orders: [o], grouping: p.grouping ?? "na" };
    if (p.builder) action.builder = { b: p.builder.b, f: p.builder.f };
    return action;
  }
  if (kind === "cancelByCloid") {
    const p = params as CancelByCloidParams;
    return { type: "cancelByCloid", cancels: p.cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })) };
  }
  if (kind === "scheduleCancel") {
    const p = (params ?? {}) as ScheduleCancelParams;
    return p.time === undefined ? { type: "scheduleCancel" } : { type: "scheduleCancel", time: p.time };
  }
  return undefined;
}
