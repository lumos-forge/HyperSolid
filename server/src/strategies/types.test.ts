import type { Strategy, DcaParams, TwapParams, TpslParams, GridParams } from "./types";

describe("strategy types", () => {
  it("narrows params by kind (compile-time; asserted at runtime)", () => {
    const dca: Strategy = {
      id: "1", owner: "0xo", kind: "dca", status: "running", createdAt: 0,
      nextRunAt: 0, filledTotalUsdc: 0,
      params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } as DcaParams,
    };
    const twap: Strategy = {
      id: "2", owner: "0xo", kind: "twap", status: "running", createdAt: 0,
      nextRunAt: 0, filledTotalUsdc: 0, slicesDone: 0,
      params: { coin: "ETH", side: "sell", totalUsdc: 300, slices: 6, durationHours: 3 } as TwapParams,
    };
    const tpsl: Strategy = {
      id: "3", owner: "0xo", kind: "tpsl", status: "running", createdAt: 0,
      params: { coin: "SOL", takeProfitPrice: 200 } as TpslParams,
    };
    expect([dca.kind, twap.kind, tpsl.kind]).toEqual(["dca", "twap", "tpsl"]);
  });
});

describe("grid kind", () => {
  it("builds a grid strategy shape with lastLevel + actionsDone", () => {
    const params: GridParams = { coin: "BTC", lowerPrice: 60000, upperPrice: 70000, levels: 6, perLevelUsdc: 50 };
    const s: Strategy = {
      id: "1", owner: "0xo", status: "running", createdAt: 0,
      kind: "grid", params, actionsDone: 0,
    };
    expect(s.kind).toBe("grid");
    expect(s.params.perLevelUsdc).toBe(50);
  });
});
