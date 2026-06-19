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
