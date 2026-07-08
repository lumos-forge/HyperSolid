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

describe("makeRestingExecutor.cancelCloids", () => {
  it("coalesces multiple cloids into a single cancelByCloid with one asset resolve", async () => {
    const calls: any[] = [];
    let resolves = 0;
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const d = { clientFor: () => client, resolveAsset: async () => { resolves++; return { assetIndex: 3, szDecimals: 2 }; } };
    const exec = makeRestingExecutor(d);
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xa", "0xb", "0xc"] })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ cancels: [{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }, { asset: 3, cloid: "0xc" }] });
    expect(resolves).toBe(1);
  });
  it("chunks by maxCancelBatch", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor({ clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }), maxCancelBatch: 2 });
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xa", "0xb", "0xc"] })).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].cancels).toEqual([{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }]);
    expect(calls[1].cancels).toEqual([{ asset: 3, cloid: "0xc" }]);
  });
  it("no-ops on empty cloids without calling the client", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: [] })).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("returns false with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xc"] })).toBe(false);
  });
  it("swallows a cancel error (already gone) and returns true", async () => {
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => { throw new Error("order not found"); } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xc"] })).toBe(true);
  });
  it("shadow-verifies the batched cancels, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xa", "0xb"] });
    expect(shadow).toHaveBeenCalledWith("cancelByCloid", { cancels: [{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }] });
  });
  it("does not reject when resolveAsset throws (best-effort, idempotent)", async () => {
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => ({}) };
    const d = { clientFor: () => client, resolveAsset: async () => { throw new Error("unknown coin"); } };
    const exec = makeRestingExecutor(d);
    await expect(exec.cancelCloids({ owner: "0xo", coin: "WAT", cloids: ["0xc"] })).resolves.toBe(true);
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
    const ok = await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xc"] });
    expect(ok).toBe(true);
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("cancelByCloid");
    expect(params).toEqual({ cancels: [{ asset: 3, cloid: "0xc" }] });
  });

  it("a throwing shadowVerify does not affect placeLimit/cancelCloids", async () => {
    const shadow = jest.fn(() => {
      throw new Error("boom");
    });
    const client: RestingClientLike = { order: async () => restingRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: true, oid: 999 });
    expect(await exec.cancelCloids({ owner: "0xo", coin: "BTC", cloids: ["0xc"] })).toBe(true);
  });
});
