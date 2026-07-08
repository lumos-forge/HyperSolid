export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";
export type StrategyStatus = "running" | "paused" | "completed" | "canceling";

export interface DcaParams {
  coin: string;
  side: "buy";
  quoteAmountUsdc: number;
  intervalHours: number;
  maxTotalUsdc?: number;
}
export interface TwapParams {
  coin: string;
  side: "buy" | "sell";
  totalUsdc: number;
  slices: number;
  durationHours: number;
}
export interface TpslParams {
  coin: string;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}
export interface GridParams {
  coin: string;
  lowerPrice: number;
  upperPrice: number;
  /** Number of grid lines (>= 2); steps = levels - 1. */
  levels: number;
  /** Notional (USDC) bought/sold per crossed grid line. */
  perLevelUsdc: number;
  /** longOnly (default): inventory-bounded long grid. symmetric: two-sided long/short grid. */
  mode?: "longOnly" | "symmetric";
}
export interface GridLimitParams {
  coin: string;
  lowerPrice: number;
  upperPrice: number;
  /** Number of grid lines (>= 2); rungs = levels - 1. */
  levels: number;
  /** Notional (USDC) rested as a buy per rung. */
  perLevelUsdc: number;
  /** longOnly (default): resting long grid. symmetric: two-sided long/short resting grid. */
  mode?: "longOnly" | "symmetric";
}
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams;

interface StrategyBase {
  id: string;
  owner: string;
  status: StrategyStatus;
  createdAt: number;
  nextRunAt?: number;
  filledTotalUsdc?: number;
  slicesDone?: number;
  triggeredAt?: number;
  /** Grid: the grid-line index the mark last occupied. */
  lastLevel?: number;
  /** Grid: monotonic count of executed grid actions (drives the cloid). */
  actionsDone?: number;
}

export type Strategy =
  | (StrategyBase & { kind: "dca"; params: DcaParams })
  | (StrategyBase & { kind: "twap"; params: TwapParams })
  | (StrategyBase & { kind: "tpsl"; params: TpslParams })
  | (StrategyBase & { kind: "grid"; params: GridParams })
  | (StrategyBase & { kind: "gridLimit"; params: GridLimitParams });
