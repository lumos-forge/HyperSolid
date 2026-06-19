// Raw shapes mirror @nktkas/hyperliquid responses we consume.
export interface RawAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}
export interface RawMeta {
  universe: RawAssetMeta[];
}
export interface RawAssetCtx {
  midPx: string;
  prevDayPx: string;
  funding: string;
  dayNtlVlm: string;
  openInterest: string;
}
export type MetaAndAssetCtxs = [RawMeta, RawAssetCtx[]];
export type Mids = Record<string, string>;

// Normalized model used throughout the app.
export interface MarketTicker {
  coin: string;
  midPx: number;
  prevDayPx: number;
  changePct: number;
  funding: number;
  dayNtlVlm: number;
  maxLeverage: number;
}

// Subscription handle returned by the SDK.
export interface Subscription {
  unsubscribe(): Promise<void>;
}

// Minimal client interfaces so services can be tested with fakes.
export interface InfoLike {
  metaAndAssetCtxs(): Promise<MetaAndAssetCtxs>;
}
export interface SubsLike {
  allMids(listener: (data: { mids: Mids }) => void): Promise<Subscription>;
}

// ---- Market Detail: raw shapes ----
export interface RawL2Level {
  px: string;
  sz: string;
  n: number;
}
export interface RawL2Book {
  coin: string;
  time: number;
  levels: [RawL2Level[], RawL2Level[]]; // [bids, asks]
}
export interface RawTrade {
  coin: string;
  side: string; // "B" (buy) | "A" (sell)
  px: string;
  sz: string;
  time: number;
  tid: number;
}
export interface RawCandle {
  t: number; // open time (ms)
  T: number; // close time (ms)
  s: string; // coin
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // volume
  n: number; // trade count
}

// ---- Market Detail: normalized model ----
export interface OrderbookLevel {
  px: number;
  sz: number;
  total: number; // cumulative size
}
export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  spreadPct: number;
}
export interface Trade {
  px: number;
  sz: number;
  side: "buy" | "sell";
  time: number;
  tid: number;
}
export interface Candle {
  t: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}
