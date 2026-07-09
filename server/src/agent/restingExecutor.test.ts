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

describe("makeRestingExecutor.cancelMany", () => {
  it("coalesces mixed-coin cancels into one cancelByCloid, resolving each coin once", async () => {
    const calls: any[] = [];
    const resolves: string[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const asset: Record<string, number> = { BTC: 3, ETH: 5 };
    const d = { clientFor: () => client, resolveAsset: async (coin: string) => { resolves.push(coin); return { assetIndex: asset[coin], szDecimals: 2 }; } };
    const exec = makeRestingExecutor(d);
    const ok = await exec.cancelMany({ owner: "0xo", cancels: [
      { coin: "BTC", cloid: "0xa" }, { coin: "ETH", cloid: "0xb" }, { coin: "BTC", cloid: "0xc" },
    ] });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cancels).toEqual([
      { asset: 3, cloid: "0xa" }, { asset: 5, cloid: "0xb" }, { asset: 3, cloid: "0xc" },
    ]);
    expect(resolves.sort()).toEqual(["BTC", "ETH"]);
  });
  it("chunks by maxCancelBatch", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor({ clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }), maxCancelBatch: 2 });
    await exec.cancelMany({ owner: "0xo", cancels: [
      { coin: "BTC", cloid: "0xa" }, { coin: "BTC", cloid: "0xb" }, { coin: "BTC", cloid: "0xc" },
    ] });
    expect(calls).toHaveLength(2);
    expect(calls[0].cancels).toEqual([{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }]);
    expect(calls[1].cancels).toEqual([{ asset: 3, cloid: "0xc" }]);
  });
  it("no-ops on empty cancels without calling the client", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelMany({ owner: "0xo", cancels: [] })).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("returns false with no client", async () => {
    const exec = makeRestingExecutor(deps(undefined));
    expect(await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xc" }] })).toBe(false);
  });
  it("swallows a cancel error (already gone) and returns true", async () => {
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => { throw new Error("order not found"); } };
    const exec = makeRestingExecutor(deps(client));
    expect(await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xc" }] })).toBe(true);
  });
  it("shadow-verifies the batched cancels, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xa" }, { coin: "BTC", cloid: "0xb" }] });
    expect(shadow).toHaveBeenCalledWith("cancelByCloid", { cancels: [{ asset: 3, cloid: "0xa" }, { asset: 3, cloid: "0xb" }] });
  });
  it("skips a coin that fails to resolve but still cancels the others", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const d = { clientFor: () => client, resolveAsset: async (coin: string) => {
      if (coin === "WAT") throw new Error("unknown coin");
      return { assetIndex: 3, szDecimals: 2 };
    } };
    const exec = makeRestingExecutor(d);
    const ok = await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "WAT", cloid: "0xw" }, { coin: "BTC", cloid: "0xa" }] });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cancels).toEqual([{ asset: 3, cloid: "0xa" }]);
  });
  it("returns true (no send) when every coin fails to resolve", async () => {
    const calls: any[] = [];
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async (p) => { calls.push(p); return {}; } };
    const d = { clientFor: () => client, resolveAsset: async () => { throw new Error("unknown coin"); } };
    const exec = makeRestingExecutor(d);
    expect(await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "WAT", cloid: "0xw" }] })).toBe(true);
    expect(calls).toHaveLength(0);
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
    const ok = await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xc" }] });
    expect(ok).toBe(true);
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("cancelByCloid");
    expect(params).toEqual({ cancels: [{ asset: 3, cloid: "0xc" }] });
  });

  it("a throwing shadowVerify does not affect placeLimit/cancelMany", async () => {
    const shadow = jest.fn(() => {
      throw new Error("boom");
    });
    const client: RestingClientLike = { order: async () => restingRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: true, oid: 999 });
    expect(await exec.cancelMany({ owner: "0xo", cancels: [{ coin: "BTC", cloid: "0xc" }] })).toBe(true);
  });
});
