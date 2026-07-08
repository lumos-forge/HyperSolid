import { makeOpenOrdersReader } from "./openOrdersReader";

describe("makeOpenOrdersReader.openOrders", () => {
  it("maps cloid -> order and reports total open-order count (incl. non-cloid manual orders)", async () => {
    const info = {
      frontendOpenOrders: async ({ user }: { user: string }) => {
        expect(user).toBe("0xo");
        return [
          { cloid: "0xaa", oid: 1, coin: "BTC", side: "B", limitPx: "140", sz: "0.5" },
          { cloid: null, oid: 2, coin: "BTC", side: "A", limitPx: "160", sz: "0.5" }, // manual, no cloid
          { cloid: "0xbb", oid: 3, coin: "ETH", side: "A", limitPx: "3000", sz: "1" },
        ];
      },
    };
    const reader = makeOpenOrdersReader(info as never);
    const { byCloid, total } = await reader.openOrders("0xo");
    expect(total).toBe(3); // ALL open orders (HL quota measure)
    expect([...byCloid.keys()].sort()).toEqual(["0xaa", "0xbb"]); // only cloid-tagged
    expect(byCloid.get("0xaa")).toEqual({ oid: 1, coin: "BTC", side: "buy", px: 140 });
    expect(byCloid.get("0xbb")).toEqual({ oid: 3, coin: "ETH", side: "sell", px: 3000 });
  });
  it("returns an empty map and zero total for a non-array response", async () => {
    const reader = makeOpenOrdersReader({ frontendOpenOrders: async () => null } as never);
    const { byCloid, total } = await reader.openOrders("0xo");
    expect(byCloid.size).toBe(0);
    expect(total).toBe(0);
  });
});
