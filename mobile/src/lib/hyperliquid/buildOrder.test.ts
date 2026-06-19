import { buildOrder } from "./buildOrder";
import { buildAssetIndex } from "./assetId";
import type { RawMeta } from "./types";
import { isValidCloid } from "./cloid";

const meta: RawMeta = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
  ],
};
const index = buildAssetIndex(meta);

describe("buildOrder", () => {
  it("builds valid params with resolved asset id and a cloid", () => {
    const r = buildOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 }, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.orders[0].a).toBe(0);
    expect(r.params.orders[0].b).toBe(true);
    expect(isValidCloid(r.params.orders[0].c)).toBe(true);
    expect(r.params.grouping).toBe("na");
  });

  it("rejects an unknown asset (never hardcode ids)", () => {
    const r = buildOrder({ coin: "DOGE", side: "buy", size: 1, price: 1 }, index);
    expect(r).toEqual({ ok: false, rejection: "unknownAsset" });
  });

  it("rejects sub-$10 notional via three-piece validation", () => {
    const r = buildOrder({ coin: "BTC", side: "buy", size: 0.0001, price: 50 }, index);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection).toBe("minTradeNtlRejected");
  });

  it("maps side sell to isBuy=false and honors reduceOnly + tif", () => {
    const r = buildOrder(
      { coin: "ETH", side: "sell", size: 1, price: 3000, reduceOnly: true, tif: "Alo" },
      index,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.orders[0].b).toBe(false);
    expect(r.params.orders[0].r).toBe(true);
    expect(r.params.orders[0].t.limit.tif).toBe("Alo");
  });

  it("attaches builder fee when provided", () => {
    const addr = ("0x" + "a".repeat(40)) as `0x${string}`;
    const r = buildOrder(
      { coin: "BTC", side: "buy", size: 0.01, price: 60000, builder: { address: addr, feeTenthBps: 10 } },
      index,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.builder).toEqual({ b: addr, f: 10 });
  });

  it("formats price and size to asset precision", () => {
    const r = buildOrder({ coin: "BTC", side: "buy", size: 0.123456789, price: 60000.5 }, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.orders[0].s).toBe("0.12346"); // szDecimals 5
    expect(r.params.orders[0].p).toBe("60001"); // 5 sig figs
  });
});
