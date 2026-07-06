import { makeOpenOrdersReader } from "./openOrdersReader";

describe("makeOpenOrdersReader.openCloids", () => {
  it("maps cloid -> order (B/A side), dropping null-cloid orders", async () => {
    const info = {
      frontendOpenOrders: async ({ user }: { user: string }) => {
        expect(user).toBe("0xo");
        return [
          { cloid: "0xaa", oid: 1, coin: "BTC", side: "B", limitPx: "140", sz: "0.5" },
          { cloid: null, oid: 2, coin: "BTC", side: "A", limitPx: "160", sz: "0.5" },
          { cloid: "0xbb", oid: 3, coin: "ETH", side: "A", limitPx: "3000", sz: "1" },
        ];
      },
    };
    const reader = makeOpenOrdersReader(info as never);
    const map = await reader.openCloids("0xo");
    expect([...map.keys()].sort()).toEqual(["0xaa", "0xbb"]);
    expect(map.get("0xaa")).toEqual({ oid: 1, coin: "BTC", side: "buy", px: 140 });
    expect(map.get("0xbb")).toEqual({ oid: 3, coin: "ETH", side: "sell", px: 3000 });
  });
  it("returns an empty map for a non-array response", async () => {
    const reader = makeOpenOrdersReader({ frontendOpenOrders: async () => null } as never);
    expect((await reader.openCloids("0xo")).size).toBe(0);
  });
});
