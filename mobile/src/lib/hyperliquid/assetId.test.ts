import {
  buildAssetIndex,
  buildSpotAssetIndex,
  resolveAssetId,
  SPOT_ASSET_ID_OFFSET,
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

  it("resolves coin names case-insensitively", () => {
    const idx = buildAssetIndex(meta);
    expect(resolveAssetId(idx, "btc")).toBe(0);
    expect(resolveAssetId(idx, "Eth")).toBe(1);
    expect(idx.szDecimals("sol")).toBe(2);
  });

  it("exposes szDecimals per coin for precision rules", () => {
    const idx = buildAssetIndex(meta);
    expect(idx.szDecimals("BTC")).toBe(5);
    expect(idx.szDecimals("ETH")).toBe(4);
  });
});

describe("spot asset-id resolution", () => {
  // HL: spot asset = 10000 + spotInfo["index"] (NOT array position).
  const spotMeta = {
    universe: [
      { name: "PURR/USDC", index: 0, szDecimals: 2 },
      { name: "HYPE/USDC", index: 107 },
    ],
  };

  it("offset constant is 10000", () => {
    expect(SPOT_ASSET_ID_OFFSET).toBe(10000);
  });

  it("maps spot pair to 10000 + spotInfo.index", () => {
    const idx = buildSpotAssetIndex(spotMeta);
    expect(resolveAssetId(idx, "PURR/USDC")).toBe(10000);
    expect(resolveAssetId(idx, "HYPE/USDC")).toBe(10107);
  });

  it("uses the explicit index field, not array position", () => {
    const idx = buildSpotAssetIndex(spotMeta);
    // HYPE is at array position 1 but spotInfo.index 107 -> 10107, not 10001
    expect(resolveAssetId(idx, "HYPE/USDC")).toBe(10000 + 107);
  });

  it("resolves spot pairs case-insensitively", () => {
    const idx = buildSpotAssetIndex(spotMeta);
    expect(resolveAssetId(idx, "purr/usdc")).toBe(10000);
    expect(resolveAssetId(idx, "Hype/Usdc")).toBe(10107);
  });

  it("returns null for unknown spot pairs", () => {
    const idx = buildSpotAssetIndex(spotMeta);
    expect(resolveAssetId(idx, "FOO/USDC")).toBeNull();
  });

  it("exposes spot szDecimals when provided, else null", () => {
    const idx = buildSpotAssetIndex(spotMeta);
    expect(idx.szDecimals("PURR/USDC")).toBe(2);
    expect(idx.szDecimals("HYPE/USDC")).toBeNull();
  });
});
