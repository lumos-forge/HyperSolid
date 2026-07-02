export type StrategyKind = "dca" | "twap" | "tpsl";
export type StrategyStatus = "running" | "paused" | "completed";

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
export type StrategyParams = DcaParams | TwapParams | TpslParams;

interface StrategyBase {
  id: string;
  owner: string;
  status: StrategyStatus;
  createdAt: number;
  nextRunAt?: number;
  filledTotalUsdc?: number;
  slicesDone?: number;
  triggeredAt?: number;
}

export type Strategy =
  | (StrategyBase & { kind: "dca"; params: DcaParams })
  | (StrategyBase & { kind: "twap"; params: TwapParams })
  | (StrategyBase & { kind: "tpsl"; params: TpslParams });
