import { makeHlPlacer, type ExchangeLike, type PlacerDeps } from "./placer";

const filled = { totalSz: "2", avgPx: "100" };
const deps = (
  orderSpy: (o: unknown) => void = () => undefined,
  price = 100,
  fill = filled,
  over: Partial<PlacerDeps> = {},
): PlacerDeps => ({
  clientFor: () => ({
    order: async (params: { orders: unknown[] }) => {
      orderSpy(params.orders[0]);
      return { response: { data: { statuses: [{ filled: fill }] } } };
    },
  }),
  resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }),
  resolvePrice: async () => price,
  slippageBps: 50,
  ...over,
});

describe("makeHlPlacer", () => {
  it("buy notional order: b=true, r=false, aggressive up", async () => {
    let order: any;
    const placer = makeHlPlacer(deps((o) => (order = o)));
    const res = await placer.place({ owner: "0xo", coin: "BTC", cloid: "0xc", side: "buy", reduceOnly: false, sizeUsdc: 200 });
    expect(res.ok).toBe(true);
    expect(order.a).toBe(3);
    expect(order.b).toBe(true);
    expect(order.c).toBe("0xc");
    expect(order.r).toBe(false);
    expect(order.t).toEqual({ limit: { tif: "Ioc" } });
    expect(Number(order.p)).toBeGreaterThan(100);
    expect(order.s).toBe("2");
    expect(res).toEqual({ ok: true, filledUsdc: 200, filledSz: 2, avgPx: 100 });
  });

  it("sell order: b=false, aggressive down", async () => {
    let order: any;
    const placer = makeHlPlacer(deps((o) => (order = o)));
    await placer.place({ owner: "0xo", coin: "BTC", cloid: "0xc", side: "sell", reduceOnly: false, sizeUsdc: 200 });
    expect(order.b).toBe(false);
    expect(Number(order.p)).toBeLessThan(100);
  });

  it("reduce-only close by coin size: r=true, uses sizeCoin", async () => {
    let order: any;
    const placer = makeHlPlacer(deps((o) => (order = o)));
    await placer.place({ owner: "0xo", coin: "BTC", cloid: "0xc", side: "sell", reduceOnly: true, sizeCoin: 1.5 });
    expect(order.r).toBe(true);
    expect(order.s).toBe("1.5");
  });

  it("fails closed when no agent client is available for the owner", async () => {
    const res = await makeHlPlacer(deps(undefined, 100, filled, { clientFor: () => undefined })).place({
      owner: "0xo",
      coin: "BTC",
      side: "buy",
      reduceOnly: false,
      sizeUsdc: 50,
      cloid: "0xabc",
    });
    expect(res.ok).toBe(false);
  });

  it("fails closed when the price is unavailable", async () => {
    const res = await makeHlPlacer(deps(undefined, 0)).place({
      owner: "0xo",
      coin: "BTC",
      side: "buy",
      reduceOnly: false,
      sizeUsdc: 50,
      cloid: "0xabc",
    });
    expect(res.ok).toBe(false);
  });

  it("treats an error status (and thrown errors) as a non-fill, never a success", async () => {
    const errClient: ExchangeLike = {
      async order() {
        return { status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } } };
      },
    };
    expect((await makeHlPlacer(deps(undefined, 100, filled, { clientFor: () => errClient })).place({
      owner: "0xo",
      coin: "BTC",
      side: "buy",
      reduceOnly: false,
      sizeUsdc: 50,
      cloid: "0xabc",
    })).ok).toBe(false);

    const throwClient: ExchangeLike = { async order() { throw new Error("network"); } };
    expect((await makeHlPlacer(deps(undefined, 100, filled, { clientFor: () => throwClient })).place({
      owner: "0xo",
      coin: "BTC",
      side: "buy",
      reduceOnly: false,
      sizeUsdc: 50,
      cloid: "0xabc",
    })).ok).toBe(false);
  });

  it("calls shadowVerify with the order params, fire-and-forget", async () => {
    const shadow = jest.fn();
    const placer = makeHlPlacer(deps(() => undefined, 100, filled, { shadowVerify: shadow }));
    const res = await placer.place({ owner: "0xo", coin: "BTC", cloid: "0xc", side: "buy", reduceOnly: false, sizeUsdc: 200 });
    expect(res.ok).toBe(true);
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("order");
    expect(params).toMatchObject({ asset: 3, isBuy: true, reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0xc" });
  });

  it("a throwing shadowVerify does not affect placement", async () => {
    const shadow = jest.fn(() => { throw new Error("boom"); });
    const placer = makeHlPlacer(deps(() => undefined, 100, filled, { shadowVerify: shadow }));
    const res = await placer.place({ owner: "0xo", coin: "BTC", cloid: "0xc", side: "buy", reduceOnly: false, sizeUsdc: 200 });
    expect(res.ok).toBe(true);
  });
});
