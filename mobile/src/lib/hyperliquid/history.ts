import type {
  Fill,
  FundingEvent,
  OpenOrder,
  RawFunding,
  RawOpenOrder,
  RawOrderUpdate,
  RawUserFill,
} from "./types";
import { normalizeOrderStatus, type OrderStatusKind } from "./order";
import type { IntentStatus } from "./intentLedger";

/** HL order side encoding: "B" = bid/buy, "A" = ask/sell. */
function sideFromBA(side: "B" | "A"): "buy" | "sell" {
  return side === "B" ? "buy" : "sell";
}

/** Normalize userFills, de-duplicating by `tid` (partial-fill id), newest first. */
export function normalizeFills(raw: RawUserFill[]): Fill[] {
  const seen = new Set<number>();
  const out: Fill[] = [];
  for (const f of raw) {
    if (seen.has(f.tid)) continue;
    seen.add(f.tid);
    out.push({
      coin: f.coin,
      px: Number(f.px),
      sz: Number(f.sz),
      side: sideFromBA(f.side),
      time: f.time,
      closedPnl: Number(f.closedPnl),
      dir: f.dir,
      fee: Number(f.fee),
      builderFee: f.builderFee !== undefined ? Number(f.builderFee) : 0,
      feeToken: f.feeToken,
      oid: f.oid,
      tid: f.tid,
      hash: f.hash,
      crossed: f.crossed,
    });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** Merge fill pages, de-duplicating by `tid`, newest first (pagination). */
export function mergeFills(existing: Fill[], incoming: Fill[]): Fill[] {
  const seen = new Set(existing.map((f) => f.tid));
  const merged = [...existing];
  for (const f of incoming) {
    if (seen.has(f.tid)) continue;
    seen.add(f.tid);
    merged.push(f);
  }
  return merged.sort((a, b) => b.time - a.time);
}

/** Normalize userFundings (flatten the `delta`), newest first. usdc is signed (negative = paid). */
export function normalizeFundings(raw: RawFunding[]): FundingEvent[] {
  return raw
    .map((r) => ({
      coin: r.delta.coin,
      time: r.time,
      usdc: Number(r.delta.usdc),
      szi: Number(r.delta.szi),
      fundingRate: Number(r.delta.fundingRate),
      hash: r.hash,
    }))
    .sort((a, b) => b.time - a.time);
}

/** Normalize openOrders, de-duplicating by `oid`. */
export function normalizeOpenOrders(raw: RawOpenOrder[]): OpenOrder[] {
  const seen = new Set<number>();
  const out: OpenOrder[] = [];
  for (const o of raw) {
    if (seen.has(o.oid)) continue;
    seen.add(o.oid);
    out.push({
      coin: o.coin,
      side: sideFromBA(o.side),
      limitPx: Number(o.limitPx),
      sz: Number(o.sz),
      origSz: Number(o.origSz),
      oid: o.oid,
      timestamp: o.timestamp,
      cloid: o.cloid ?? null,
      reduceOnly: o.reduceOnly === true,
    });
  }
  return out;
}

/** Normalized orderUpdates event: order + raw status + statusTimestamp + status normalization (§4.4). */
export interface OrderUpdate {
  order: OpenOrder;
  status: string;
  statusTimestamp: number;
  kind: OrderStatusKind;
  message: string;
}

/** Normalize orderUpdates, reusing normalizeOrderStatus (Phase 3) for the status -> {kind, message}. */
export function normalizeOrderUpdates(raw: RawOrderUpdate[]): OrderUpdate[] {
  return raw.map((u) => {
    const [order] = normalizeOpenOrders([u.order]);
    const ns = normalizeOrderStatus(u.status);
    return {
      order,
      status: u.status,
      statusTimestamp: u.statusTimestamp,
      kind: ns.kind,
      message: ns.message,
    };
  });
}

/** An open order annotated with whether a local intent (Phase 3 cloid ledger) tracks it. */
export interface TrackedOpenOrder extends OpenOrder {
  tracked: boolean;
  intentStatus: IntentStatus | null;
}

/** Minimal read-only view of the intent ledger (we never write to it from Phase 4). */
export interface IntentLookup {
  get(cloid: string): { status: IntentStatus } | undefined;
}

/** Reconcile open orders against the cloid ledger — READ-ONLY (no ledger writes). */
export function reconcileOpenOrders(orders: OpenOrder[], ledger: IntentLookup): TrackedOpenOrder[] {
  return orders.map((o) => {
    const intent = o.cloid ? ledger.get(o.cloid) : undefined;
    return { ...o, tracked: !!intent, intentStatus: intent?.status ?? null };
  });
}
