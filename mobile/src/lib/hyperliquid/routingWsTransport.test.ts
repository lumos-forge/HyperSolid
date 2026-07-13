import { WebSocketTransport } from "@nktkas/hyperliquid";
import { RoutingWsTransport, wsToHttpBase } from "./routingWsTransport";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";
import { isCoolingDown, _resetCooldowns } from "../routing/proxyCooldown";

const POOL = ["https://p0.example", "https://p1.example"];
const controllers: AbortController[] = [];

jest.mock("@nktkas/hyperliquid", () => ({
  WebSocketTransport: jest.fn().mockImplementation((opts) => ({
    isTestnet: opts.isTestnet,
    url: opts.url,
    subscribe: jest.fn(async () => {
      const ac = new AbortController();
      controllers.push(ac);
      return { unsubscribe: async () => {}, failureSignal: ac.signal };
    }),
  })),
}));
const wsMock = WebSocketTransport as unknown as jest.Mock;

beforeEach(() => {
  wsMock.mockClear();
  controllers.length = 0;
  _resetCooldowns();
  useRoutingStore.setState({ mode: "proxy" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("wsToHttpBase", () => {
  it("maps a wss endpoint to the http cooldown key", () => {
    expect(wsToHttpBase("wss://p0.example/ws")).toBe("https://p0.example");
  });
});

describe("RoutingWsTransport", () => {
  it("cools the proxy when a proxied subscription fails", async () => {
    const t = new RoutingWsTransport("mainnet", "publicWs");
    await t.subscribe("allMids", {}, () => {});
    const wsUrl: string = wsMock.mock.calls[0][0].url;
    expect(wsUrl.startsWith("wss://")).toBe(true);
    controllers[controllers.length - 1].abort();
    expect(isCoolingDown(wsToHttpBase(wsUrl), Date.now())).toBe(true);
  });

  it("does not cool a private (always-direct) subscription", async () => {
    const t = new RoutingWsTransport("mainnet", "privateWs");
    await t.subscribe("userTwapSliceFills", {}, () => {});
    const wsUrl: string = wsMock.mock.calls[0][0].url;
    expect(wsUrl).toBe("wss://api.hyperliquid.xyz/ws");
    controllers[controllers.length - 1].abort();
    expect(isCoolingDown(wsToHttpBase(wsUrl), Date.now())).toBe(false);
  });
});
