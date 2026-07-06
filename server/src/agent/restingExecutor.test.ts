import { makeRestingExecutor, type RestingClientLike } from "./restingExecutor";

function deps(client: RestingClientLike | undefined) {
  return { clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }) };
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
