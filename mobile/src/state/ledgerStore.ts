import { create } from "zustand";
import type { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { SqlDb } from "../lib/storage/sqlDb";
import { createPersistentLedger, scopeKey } from "../lib/storage/persistentLedger";

/**
 * Holds the app's single long-lived persistent IntentLedger, scoped to the connected wallet ×
 * network. The App bootstrap calls `init(createSqlDb("..."), address, network)` when the wallet
 * connects; tests inject a fake SqlDb. This module does NOT import expo-sqlite (jest-safe).
 *
 * `revision` is bumped whenever the ledger reference OR its contents change. The IntentLedger
 * mutates its rows in place (its sync core is unchanged), so derived UI (e.g. the unconfirmed
 * banner) subscribes to `revision` to recompute `pending()` after submits/reconciles.
 */
interface LedgerState {
  ledger: IntentLedger | null;
  scope: string | null;
  revision: number;
  init(db: SqlDb, address: string, network: string): void;
  reset(): void;
  bump(): void;
}

export const useLedgerStore = create<LedgerState>((set) => ({
  ledger: null,
  scope: null,
  revision: 0,
  init: (db, address, network) =>
    set((s) => ({
      ledger: createPersistentLedger(db, address, network),
      scope: scopeKey(address, network),
      revision: s.revision + 1,
    })),
  reset: () => set((s) => ({ ledger: null, scope: null, revision: s.revision + 1 })),
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));
