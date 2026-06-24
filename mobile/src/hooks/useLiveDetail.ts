import { useEffect, useState } from "react";
import type { DetailDataService } from "../services/detailData";
import type { Candle, Orderbook, Trade } from "../lib/hyperliquid/types";

export function useLiveDetail(service: DetailDataService, coin: string, interval = "1h") {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let obSub: { unsubscribe(): Promise<void> } | null = null;
    let trSub: { unsubscribe(): Promise<void> } | null = null;
    let cancelled = false;

    (async () => {
      try {
        const c = await service.loadCandles(coin, interval);
        if (cancelled) return;
        setCandles(c);
        obSub = await service.subscribeOrderbook(coin, setOrderbook);
        trSub = await service.subscribeTrades(coin, setTrades);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      obSub?.unsubscribe().catch(() => {});
      trSub?.unsubscribe().catch(() => {});
    };
  }, [service, coin, interval]);

  return { candles, orderbook, trades, error };
}
