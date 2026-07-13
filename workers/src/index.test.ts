import { handle, upstreamHost, type Env } from "./index";

type FakeReq = { method: string; url: string; headers: { get(k: string): string | null }; text(): Promise<string> };
function req(o: { method?: string; url?: string; headers?: Record<string, string>; body?: string }): FakeReq {
  const h = o.headers ?? {};
  return {
    method: o.method ?? "GET",
    url: o.url ?? "https://worker.dev/",
    headers: { get: (k) => h[k.toLowerCase()] ?? null },
    text: async () => o.body ?? "",
  };
}
const env: Env = {};
const asReq = (r: FakeReq) => r as unknown as Request;

describe("upstreamHost", () => {
  it("defaults to mainnet and honors the testnet header + env overrides", () => {
    expect(upstreamHost(asReq(req({})), {})).toBe("api.hyperliquid.xyz");
    expect(upstreamHost(asReq(req({ headers: { "x-hl-network": "testnet" } })), {})).toBe("api.hyperliquid-testnet.xyz");
    expect(upstreamHost(asReq(req({})), { HL_MAINNET_HOST: "m.example" })).toBe("m.example");
  });
});

describe("handle", () => {
  it("forwards POST /info to the mainnet upstream with the body and CORS", async () => {
    const fetchImpl = jest.fn(async () => new Response('{"ok":1}', { status: 200 }));
    const res = await handle(
      asReq(req({ method: "POST", url: "https://w.dev/info", headers: { "content-type": "application/json" }, body: '{"type":"meta"}' })),
      env,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledWith("https://api.hyperliquid.xyz/info", expect.objectContaining({ method: "POST", body: '{"type":"meta"}' }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("routes the testnet header to the testnet upstream", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 200 }));
    await handle(asReq(req({ method: "POST", url: "https://w.dev/info", headers: { "x-hl-network": "testnet" }, body: "{}" })), env, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.hyperliquid-testnet.xyz/info", expect.anything());
  });

  it("answers OPTIONS preflight with 204 + CORS", async () => {
    const res = await handle(asReq(req({ method: "OPTIONS", url: "https://w.dev/info" })), env, (async () => new Response()) as unknown as typeof fetch);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("proxies a /ws upgrade to the upstream ws", async () => {
    const fetchImpl = jest.fn(async () => ({ status: 101 }) as unknown as Response);
    await handle(asReq(req({ method: "GET", url: "https://w.dev/ws", headers: { upgrade: "websocket" } })), env, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.hyperliquid.xyz/ws", expect.anything());
  });

  it("404s a websocket upgrade to a non-/ws path, GET /, and POST /exchange", async () => {
    const fetchImpl = jest.fn(async () => new Response());
    expect((await handle(asReq(req({ method: "GET", url: "https://w.dev/nope", headers: { upgrade: "websocket" } })), env, fetchImpl as unknown as typeof fetch)).status).toBe(404);
    expect((await handle(asReq(req({ method: "GET", url: "https://w.dev/" })), env, fetchImpl as unknown as typeof fetch)).status).toBe(404);
    expect((await handle(asReq(req({ method: "POST", url: "https://w.dev/exchange", body: "{}" })), env, fetchImpl as unknown as typeof fetch)).status).toBe(404);
  });
});
