import { IntentLedger } from "../hyperliquid/intentLedger";
import { SqliteIntentStore } from "./sqliteIntentStore";
import type { SqlDb } from "./sqlDb";

/** Ledger scope key — `address × network`, so switching wallet/network never mixes intents. */
export function scopeKey(address: string, network: string): string {
  return `${address.trim().toLowerCase()}:${network}`;
}

/** Default retention: keep terminal intents for 90 days, capped at 2000 rows per scope. */
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 2000;

export interface PersistentLedgerOptions {
  now?: number;
  maxAgeMs?: number;
  maxRows?: number;
  clock?: () => number;
  cloidFactory?: () => `0x${string}`;
}

/**
 * Build a persistent {@link IntentLedger} backed by SQLite for `address × network`:
 * hydrate the in-memory cache from disk, prune stale terminal intents, then return a ledger that
 * write-throughs to SQLite. The IntentLedger sync core is unchanged — only its IntentStore is swapped.
 */
export function createPersistentLedger(
  db: SqlDb,
  address: string,
  network: string,
  opts: PersistentLedgerOptions = {},
): IntentLedger {
  const store = new SqliteIntentStore(db, scopeKey(address, network));
  store.hydrate();
  store.prune(
    opts.now ?? Date.now(),
    opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    opts.maxRows ?? DEFAULT_MAX_ROWS,
  );
  return new IntentLedger(store, opts.clock, opts.cloidFactory);
}
