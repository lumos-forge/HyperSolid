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

  it("throws on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => res({}, false, 401)) as unknown as typeof fetch;
    const api = new StrategyApi("https://api", "tok", fetchImpl);
    await expect(api.listStrategies()).rejects.toThrow(/401/);
  });
});
