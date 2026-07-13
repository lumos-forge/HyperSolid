import { selectRoute, pickProxy, hashCode, type RouteInput } from "./selectRoute";

const POOL = ["https://p0.example", "https://p1.example", "https://p2.example"];
const DIRECT = "https://api.hyperliquid.xyz";
const base = (over: Partial<RouteInput>): RouteInput => ({
  mode: "auto", traffic: "readInfo", userId: "0xabc", pool: POOL, directBase: DIRECT, proxyRecommended: false, ...over,
});

describe("hashCode", () => {
  it("is deterministic and distinguishes common strings", () => {
    expect(hashCode("0xabc")).toBe(hashCode("0xabc"));
    expect(hashCode("0xabc")).not.toBe(hashCode("0xdef"));
  });
});

describe("pickProxy", () => {
  it("returns null for an empty pool", () => {
    expect(pickProxy("0xabc", [])).toBeNull();
  });
  it("is consistent for the same user", () => {
    expect(pickProxy("0xabc", POOL)).toBe(pickProxy("0xabc", POOL));
  });
  it("always yields an in-range entry, even for negative hashes", () => {
    for (const u of ["0xabc", "0xdef", "zzz", "user-negative-hash"]) {
      expect(POOL).toContain(pickProxy(u, POOL));
    }
  });
});

describe("selectRoute", () => {
  it("direct mode is always direct", () => {
    expect(selectRoute(base({ mode: "direct", traffic: "readInfo" }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("proxy mode proxies read/public but keeps signed/private direct", () => {
    expect(selectRoute(base({ mode: "proxy", traffic: "readInfo" })).viaProxy).toBe(true);
    expect(selectRoute(base({ mode: "proxy", traffic: "publicWs" })).viaProxy).toBe(true);
    expect(selectRoute(base({ mode: "proxy", traffic: "signedExchange" }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
    expect(selectRoute(base({ mode: "proxy", traffic: "privateWs" }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("auto stays direct unless the environment recommends proxy", () => {
    expect(selectRoute(base({ mode: "auto", traffic: "readInfo", proxyRecommended: false })).viaProxy).toBe(false);
    expect(selectRoute(base({ mode: "auto", traffic: "readInfo", proxyRecommended: true })).viaProxy).toBe(true);
    expect(selectRoute(base({ mode: "auto", traffic: "signedExchange", proxyRecommended: true }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("falls back to direct when the pool is empty", () => {
    expect(selectRoute(base({ mode: "proxy", traffic: "readInfo", pool: [] }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("routes a proxied request to a pool entry", () => {
    const r = selectRoute(base({ mode: "proxy", traffic: "readInfo" }));
    expect(POOL).toContain(r.baseUrl);
  });
});
