import { HttpTransport } from "@nktkas/hyperliquid";
import { RoutingHttpTransport, isProxyFailure } from "./routingHttpTransport";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";
import { isCoolingDown, _resetCooldowns } from "../routing/proxyCooldown";

const POOL = ["https://p0.example", "https://p1.example"];
const DIRECT = "https://api.hyperliquid.xyz";

jest.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: jest.fn().mockImplementation((opts) => ({
    isTestnet: opts.isTestnet,
    apiUrl: opts.apiUrl,
    request: jest.fn(async () => {
      if (opts.apiUrl === "https://api.hyperliquid.xyz") return { ok: "direct" };
      const err = new Error("429") as Error & { response?: { status: number } };
      err.response = { status: 429 };
      throw err;
    }),
  })),
}));

beforeEach(() => {
  (HttpTransport as unknown as jest.Mock).mockClear();
  _resetCooldowns();
  useRoutingStore.setState({ mode: "proxy" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("isProxyFailure", () => {
  it("flags 429 and gateway 5xx and connection errors, not normal HL errors", () => {
    expect(isProxyFailure({ response: { status: 429 } })).toBe(true);
    expect(isProxyFailure({ response: { status: 503 } })).toBe(true);
    expect(isProxyFailure(new Error("timeout"))).toBe(true);
    expect(isProxyFailure({ response: { status: 400 } })).toBe(false);
    expect(isProxyFailure({ response: { status: 422 } })).toBe(false);
  });
});

describe("RoutingHttpTransport", () => {
  it("on a proxy 429, cools the proxy and retries direct", async () => {
    const t = new RoutingHttpTransport("mainnet", "readInfo");
    const res = await t.request("info", { type: "meta" });
    expect(res).toEqual({ ok: "direct" });
    const proxyTried = (HttpTransport as unknown as jest.Mock).mock.calls[0][0].apiUrl;
    expect(POOL).toContain(proxyTried);
    expect(isCoolingDown(proxyTried, Date.now())).toBe(true);
    const second = (HttpTransport as unknown as jest.Mock).mock.calls[1][0].apiUrl;
    expect(second).toBe(DIRECT);
  });

  it("rethrows a non-proxy (business) error without cooldown or retry", async () => {
    (HttpTransport as unknown as jest.Mock).mockImplementationOnce((opts) => ({
      isTestnet: opts.isTestnet,
      apiUrl: opts.apiUrl,
      request: jest.fn(async () => {
        const e = new Error("bad") as Error & { response?: { status: number } };
        e.response = { status: 400 };
        throw e;
      }),
    }));
    const t = new RoutingHttpTransport("mainnet", "readInfo");
    await expect(t.request("info", {})).rejects.toThrow("bad");
    expect((HttpTransport as unknown as jest.Mock).mock.calls.length).toBe(1);
  });
});
