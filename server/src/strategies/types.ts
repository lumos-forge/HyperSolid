export type StrategyKind = "dca" | "twap" | "tpsl" | "grid" | "gridLimit" | "trailing" | "conditional";
export type StrategyStatus = "running" | "paused" | "completed" | "canceling";

/** Fields common to every strategy's params. */
export interface StrategyParamsCommon {
  /** Opt-in: while this strategy runs, arm the account-level scheduleCancel dead-man switch. */
  deadMan?: boolean;
}

export interface DcaParams extends StrategyParamsCommon {
  coin: string;
  side: "buy";
  quoteAmountUsdc: number;
  intervalHours: number;
  maxTotalUsdc?: number;
}
export interface TwapParams extends StrategyParamsCommon {
  coin: string;
  side: "buy" | "sell";
  totalUsdc: number;
  slices: number;
  durationHours: number;
}
export interface TpslParams extends StrategyParamsCommon {
  coin: string;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}
export interface TrailingParams extends StrategyParamsCommon {
  coin: string;
  /** Callback rate: retrace percent from the favorable extreme that triggers the close. 0 < trailPct < 100. */
  trailPct: number;
}
export interface ConditionalParams extends StrategyParamsCommon {
  coin: string;
  side: "buy" | "sell";
  /** Notional (USDC) to open at market when the trigger fires. */
  sizeUsdc: number;
  triggerPrice: number;
  /** "above": fire when mark >= triggerPrice (breakout). "below": fire when mark <= triggerPrice (dip). */
  triggerDirection: "above" | "below";
}
export interface GridParams extends StrategyParamsCommon {
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
export interface GridLimitParams extends StrategyParamsCommon {
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
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams | TrailingParams | ConditionalParams;

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
  /** Trailing stop: the persisted favorable mark extreme (peak for long, trough for short). */
  trailPeak?: number;
}

export type Strategy =
  | (StrategyBase & { kind: "dca"; params: DcaParams })
  | (StrategyBase & { kind: "twap"; params: TwapParams })
  | (StrategyBase & { kind: "tpsl"; params: TpslParams })
  | (StrategyBase & { kind: "grid"; params: GridParams })
  | (StrategyBase & { kind: "gridLimit"; params: GridLimitParams })
  | (StrategyBase & { kind: "trailing"; params: TrailingParams })
  | (StrategyBase & { kind: "conditional"; params: ConditionalParams });
