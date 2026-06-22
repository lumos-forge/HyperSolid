import { useMemo } from "react";
import { useLedgerStore } from "../state/ledgerStore";
import type { OrderIntent } from "../lib/hyperliquid/intentLedger";

/**
 * Reactive view of the persistent ledger's non-terminal (pending/submitted) intents — the
 * "unconfirmed" set surfaced to the user (§6.1). Recomputes when the ledger is (re)scoped or its
 * contents change (`revision` bump after a submit/reconcile/recovery).
 */
export function useUnconfirmedIntents(): { count: number; intents: OrderIntent[] } {
  const ledger = useLedgerStore((s) => s.ledger);
  const revision = useLedgerStore((s) => s.revision);
  return useMemo(() => {
    const intents = ledger ? ledger.pending() : [];
    return { count: intents.length, intents };
  }, [ledger, revision]);
}
