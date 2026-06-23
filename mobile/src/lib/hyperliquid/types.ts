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
  /** 24h open interest (USD notional). Optional: absent for markets without a ctx. */
  openInterest?: number;
  maxLeverage: number;
  szDecimals: number;
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

// ---- Market Detail: injectable service interfaces ----
export interface DetailInfoLike {
  candleSnapshot(
    coin: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<RawCandle[]>;
}
export interface DetailSubsLike {
  l2Book(coin: string, listener: (book: RawL2Book) => void): Promise<Subscription>;
  trades(coin: string, listener: (trades: RawTrade[]) => void): Promise<Subscription>;
}

// ---- Positions: raw shapes (clearinghouseState) ----
export interface RawPosition {
  coin: string;
  szi: string; // signed size (negative = short)
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
  marginUsed: string;
  leverage: { type: string; value: number };
}
export interface RawClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  withdrawable: string;
  assetPositions: { position: RawPosition }[];
}

// ---- Positions: normalized model ----
export interface Position {
  coin: string;
  size: number; // absolute
  side: "long" | "short";
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
  marginUsed: number;
  leverage: number;
}
export interface AccountSummary {
  accountValue: number;
  totalNtlPos: number;
  totalMarginUsed: number;
  withdrawable: number;
  totalUnrealizedPnl: number;
}
export interface PortfolioSnapshot {
  summary: AccountSummary;
  positions: Position[];
}
export interface PositionsInfoLike {
  clearinghouseState(address: string): Promise<RawClearinghouseState>;
}

/** WS clearinghouseState event (replace-state; reconnect snapshots simply re-replace). */
export interface ClearinghouseStateEvent {
  clearinghouseState: RawClearinghouseState;
}
/** Injectable user-position subscription surface. clearinghouseState carries HL's authoritative
 *  MARK-based PnL (§4.5), so the live path consumes it directly (replace-state, snapshot-safe). */
export interface PositionsSubsLike {
  clearinghouseState(
    address: string,
    listener: (e: ClearinghouseStateEvent) => void,
  ): Promise<Subscription>;
}

/** Injectable fills (trade history) info surface. */
export interface FillsInfoLike {
  userFills(address: string): Promise<RawUserFill[]>;
  userFillsByTime(address: string, startTime: number, endTime: number): Promise<RawUserFill[]>;
}

/** Injectable open-orders info surface. */
export interface OrdersInfoLike {
  openOrders(address: string): Promise<RawOpenOrder[]>;
}

/**
 * HL order-status response (query by oid OR cloid) — `info.orderStatus`. Mirrors @nktkas
 * `OrderStatusResponse`: an `"order"` envelope (with an HL processing-status code) or `"unknownOid"`
 * when the exchange has no record (an orphan / unconfirmed intent).
 */
export type RawOrderStatus =
  | { status: "order"; order: { status: string; statusTimestamp?: number; order?: { oid?: number } } }
  | { status: "unknownOid" };

/** Injectable single-order status surface (startup reconciliation by cloid). */
export interface OrderStatusInfoLike {
  orderStatus(user: string, oidOrCloid: number | `0x${string}`): Promise<RawOrderStatus>;
}

/** Injectable funding-history info surface. */
export interface FundingsInfoLike {
  userFunding(address: string, startTime: number, endTime?: number): Promise<RawFunding[]>;
}

// ---- User history: raw shapes (mirror @nktkas/hyperliquid commonSchemas) ----
export interface RawUserFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A"; // B = buy, A = sell
  time: number;
  startPosition: string;
  dir: string; // frontend direction label, e.g. "Open Long"
  closedPnl: string;
  hash: `0x${string}`;
  oid: number;
  crossed: boolean;
  fee: string; // negative = rebate
  builderFee?: string;
  tid: number; // unique partial-fill id (dedup key)
  feeToken: string;
  twapId: number | null;
}
export interface RawFundingDelta {
  type: "funding";
  coin: string;
  usdc: string; // signed; negative = paid
  szi: string;
  fundingRate: string;
  nSamples: number | null;
}
export interface RawFunding {
  time: number;
  hash: `0x${string}`;
  delta: RawFundingDelta;
}
export interface RawOpenOrder {
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string; // remaining size
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: `0x${string}`;
  reduceOnly?: true;
}
export interface RawOrderUpdate {
  order: RawOpenOrder;
  status: string; // open/filled/canceled/triggered/rejected/marginCanceled/...
  statusTimestamp: number;
}

// ---- User history: normalized model ----
export interface Fill {
  coin: string;
  px: number;
  sz: number;
  side: "buy" | "sell";
  time: number;
  closedPnl: number;
  dir: string;
  fee: number;
  builderFee: number; // 0 when absent
  feeToken: string;
  oid: number;
  tid: number;
  hash: string;
  crossed: boolean;
}
export interface FundingEvent {
  coin: string;
  time: number;
  usdc: number; // signed; negative = paid
  szi: number;
  fundingRate: number;
  hash: string;
}
export interface OpenOrder {
  coin: string;
  side: "buy" | "sell";
  limitPx: number;
  sz: number;
  origSz: number;
  oid: number;
  timestamp: number;
  cloid: string | null;
  reduceOnly: boolean;
}
