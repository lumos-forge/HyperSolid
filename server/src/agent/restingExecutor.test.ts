import { makeRestingExecutor, type RestingClientLike } from "./restingExecutor";

function deps(client: RestingClientLike | undefined, shadowVerify?: (kind: string, params: unknown) => void) {
  return { clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }), shadowVerify };
}

const restingRes = { response: { data: { statuses: [{ resting: { oid: 999 } }] } } };
const rejectRes = { response: { data: { statuses: [{ error: "Post only order would have immediately matched" }] } } };
const filledRes = { response: { data: { statuses: [{ filled: { totalSz: "0.5", avgPx: "120" } }] } } };

describe("makeRestingExecutor.placeLimit", () => {
  it("sends an Alo limit tuple and returns the resting oid", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async (p) => { calls.push(p); return restingRes; }, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client));
    const r = await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.357, side: "buy", reduceOnly: false, cloid: "0xc" });
    expect(r).toEqual({ ok: true, oid: 999 });
    expect(calls[0].orders[0]).toMatchObject({ a: 3, b: true, r: false, c: "0xc", t: { limit: { tif: "Alo" } } });
    expect(calls[0].orders[0].s).toBe("0.36"); // roundSize to szDecimals=2
  });
  it("flags an ALO post-only rejection", async () => {
    const client: RestingClientLike = { order: async () => rejectRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "sell", reduceOnly: true, cloid: "0xc" })).toEqual({ ok: false, rejected: true });
  });
  it("returns an immediate fill when the order crosses (rare)", async () => {
    const client: RestingClientLike = { order: async () => filledRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: true, filledSz: 0.5, avgPx: 120 });
  });
  it("fails closed with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: false });
  });
});

describe("makeRestingExecutor.cancelCloid", () => {
  it("cancels by cloid and returns true", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(true);
    expect(calls[0]).toEqual({ cancels: [{ asset: 3, cloid: "0xc" }] });
  });
  it("swallows a cancel error (already gone) and returns true", async () => {
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => { throw new Error("order not found"); } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(true);
  });
  it("returns false with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(false);
  });
});

describe("makeRestingExecutor shadow verify", () => {
  it("shadow-verifies the ALO order, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => restingRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    const r = await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.357, side: "buy", reduceOnly: false, cloid: "0xc" });
    expect(r).toEqual({ ok: true, oid: 999 });
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("order");
    expect(params).toMatchObject({ asset: 3, isBuy: true, tif: "Alo", grouping: "na", cloid: "0xc" });
  });

  it("shadow-verifies cancelByCloid, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    const ok = await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" });
    expect(ok).toBe(true);
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("cancelByCloid");
    expect(params).toEqual({ cancels: [{ asset: 3, cloid: "0xc" }] });
  });

  it("a throwing shadowVerify does not affect placeLimit/cancelCloid", async () => {
    const shadow = jest.fn(() => {
      throw new Error("boom");
    });
    const client: RestingClientLike = { order: async () => restingRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: true, oid: 999 });
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(true);
  });
});
