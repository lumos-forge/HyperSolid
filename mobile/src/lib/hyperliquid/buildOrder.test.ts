import { buildOrder, buildBracketOrder } from "./buildOrder";
import { buildAssetIndex, buildSpotAssetIndex } from "./assetId";
import type { RawMeta } from "./types";
import { isValidCloid } from "./cloid";

const meta: RawMeta = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
  ],
};
const index = buildAssetIndex(meta);
const spotIndex = buildSpotAssetIndex({
  universe: [{ name: "PURR/USDC", index: 0, szDecimals: 2 }],
});
const BUILDER = ("0x" + "a".repeat(40)) as `0x${string}`;

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
    expect(r.params.orders[0].t).toEqual({ limit: { tif: "Alo" } });
  });

  it("encodes a market order as IOC (§4.3 市价IOC)", () => {
    const r = buildOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000, market: true }, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.orders[0].t).toEqual({ limit: { tif: "Ioc" } });
  });

  it("always includes r as a boolean (HL schema requires it; not omitted)", () => {
    const r = buildOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 }, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.orders[0]).toHaveProperty("r");
    expect(typeof r.params.orders[0].r).toBe("boolean");
    expect(r.params.orders[0].r).toBe(false);
  });

  it("omits the optional builder field entirely when absent (omit-not-false gotcha)", () => {
    const r = buildOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 }, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("builder" in r.params).toBe(false);
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

  it("accepts a perp builder fee at the 0.1% cap (100 tenth-bps)", () => {
    const r = buildOrder(
      { coin: "BTC", side: "buy", size: 0.01, price: 60000, builder: { address: BUILDER, feeTenthBps: 100 } },
      index,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.builder).toEqual({ b: BUILDER, f: 100 });
  });

  it("rejects a perp builder fee above the 0.1% cap", () => {
    const r = buildOrder(
      { coin: "BTC", side: "buy", size: 0.01, price: 60000, builder: { address: BUILDER, feeTenthBps: 101 } },
      index,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection).toBe("builderFeeRejected");
  });

  it("allows a higher builder fee on spot (1% cap = 1000 tenth-bps)", () => {
    const r = buildOrder(
      { coin: "PURR/USDC", side: "buy", size: 50, price: 1, builder: { address: BUILDER, feeTenthBps: 1000 } },
      spotIndex,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.builder).toEqual({ b: BUILDER, f: 1000 });

    const over = buildOrder(
      { coin: "PURR/USDC", side: "buy", size: 50, price: 1, builder: { address: BUILDER, feeTenthBps: 1001 } },
      spotIndex,
    );
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.rejection).toBe("builderFeeRejected");
  });

  it("formats price and size to asset precision", () => {
    const r = buildOrder({ coin: "BTC", side: "buy", size: 0.123456789, price: 60000.5 }, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.orders[0].s).toBe("0.12346"); // szDecimals 5
    expect(r.params.orders[0].p).toBe("60001"); // 5 sig figs
  });

  it("formats spot prices with spot (8-decimal) precision, not perp", () => {
    // TINY/USDC at asset id 10005 -> marketKindForAssetId => "spot" (8 decimals, not perp 6)
    const tinySpot = buildSpotAssetIndex({
      universe: [{ name: "TINY/USDC", index: 5, szDecimals: 0 }],
    });
    const r = buildOrder(
      { coin: "TINY/USDC", side: "buy", size: 1000000, price: 0.0000123 },
      tinySpot,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // spot allows 8 decimals -> "0.0000123"; perp (6) would wrongly truncate to "0.000012"
    expect(r.params.orders[0].p).toBe("0.0000123");
  });

  it("formats spot trigger prices with spot precision too", () => {
    const tinySpot = buildSpotAssetIndex({
      universe: [{ name: "TINY/USDC", index: 5, szDecimals: 0 }],
    });
    const r = buildOrder(
      {
        coin: "TINY/USDC",
        side: "sell",
        size: 1000000,
        price: 0.0000123,
        reduceOnly: true,
        trigger: { triggerPx: 0.0000119, isMarket: true, tpsl: "sl" },
      },
      tinySpot,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.params.orders[0].t;
    expect("trigger" in t && t.trigger.triggerPx).toBe("0.0000119");
  });
});

describe("buildOrder — trigger (TP/SL) single order", () => {
  it("encodes a stop-loss trigger order with formatted triggerPx", () => {
    const r = buildOrder(
      {
        coin: "ETH",
        side: "sell",
        size: 1,
        price: 2950,
        reduceOnly: true,
        trigger: { triggerPx: 2950.5, isMarket: true, tpsl: "sl" },
      },
      index,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.params.orders[0].t;
    expect("trigger" in t).toBe(true);
    if (!("trigger" in t)) return;
    expect(t.trigger.isMarket).toBe(true);
    expect(t.trigger.tpsl).toBe("sl");
    expect(t.trigger.triggerPx).toBe("2950.5");
    expect(r.params.orders[0].r).toBe(true);
  });
});

describe("buildBracketOrder — entry + TP/SL sibling pairing + grouping", () => {
  it("builds entry + TP + SL with normalTpsl grouping (default)", () => {
    const r = buildBracketOrder(
      {
        entry: { coin: "BTC", side: "buy", size: 0.01, price: 60000 },
        takeProfit: { triggerPx: 66000 },
        stopLoss: { triggerPx: 54000 },
      },
      index,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.grouping).toBe("normalTpsl");
    expect(r.params.orders).toHaveLength(3);

    const [entry, tp, sl] = r.params.orders;
    // entry: buy, limit, not reduce-only
    expect(entry.b).toBe(true);
    expect("limit" in entry.t).toBe(true);
    expect(entry.r).toBe(false);
    // TP/SL: opposite side (close long => sell), reduce-only triggers
    expect(tp.b).toBe(false);
    expect(tp.r).toBe(true);
    expect("trigger" in tp.t && tp.t.trigger.tpsl).toBe("tp");
    expect(sl.b).toBe(false);
    expect(sl.r).toBe(true);
    expect("trigger" in sl.t && sl.t.trigger.tpsl).toBe("sl");
    // each leg has a unique cloid
    const cloids = r.params.orders.map((o) => o.c);
    expect(new Set(cloids).size).toBe(3);
    cloids.forEach((c) => expect(isValidCloid(c)).toBe(true));
  });

  it("supports positionTpsl grouping and TP-only brackets", () => {
    const r = buildBracketOrder(
      {
        entry: { coin: "ETH", side: "sell", size: 1, price: 3000 },
        takeProfit: { triggerPx: 2700, isMarket: false },
        grouping: "positionTpsl",
      },
      index,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.grouping).toBe("positionTpsl");
    expect(r.params.orders).toHaveLength(2);
    const tp = r.params.orders[1];
    // close a short => buy
    expect(tp.b).toBe(true);
    expect("trigger" in tp.t && tp.t.trigger.isMarket).toBe(false);
  });

  it("rejects an unknown asset and propagates three-piece rejections", () => {
    expect(
      buildBracketOrder({ entry: { coin: "DOGE", side: "buy", size: 1, price: 1 } }, index),
    ).toEqual({ ok: false, rejection: "unknownAsset" });

    const subMin = buildBracketOrder(
      { entry: { coin: "BTC", side: "buy", size: 0.0001, price: 50 } },
      index,
    );
    expect(subMin.ok).toBe(false);
    if (subMin.ok) return;
    expect(subMin.rejection).toBe("minTradeNtlRejected");
  });
});
