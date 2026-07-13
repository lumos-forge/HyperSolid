import type { StrategyKind, StrategyParams, DcaParams, TwapParams, TpslParams, GridParams, GridLimitParams, TrailingParams } from "./types";

type Result = { ok: true; params: StrategyParams } | { ok: false; error: string };

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function validateParams(kind: StrategyKind, params: unknown): Result {
  const p = (params ?? {}) as Record<string, unknown>;
  const coin = p.coin;
  if (typeof coin !== "string" || coin.length === 0) return { ok: false, error: "coin required" };
  if (p.deadMan !== undefined && typeof p.deadMan !== "boolean") return { ok: false, error: "deadMan must be a boolean" };
  const deadMan = p.deadMan === true;

  if (kind === "dca") {
    const d = p as unknown as DcaParams;
    if (d.side !== "buy") return { ok: false, error: "dca side must be buy" };
    if (!positiveNumber(d.quoteAmountUsdc)) return { ok: false, error: "quoteAmountUsdc must be > 0" };
    if (!positiveNumber(d.intervalHours)) return { ok: false, error: "intervalHours must be > 0" };
    if (d.maxTotalUsdc !== undefined && !positiveNumber(d.maxTotalUsdc)) return { ok: false, error: "maxTotalUsdc must be > 0" };
    return { ok: true, params: { coin, side: "buy", quoteAmountUsdc: d.quoteAmountUsdc, intervalHours: d.intervalHours, ...(d.maxTotalUsdc !== undefined ? { maxTotalUsdc: d.maxTotalUsdc } : {}), ...(deadMan ? { deadMan: true } : {}) } };
  }
  if (kind === "twap") {
    const t = p as unknown as TwapParams;
    if (t.side !== "buy" && t.side !== "sell") return { ok: false, error: "twap side must be buy or sell" };
    if (!positiveNumber(t.totalUsdc)) return { ok: false, error: "totalUsdc must be > 0" };
    if (!positiveInteger(t.slices)) return { ok: false, error: "slices must be a positive integer" };
    if (!positiveNumber(t.durationHours)) return { ok: false, error: "durationHours must be > 0" };
    return { ok: true, params: { coin, side: t.side, totalUsdc: t.totalUsdc, slices: t.slices, durationHours: t.durationHours, ...(deadMan ? { deadMan: true } : {}) } };
  }
  if (kind === "tpsl") {
    const x = p as unknown as TpslParams;
    const hasTp = x.takeProfitPrice !== undefined;
    const hasSl = x.stopLossPrice !== undefined;
    if (!hasTp && !hasSl) return { ok: false, error: "takeProfitPrice or stopLossPrice required" };
    if (hasTp && !positiveNumber(x.takeProfitPrice)) return { ok: false, error: "takeProfitPrice must be > 0" };
    if (hasSl && !positiveNumber(x.stopLossPrice)) return { ok: false, error: "stopLossPrice must be > 0" };
    return { ok: true, params: { coin, ...(hasTp ? { takeProfitPrice: x.takeProfitPrice } : {}), ...(hasSl ? { stopLossPrice: x.stopLossPrice } : {}), ...(deadMan ? { deadMan: true } : {}) } };
  }
  if (kind === "grid") {
    const g = p as unknown as GridParams;
    if (!positiveNumber(g.lowerPrice)) return { ok: false, error: "lowerPrice must be > 0" };
    if (!positiveNumber(g.upperPrice) || g.upperPrice <= g.lowerPrice) return { ok: false, error: "upperPrice must be > lowerPrice" };
    if (!positiveInteger(g.levels) || g.levels < 2) return { ok: false, error: "levels must be an integer >= 2" };
    if (!positiveNumber(g.perLevelUsdc)) return { ok: false, error: "perLevelUsdc must be > 0" };
    const mode = g.mode ?? "longOnly";
    if (mode !== "longOnly" && mode !== "symmetric") return { ok: false, error: "mode must be longOnly or symmetric" };
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc, mode, ...(deadMan ? { deadMan: true } : {}) } };
  }
  if (kind === "gridLimit") {
    const g = p as unknown as GridLimitParams;
    if (!positiveNumber(g.lowerPrice)) return { ok: false, error: "lowerPrice must be > 0" };
    if (!positiveNumber(g.upperPrice) || g.upperPrice <= g.lowerPrice) return { ok: false, error: "upperPrice must be > lowerPrice" };
    if (!positiveInteger(g.levels) || g.levels < 2) return { ok: false, error: "levels must be an integer >= 2" };
    if (!positiveNumber(g.perLevelUsdc)) return { ok: false, error: "perLevelUsdc must be > 0" };
    const mode = g.mode ?? "longOnly";
    if (mode !== "longOnly" && mode !== "symmetric") return { ok: false, error: "mode must be longOnly or symmetric" };
    return { ok: true, params: { coin, lowerPrice: g.lowerPrice, upperPrice: g.upperPrice, levels: g.levels, perLevelUsdc: g.perLevelUsdc, mode, ...(deadMan ? { deadMan: true } : {}) } };
  }
  if (kind === "trailing") {
    const x = p as unknown as TrailingParams;
    if (!positiveNumber(x.trailPct) || x.trailPct >= 100) return { ok: false, error: "trailPct must be between 0 and 100" };
    return { ok: true, params: { coin, trailPct: x.trailPct, ...(deadMan ? { deadMan: true } : {}) } };
  }
  return { ok: false, error: "unknown strategy kind" };
}
