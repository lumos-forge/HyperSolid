import { create } from "zustand";
import type { AssetIndex } from "../lib/hyperliquid/assetId";
import type { IntentLedger } from "../lib/hyperliquid/intentLedger";
import { ExchangeService, type ExchangeLike, type BuilderAttach } from "../services/exchange";

/**
 * Holds the app's single long-lived {@link ExchangeService}. The service is a thin orchestrator;
 * the durable state lives in the persistent {@link IntentLedger} (from `ledgerStore`) injected here.
 * Re-`init` on client/index changes reuses the SAME ledger, so cloid dedup survives across submits
 * (fixes the Phase 3 bug where TradeScreen new'd a fresh in-memory ledger per submit).
 */
interface ExchangeState {
  service: ExchangeService | null;
  init(client: ExchangeLike, index: AssetIndex, ledger?: IntentLedger, builder?: BuilderAttach): void;
  reset(): void;
}

export const useExchangeStore = create<ExchangeState>((set) => ({
  service: null,
  init: (client, index, ledger, builder) => set({ service: new ExchangeService(client, index, ledger, builder) }),
  reset: () => set({ service: null }),
}));
