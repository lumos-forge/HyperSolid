import { useCallback, useEffect, useState } from "react";
import type { DetailDataService } from "../services/detailData";
import type { Candle, Orderbook, Trade } from "../lib/hyperliquid/types";
import { classifyFetchError, type FetchErrorCode } from "../lib/errorMessage";

export function useLiveDetail(service: DetailDataService, coin: string, interval = "1h") {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState<FetchErrorCode | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  useEffect(() => {
    let obSub: { unsubscribe(): Promise<void> } | null = null;
    let trSub: { unsubscribe(): Promise<void> } | null = null;
    let cancelled = false;

    setError(null);
    (async () => {
      try {
        const c = await service.loadCandles(coin, interval);
        if (cancelled) return;
        setCandles(c);
        obSub = await service.subscribeOrderbook(coin, setOrderbook);
        trSub = await service.subscribeTrades(coin, setTrades);
      } catch (e) {
        // Stable code (never the raw SDK string) so the screen can offer Retry.
        if (!cancelled) setError(classifyFetchError(e));
      }
    })();

    return () => {
      cancelled = true;
      obSub?.unsubscribe().catch(() => {});
      trSub?.unsubscribe().catch(() => {});
    };
  }, [service, coin, interval, retryNonce]);

  return { candles, orderbook, trades, error, retry };
}
