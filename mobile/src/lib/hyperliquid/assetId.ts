import type { RawMeta } from "./types";

export interface AssetIndex {
  id(coin: string): number | null;
  szDecimals(coin: string): number | null;
  coins: string[];
}

/**
 * Build a coin -> {assetId, szDecimals} table from meta at startup.
 * Perp asset id = index in meta.universe. NEVER hardcode ids (mainnet/testnet differ).
 */
export function buildAssetIndex(meta: RawMeta): AssetIndex {
  const ids = new Map<string, number>();
  const decimals = new Map<string, number>();
  meta.universe.forEach((a, i) => {
    ids.set(a.name, i);
    decimals.set(a.name, a.szDecimals);
  });
  return {
    id: (coin) => (ids.has(coin) ? ids.get(coin)! : null),
    szDecimals: (coin) => (decimals.has(coin) ? decimals.get(coin)! : null),
    coins: meta.universe.map((a) => a.name),
  };
}

export function resolveAssetId(index: AssetIndex, coin: string): number | null {
  return index.id(coin);
}
