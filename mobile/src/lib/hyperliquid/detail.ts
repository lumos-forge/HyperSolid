import type {
  RawL2Book,
  RawL2Level,
  RawTrade,
  RawCandle,
  Orderbook,
  OrderbookLevel,
  Trade,
  Candle,
} from "./types";

function cumulative(levels: RawL2Level[], depth: number): OrderbookLevel[] {
  let running = 0;
  return levels.slice(0, depth).map((l) => {
    const sz = Number(l.sz);
    running += sz;
    return { px: Number(l.px), sz, total: running };
  });
}

export function normalizeOrderbook(raw: RawL2Book, depth = 20): Orderbook {
  const bids = cumulative(raw.levels[0] ?? [], depth);
  const asks = cumulative(raw.levels[1] ?? [], depth);
  const bestBid = bids[0]?.px ?? 0;
  const bestAsk = asks[0]?.px ?? 0;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;
  const mid = bestBid && bestAsk ? (bestAsk + bestBid) / 2 : 0;
  const spreadPct = mid ? (spread / mid) * 100 : 0;
  return { bids, asks, spread, spreadPct };
}

export function normalizeTrades(raw: RawTrade[]): Trade[] {
  return raw.map((t) => ({
    px: Number(t.px),
    sz: Number(t.sz),
    side: t.side === "B" ? "buy" : "sell",
    time: t.time,
    tid: t.tid,
  }));
}

export function normalizeCandles(raw: RawCandle[]): Candle[] {
  return raw.map((c) => ({
    t: c.t,
    open: Number(c.o),
    close: Number(c.c),
    high: Number(c.h),
    low: Number(c.l),
    volume: Number(c.v),
  }));
}
