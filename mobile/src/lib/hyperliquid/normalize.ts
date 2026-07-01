import type { MarketTicker, MetaAndAssetCtxs, Mids } from "./types";

function pctChange(mark: number, prev: number): number {
  if (!prev || !isFinite(prev)) return 0;
  return ((mark - prev) / prev) * 100;
}

export function normalizeMarkets(data: MetaAndAssetCtxs): MarketTicker[] {
  const [meta, ctxs] = Array.isArray(data) ? data : [];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const ctxList = Array.isArray(ctxs) ? ctxs : [];
  const tickers: MarketTicker[] = universe.map((asset, i) => {
    const ctx = ctxList[i];
    const midPx = Number(ctx?.midPx ?? 0);
    const prevDayPx = Number(ctx?.prevDayPx ?? 0);
    return {
      coin: asset.name,
      midPx,
      prevDayPx,
      changePct: pctChange(midPx, prevDayPx),
      funding: Number(ctx?.funding ?? 0),
      dayNtlVlm: Number(ctx?.dayNtlVlm ?? 0),
      openInterest: Number(ctx?.openInterest ?? 0),
      maxLeverage: asset.maxLeverage,
      szDecimals: asset.szDecimals,
    };
  });
  return tickers.sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
}

export function applyMids(tickers: MarketTicker[], mids: Mids): MarketTicker[] {
  return tickers.map((t) => {
    const raw = mids[t.coin];
    if (raw === undefined) return t;
    const midPx = Number(raw);
    return { ...t, midPx, changePct: pctChange(midPx, t.prevDayPx) };
  });
}
