import { makeUserFillsReader } from "./userFillsReader";

describe("makeUserFillsReader.fillsByCloid", () => {
  it("indexes fills by cloid, aggregating partials (sum sz/closedPnl, sz-weighted avg px)", async () => {
    const info = {
      userFills: async ({ user }: { user: string }) => {
        expect(user).toBe("0xo");
        return [
          { cloid: "0xaa", px: "100", sz: "0.4", closedPnl: "2" },
          { cloid: "0xaa", px: "110", sz: "0.6", closedPnl: "3" }, // partial fill of same order
          { cloid: null, px: "200", sz: "1", closedPnl: "9" }, // no cloid -> dropped
        ];
      },
    };
    const reader = makeUserFillsReader(info as never);
    const map = await reader.fillsByCloid("0xo");
    expect([...map.keys()]).toEqual(["0xaa"]);
    expect(map.get("0xaa")).toEqual({ sz: 1, closedPnl: 5, px: (100 * 0.4 + 110 * 0.6) / 1 });
  });
  it("returns an empty map for a non-array response", async () => {
    const reader = makeUserFillsReader({ userFills: async () => null } as never);
    expect((await reader.fillsByCloid("0xo")).size).toBe(0);
  });
});
