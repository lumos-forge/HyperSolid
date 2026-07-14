import { makeBuilderInjector, type BuilderInfoLike } from "./builderInjector";

const ADDR = ("0x" + "b".repeat(40)) as `0x${string}`;
const OWNER = "0x" + "1".repeat(40);

function fakeInfo(fn: BuilderInfoLike["maxBuilderFee"]): { info: BuilderInfoLike; calls: number } {
  const box = { info: null as unknown as BuilderInfoLike, calls: 0 };
  box.info = {
    maxBuilderFee: async (p) => {
      box.calls++;
      return fn(p);
    },
  };
  return box;
}

describe("makeBuilderInjector", () => {
  it("returns the builder when the approved rate covers the configured fee", async () => {
    const f = fakeInfo(async () => 100);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    expect(await inj.builderFor(OWNER)).toEqual({ b: ADDR, f: 20 });
  });

  it("returns undefined when the approved rate is below the fee", async () => {
    const f = fakeInfo(async () => 10);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    expect(await inj.builderFor(OWNER)).toBeUndefined();
  });

  it("fails open (undefined) when the query throws", async () => {
    const f = fakeInfo(async () => { throw new Error("net"); });
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    expect(await inj.builderFor(OWNER)).toBeUndefined();
  });

  it("caches an approved owner (no repeat query)", async () => {
    const f = fakeInfo(async () => 50);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    await inj.builderFor(OWNER);
    await inj.builderFor(OWNER);
    expect(f.calls).toBe(1);
  });

  it("re-checks an unapproved owner only after the negative TTL", async () => {
    let t = 0;
    let rate = 0;
    const f = fakeInfo(async () => rate);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20, now: () => t, negativeTtlMs: 1000 });
    expect(await inj.builderFor(OWNER)).toBeUndefined(); // query 1
    t = 500;
    expect(await inj.builderFor(OWNER)).toBeUndefined(); // cached, no query
    expect(f.calls).toBe(1);
    t = 1500; // past TTL
    rate = 100;
    expect(await inj.builderFor(OWNER)).toEqual({ b: ADDR, f: 20 }); // query 2, now approved
    expect(f.calls).toBe(2);
  });

  it("keys the cache case-insensitively", async () => {
    const f = fakeInfo(async () => 100);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    await inj.builderFor(OWNER.toUpperCase());
    await inj.builderFor(OWNER.toLowerCase());
    expect(f.calls).toBe(1);
  });
});
