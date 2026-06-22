import { create } from "zustand";
import type { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { SqlDb } from "../lib/storage/sqlDb";
import { createPersistentLedger, scopeKey } from "../lib/storage/persistentLedger";

/**
 * Holds the app's single long-lived persistent IntentLedger, scoped to the connected wallet ×
 * network. The App bootstrap calls `init(createSqlDb("..."), address, network)` when the wallet
 * connects; tests inject a fake SqlDb. This module does NOT import expo-sqlite (jest-safe).
 */
interface LedgerState {
  ledger: IntentLedger | null;
  scope: string | null;
  init(db: SqlDb, address: string, network: string): void;
  reset(): void;
}

export const useLedgerStore = create<LedgerState>((set) => ({
  ledger: null,
  scope: null,
  init: (db, address, network) =>
    set({
      ledger: createPersistentLedger(db, address, network),
      scope: scopeKey(address, network),
    }),
  reset: () => set({ ledger: null, scope: null }),
}));
