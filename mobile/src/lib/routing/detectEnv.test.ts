import { hlRestBase, decideProxyRecommended, probeDirectReachable } from "./detectEnv";

describe("hlRestBase", () => {
  it("maps network to the HL REST base", () => {
    expect(hlRestBase("mainnet")).toBe("https://api.hyperliquid.xyz");
    expect(hlRestBase("testnet")).toBe("https://api.hyperliquid-testnet.xyz");
  });
});

describe("decideProxyRecommended", () => {
  it("recommends proxy only for China + unreachable", () => {
    expect(decideProxyRecommended({ isChina: true, directReachable: false })).toBe(true);
    expect(decideProxyRecommended({ isChina: true, directReachable: true })).toBe(false);
    expect(decideProxyRecommended({ isChina: false, directReachable: false })).toBe(false);
    expect(decideProxyRecommended({ isChina: false, directReachable: true })).toBe(false);
  });
});

describe("probeDirectReachable", () => {
  it("returns true on an ok response", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true }) as Response);
    await expect(probeDirectReachable("https://api.hyperliquid.xyz", fetchImpl, 3000)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });
  it("returns false on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false }) as Response);
    await expect(probeDirectReachable("https://api.hyperliquid.xyz", fetchImpl, 3000)).resolves.toBe(false);
  });
  it("returns false when the fetch rejects (timeout/error)", async () => {
    const fetchImpl = jest.fn(async () => { throw new Error("timeout"); });
    await expect(probeDirectReachable("https://api.hyperliquid.xyz", fetchImpl as unknown as typeof fetch, 3000)).resolves.toBe(false);
  });
});
