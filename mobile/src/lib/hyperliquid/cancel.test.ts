import { buildCancel, buildCancelByCloid, buildModify } from "./cancel";
import { buildAssetIndex } from "./assetId";
import type { RawMeta } from "./types";

const meta: RawMeta = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
  ],
};
const index = buildAssetIndex(meta);
const CLOID = ("0x" + "1".repeat(32)) as `0x${string}`;

describe("buildCancel (by oid)", () => {
  it("builds cancels[{a,o}] with the resolved asset id", () => {
    const r = buildCancel("BTC", 12345, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.cancels).toEqual([{ a: 0, o: 12345 }]);
  });

  it("rejects an unknown asset", () => {
    expect(buildCancel("DOGE", 1, index)).toEqual({ ok: false, rejection: "unknownAsset" });
  });
});

describe("buildCancelByCloid (gotcha: field name is 'asset', NOT 'a')", () => {
  it("emits { asset, cloid } and never the 'a' field", () => {
    const r = buildCancelByCloid("ETH", CLOID, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.params.cancels[0];
    expect(c).toEqual({ asset: 1, cloid: CLOID });
    expect("a" in c).toBe(false);
  });

  it("rejects an unknown asset", () => {
    expect(buildCancelByCloid("DOGE", CLOID, index)).toEqual({
      ok: false,
      rejection: "unknownAsset",
    });
  });
});

describe("buildModify", () => {
  it("builds { oid, order } reusing buildOrder validation/encoding", () => {
    const r = buildModify(999, { coin: "BTC", side: "buy", size: 0.01, price: 60000 }, index);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.oid).toBe(999);
    expect(r.params.order.a).toBe(0);
    expect(r.params.order.b).toBe(true);
    expect("limit" in r.params.order.t).toBe(true);
  });

  it("can target an order by cloid", () => {
    const r = buildModify(
      CLOID,
      { coin: "BTC", side: "sell", size: 0.01, price: 60000, tif: "Alo" },
      index,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.oid).toBe(CLOID);
    expect(r.params.order.t).toEqual({ limit: { tif: "Alo" } });
  });

  it("propagates three-piece rejections (unknown asset / sub-$10)", () => {
    expect(buildModify(1, { coin: "DOGE", side: "buy", size: 1, price: 1 }, index)).toEqual({
      ok: false,
      rejection: "unknownAsset",
    });
    const sub = buildModify(1, { coin: "BTC", side: "buy", size: 0.0001, price: 50 }, index);
    expect(sub.ok).toBe(false);
    if (sub.ok) return;
    expect(sub.rejection).toBe("minTradeNtlRejected");
  });
});
