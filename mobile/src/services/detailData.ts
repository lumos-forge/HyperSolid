import type {
  Candle,
  DetailInfoLike,
  DetailSubsLike,
  Orderbook,
  Subscription,
  Trade,
} from "../lib/hyperliquid/types";
import { normalizeCandles, normalizeOrderbook, normalizeTrades } from "../lib/hyperliquid/detail";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export class DetailDataService {
  constructor(private info: DetailInfoLike, private subs: DetailSubsLike) {}

  async loadCandles(coin: string, interval = "1h", bars = 100, now = Date.now()): Promise<Candle[]> {
    const step = INTERVAL_MS[interval] ?? INTERVAL_MS["1h"];
    const start = now - step * bars;
    const raw = await this.info.candleSnapshot(coin, interval, start, now);
    return normalizeCandles(raw);
  }

  /** Daily closing prices, oldest→newest, for multi-period performance. */
  async loadDailyCloses(coin: string, days = 365, now = Date.now()): Promise<number[]> {
    const candles = await this.loadCandles(coin, "1d", days + 1, now);
    return candles.map((c) => c.close);
  }

  async subscribeOrderbook(coin: string, onBook: (ob: Orderbook) => void): Promise<Subscription> {
    return this.subs.l2Book(coin, (raw) => onBook(normalizeOrderbook(raw)));
  }

  async subscribeTrades(coin: string, onTrades: (trades: Trade[]) => void): Promise<Subscription> {
    return this.subs.trades(coin, (raw) => onTrades(normalizeTrades(raw)));
  }
}
