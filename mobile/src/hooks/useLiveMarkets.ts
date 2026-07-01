import { useEffect } from "react";
import type { MarketDataService } from "../services/marketData";
import { useMarketStore } from "../state/marketStore";
import { classifyFetchError } from "../lib/errorMessage";
import type { Subscription } from "../lib/hyperliquid/types";

export function useLiveMarkets(service: MarketDataService) {
  const retryNonce = useMarketStore((s) => s.retryNonce);
  useEffect(() => {
    let sub: Subscription | null = null;
    let cancelled = false;

    (async () => {
      try {
        const tickers = await service.loadSnapshot();
        if (cancelled) return;
        useMarketStore.getState().setMarkets(tickers);
        sub = await service.subscribeMids((mids) => {
          useMarketStore.getState().mergeMids(mids);
        });
      } catch (e) {
        if (!cancelled) {
          // Never surface the raw SDK string; store a stable code so the UI can offer Retry.
          useMarketStore.getState().setError(classifyFetchError(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      sub?.unsubscribe().catch(() => {});
    };
  }, [service, retryNonce]);
}
