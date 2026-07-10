import { StrategyApi } from "./strategyApi";

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("StrategyApi", () => {
  it("requests a challenge and exchanges a signature for a token", async () => {
    const fetchImpl = jest.fn(async () => res({ token: "jwt-123" })) as unknown as typeof fetch;
    const api = new StrategyApi("https://api/", null, fetchImpl);
    const out = await api.session("0xowner", "nonce-1", "0xsig");
    expect(out.token).toBe("jwt-123");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api/auth/session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends the bearer token and parses strategies", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res([{ id: "s1", type: "dca", params: {}, status: "running" }]));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const list = await api.listStrategies();
    expect(list).toHaveLength(1);
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("creates a DCA strategy with type + params in the body", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({ id: "s2", type: "dca", params: {}, status: "running" }));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.createStrategy("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ type: "dca", params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } });
  });

  it("creates a TWAP strategy", async () => {
    const fetchMock = jest.fn(async (_u: string, _i?: RequestInit) => res({ id: "s3", type: "twap", params: {}, status: "running" }));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.createStrategy("twap", { coin: "ETH", side: "sell", totalUsdc: 300, slices: 6, durationHours: 3 });
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string).type).toBe("twap");
  });

  it("creates a grid strategy", async () => {
    const fetchMock = jest.fn(async (_u: string, _i?: RequestInit) => res({ id: "s4", type: "grid", params: {}, status: "running" }));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.createStrategy("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 });
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ type: "grid", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 } });
  });

  it("fetches recent activity with a limit", async () => {
    const fetchMock = jest.fn(async (_u: string, _i?: RequestInit) => res([{ id: "a1", time: 1, coin: "BTC", side: "buy", sz: 0.1, px: 50000 }]));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const list = await api.getRecentActivity(25);
    expect(list).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("https://api/activity?limit=25", expect.objectContaining({ method: "GET" }));
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => res({}, false, 401)) as unknown as typeof fetch;
    const api = new StrategyApi("https://api", "tok", fetchImpl);
    await expect(api.listStrategies()).rejects.toThrow(/401/);
  });

  it("getRungs GETs the strategy rung ladder", async () => {
    const fetchMock = jest.fn(async (_u: string, _i?: RequestInit) => res([{ rung: 0, state: "armed", buyPrice: 100, sellPrice: 120 }]));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    const rungs = await api.getRungs("s1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api/strategies/s1/rungs");
    expect(rungs).toEqual([{ rung: 0, state: "armed", buyPrice: 100, sellPrice: 120 }]);
  });

  it("registers a push token with platform in the body", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({}));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.registerPush("ExponentPushToken[x]", "ios");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api/push/register",
      expect.objectContaining({ method: "POST" }),
    );
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ token: "ExponentPushToken[x]", platform: "ios" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("unregisters a push token", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => res({}));
    const api = new StrategyApi("https://api", "tok", fetchMock as unknown as typeof fetch);
    await api.unregisterPush("ExponentPushToken[x]");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api/push/unregister",
      expect.objectContaining({ method: "POST" }),
    );
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ token: "ExponentPushToken[x]" });
  });
});
