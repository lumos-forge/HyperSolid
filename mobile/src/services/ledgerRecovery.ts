import type { IntentLedger } from "../lib/hyperliquid/intentLedger";
import { normalizeOrderStatus } from "../lib/hyperliquid/order";
import type { OrderStatusInfoLike } from "../lib/hyperliquid/types";
import { noopBreadcrumb, type Breadcrumb } from "../lib/observability/breadcrumb";

export interface RecoverySummary {
  checked: number;
  reconciled: number;
  orphans: number;
  errors: number;
}

/**
 * Startup recovery / reconciliation (spec §6.2). For every non-terminal (pending/submitted) intent,
 * ask HL for its status BY CLOID and reconcile the persisted ledger:
 * - found  -> reconcile to open/filled/rejected/canceled by the HL processing-status code.
 * - unknownOid (orphan) -> leave it `submitted` so the UI surfaces it as 未确认 for user review;
 *   we NEVER assume a fill or a failure on an order HL has no record of (§6.1 honesty).
 * Injected `info` + `breadcrumb` keep this testable and off the real network.
 */
export async function reconcilePendingIntents(
  ledger: IntentLedger,
  info: OrderStatusInfoLike,
  user: string,
  breadcrumb: Breadcrumb = noopBreadcrumb,
): Promise<RecoverySummary> {
  const pending = ledger.pending();
  let reconciled = 0;
  let orphans = 0;
  let errors = 0;

  for (const intent of pending) {
    try {
      const res = await info.orderStatus(user, intent.cloid);
      if (res.status === "unknownOid") {
        orphans += 1;
        breadcrumb("intent.orphan", { cloid: intent.cloid, coin: intent.coin });
        continue;
      }
      const normalized = normalizeOrderStatus(res.order.status);
      const oid = res.order.order?.oid;
      ledger.reconcile(intent.cloid, { ...normalized, oid: oid ?? normalized.oid });
      reconciled += 1;
      breadcrumb("intent.reconciled", {
        cloid: intent.cloid,
        code: res.order.status,
        kind: normalized.kind,
      });
    } catch (e) {
      errors += 1;
      breadcrumb("intent.reconcileError", {
        cloid: intent.cloid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const summary: RecoverySummary = { checked: pending.length, reconciled, orphans, errors };
  breadcrumb("intent.recoverySummary", { ...summary });
  return summary;
}
