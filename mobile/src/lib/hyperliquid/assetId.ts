import type { RawMeta } from "./types";

export interface AssetIndex {
  id(coin: string): number | null;
  szDecimals(coin: string): number | null;
  coins: string[];
}

/**
 * Spot asset ids are offset by 10000 from their spotInfo["index"].
 * e.g. PURR/USDC has spotInfo index 0 -> asset id 10000.
 */
export const SPOT_ASSET_ID_OFFSET = 10000;

/** Spot pair entry from spotMeta.universe. asset id = 10000 + index. */
export interface RawSpotAsset {
  name: string;
  index: number;
  szDecimals?: number;
}
export interface RawSpotMeta {
  universe: RawSpotAsset[];
}

/**
 * Build a coin -> {assetId, szDecimals} table from meta at startup.
 * Perp asset id = index in meta.universe. NEVER hardcode ids (mainnet/testnet differ).
 */
export function buildAssetIndex(meta: RawMeta): AssetIndex {
  const ids = new Map<string, number>();
  const decimals = new Map<string, number>();
  meta.universe.forEach((a, i) => {
    ids.set(normalizeCoin(a.name), i);
    decimals.set(normalizeCoin(a.name), a.szDecimals);
  });
  return makeAssetIndex(
    ids,
    decimals,
    meta.universe.map((a) => a.name),
  );
}

/**
 * Build a spot pair -> {assetId, szDecimals} table from spotMeta at startup.
 * Spot asset id = 10000 + spotInfo["index"] (use the explicit index field,
 * NOT array position — they can differ, e.g. HYPE/USDC).
 */
export function buildSpotAssetIndex(meta: RawSpotMeta): AssetIndex {
  const ids = new Map<string, number>();
  const decimals = new Map<string, number>();
  meta.universe.forEach((a) => {
    ids.set(normalizeCoin(a.name), SPOT_ASSET_ID_OFFSET + a.index);
    if (a.szDecimals !== undefined) decimals.set(normalizeCoin(a.name), a.szDecimals);
  });
  return makeAssetIndex(
    ids,
    decimals,
    meta.universe.map((a) => a.name),
  );
}

export function resolveAssetId(index: AssetIndex, coin: string): number | null {
  return index.id(coin);
}

function normalizeCoin(coin: string): string {
  return coin.trim().toUpperCase();
}

function makeAssetIndex(
  ids: Map<string, number>,
  decimals: Map<string, number>,
  coins: string[],
): AssetIndex {
  return {
    id: (coin) => {
      const key = normalizeCoin(coin);
      return ids.has(key) ? ids.get(key)! : null;
    },
    szDecimals: (coin) => {
      const key = normalizeCoin(coin);
      return decimals.has(key) ? decimals.get(key)! : null;
    },
    coins,
  };
}
