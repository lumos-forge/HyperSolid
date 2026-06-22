import type { AssetIndex } from "./assetId";
import {
  buildOrder,
  type BuildResult,
  type HlOrderTuple,
  type OrderRequest,
} from "./buildOrder";

/** cancel action: cancels[{ a, o }] — asset id + order id. */
export interface HlCancelParams {
  cancels: { a: number; o: number }[];
}

/**
 * cancelByCloid action: cancels[{ asset, cloid }].
 * GOTCHA (spec §4.3): the field name is `asset`, NOT `a` — otherwise the hash mismatches.
 */
export interface HlCancelByCloidParams {
  cancels: { asset: number; cloid: `0x${string}` }[];
}

/** modify action: { oid, order } where oid is an order id or a cloid. */
export type ModifyTarget = number | `0x${string}`;
export interface HlModifyParams {
  oid: ModifyTarget;
  order: HlOrderTuple;
}

export type CancelResult =
  | { ok: true; params: HlCancelParams }
  | { ok: false; rejection: "unknownAsset" };

export type CancelByCloidResult =
  | { ok: true; params: HlCancelByCloidParams }
  | { ok: false; rejection: "unknownAsset" };

export type ModifyResult =
  | { ok: true; params: HlModifyParams; cloid: `0x${string}` }
  | { ok: false; rejection: Extract<BuildResult, { ok: false }>["rejection"] };

/** Build a cancel-by-oid action with the resolved asset id. */
export function buildCancel(coin: string, oid: number, index: AssetIndex): CancelResult {
  const asset = index.id(coin);
  if (asset === null) return { ok: false, rejection: "unknownAsset" };
  return { ok: true, params: { cancels: [{ a: asset, o: oid }] } };
}

/** Build a cancel-by-cloid action. Uses the `asset` field name (NOT `a`) per HL gotcha. */
export function buildCancelByCloid(
  coin: string,
  cloid: `0x${string}`,
  index: AssetIndex,
): CancelByCloidResult {
  const asset = index.id(coin);
  if (asset === null) return { ok: false, rejection: "unknownAsset" };
  return { ok: true, params: { cancels: [{ asset, cloid }] } };
}

/**
 * Build a modify action `{ oid, order }`. Reuses buildOrder for the new order tuple so
 * precision / min-notional / builder-cap validation stays DRY. `target` is an oid or cloid.
 */
export function buildModify(
  target: ModifyTarget,
  req: OrderRequest,
  index: AssetIndex,
): ModifyResult {
  const built = buildOrder(req, index);
  if (!built.ok) return built;
  return { ok: true, params: { oid: target, order: built.params.orders[0] }, cloid: built.cloid };
}
