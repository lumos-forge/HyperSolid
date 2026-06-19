import {
  buildAssetIndex,
  resolveAssetId,
} from "./assetId";
import type { RawMeta } from "./types";

const meta: RawMeta = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
    { name: "SOL", szDecimals: 2, maxLeverage: 20 },
  ],
};

describe("asset-id resolution", () => {
  it("maps coin name to its universe index (perp asset id)", () => {
    const idx = buildAssetIndex(meta);
    expect(resolveAssetId(idx, "BTC")).toBe(0);
    expect(resolveAssetId(idx, "ETH")).toBe(1);
    expect(resolveAssetId(idx, "SOL")).toBe(2);
  });

  it("returns null for unknown coins (never hardcode ids)", () => {
    const idx = buildAssetIndex(meta);
    expect(resolveAssetId(idx, "DOGE")).toBeNull();
  });

  it("exposes szDecimals per coin for precision rules", () => {
    const idx = buildAssetIndex(meta);
    expect(idx.szDecimals("BTC")).toBe(5);
    expect(idx.szDecimals("ETH")).toBe(4);
  });
});
