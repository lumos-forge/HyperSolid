import { makeHlPlacer, type ExchangeLike, type PlacerDeps } from "./placer";

type OrderArg = { orders: { a: number; b: boolean; p: string; s: string; r: boolean; t: unknown; c: string }[]; grouping: string };

function deps(over: Partial<PlacerDeps> = {}): { deps: PlacerDeps; orders: OrderArg[] } {
  const orders: OrderArg[] = [];
  const client: ExchangeLike = {
    async order(arg: unknown) {
      orders.push(arg as OrderArg);
      return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.001", avgPx: "50000" } }] } } };
    },
  };
  return {
    orders,
    deps: {
      clientFor: () => client,
      resolveAsset: async () => ({ assetIndex: 3, szDecimals: 3 }),
      resolvePrice: async () => 50000,
      slippageBps: 50,
      ...over,
    },
  };
}

describe("makeHlPlacer", () => {
  it("places an aggressive IoC buy for the requested USDC with the given cloid, and reports the fill", async () => {
    const { deps: d, orders } = deps();
    const placer = makeHlPlacer(d);

    const res = await placer.place({ owner: "0xo", coin: "BTC", sizeUsdc: 50, cloid: "0xabc" });

    expect(orders).toHaveLength(1);
    const o = orders[0].orders[0];
    expect(orders[0].grouping).toBe("na");
    expect(o.a).toBe(3);
    expect(o.b).toBe(true);
    expect(o.c).toBe("0xabc");
    expect(o.r).toBe(false);
    expect(o.t).toEqual({ limit: { tif: "Ioc" } });
    // size = 50/50000 = 0.001 -> rounded to szDecimals 3
    expect(o.s).toBe("0.001");
    // aggressive buy price = 50000 * (1 + 50bps) = 50250
    expect(o.p).toBe("50250");
    expect(res).toEqual({ ok: true, filledUsdc: 50, filledSz: 0.001, avgPx: 50000 });
  });

  it("fails closed when no agent client is available for the owner", async () => {
    const { deps: d } = deps({ clientFor: () => undefined });
    const res = await makeHlPlacer(d).place({ owner: "0xo", coin: "BTC", sizeUsdc: 50, cloid: "0xabc" });
    expect(res.ok).toBe(false);
  });

  it("fails closed when the price is unavailable", async () => {
    const { deps: d } = deps({ resolvePrice: async () => 0 });
    const res = await makeHlPlacer(d).place({ owner: "0xo", coin: "BTC", sizeUsdc: 50, cloid: "0xabc" });
    expect(res.ok).toBe(false);
  });

  it("treats an error status (and thrown errors) as a non-fill, never a success", async () => {
    const errClient: ExchangeLike = {
      async order() {
        return { status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } } };
      },
    };
    const { deps: d } = deps({ clientFor: () => errClient });
    expect((await makeHlPlacer(d).place({ owner: "0xo", coin: "BTC", sizeUsdc: 50, cloid: "0xabc" })).ok).toBe(false);

    const throwClient: ExchangeLike = { async order() { throw new Error("network"); } };
    const { deps: d2 } = deps({ clientFor: () => throwClient });
    expect((await makeHlPlacer(d2).place({ owner: "0xo", coin: "BTC", sizeUsdc: 50, cloid: "0xabc" })).ok).toBe(false);
  });
});
