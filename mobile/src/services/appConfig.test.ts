import { loadAppConfig } from "./appConfig";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("loadAppConfig", () => {
  it("fetches the app-config endpoint and parses the per-network RPC", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        arbitrumRpc: { mainnet: "https://m/key", testnet: "https://t/key" },
        withdrawFeeUsdc: { mainnet: 1, testnet: 0 },
        strategyApiBaseUrl: "https://api.example.com",
      }),
    ) as unknown as typeof fetch;
    const cfg = await loadAppConfig("https://api.example.com/", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/app-config", expect.objectContaining({ signal: expect.anything() }));
    expect(cfg.arbitrumRpc).toEqual({ mainnet: "https://m/key", testnet: "https://t/key" });
    expect(cfg.withdrawFeeUsdc).toEqual({ mainnet: 1, testnet: 0 });
    expect(cfg.strategyApiBaseUrl).toBe("https://api.example.com");
  });

  it("defaults missing RPC fields to null", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const cfg = await loadAppConfig("https://api.example.com", fetchImpl);
    expect(cfg.arbitrumRpc).toEqual({ mainnet: null, testnet: null });
    expect(cfg.withdrawFeeUsdc).toEqual({ mainnet: null, testnet: null });
    expect(cfg.strategyApiBaseUrl).toBeNull();
  });

  it("throws on a non-ok response (so the caller keeps the empty config)", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, false, 503)) as unknown as typeof fetch;
    await expect(loadAppConfig("https://api.example.com", fetchImpl)).rejects.toThrow(/503/);
  });

  it("parses server-delivered geo when present", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ geo: { country: "US" } })) as unknown as typeof fetch;
    const cfg = await loadAppConfig("https://api.example.com", fetchImpl);
    expect(cfg.geo).toEqual({ country: "US" });
  });

  it("defaults geo to null when absent", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const cfg = await loadAppConfig("https://api.example.com", fetchImpl);
    expect(cfg.geo).toBeNull();
  });
});
