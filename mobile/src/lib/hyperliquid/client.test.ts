import { HttpTransport } from "@nktkas/hyperliquid";
import { WebSocketTransport } from "@nktkas/hyperliquid";
import { InfoClient } from "@nktkas/hyperliquid";
import { createInfoClient, createExchangeClient } from "./client";
import { createSubsClient, createTwapSubsClient } from "./client";
import { RoutingHttpTransport } from "./routingHttpTransport";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";

jest.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: jest.fn(function () {}),
  WebSocketTransport: jest.fn(function () {}),
  InfoClient: jest.fn(function () {}),
  ExchangeClient: jest.fn(function () {}),
  SubscriptionClient: jest.fn(function () {}),
}));

const POOL = ["https://p0.example", "https://p1.example"];
const httpMock = HttpTransport as unknown as jest.Mock;

beforeEach(() => {
  httpMock.mockClear();
  useRoutingStore.setState({ mode: "proxy" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("client routing", () => {
  it("gives the info client a RoutingHttpTransport", () => {
    createInfoClient("mainnet");
    const cfg = (InfoClient as unknown as jest.Mock).mock.calls.at(-1)![0];
    expect(cfg.transport).toBeInstanceOf(RoutingHttpTransport);
  });
  it("keeps the exchange transport on the direct base", () => {
    createExchangeClient("mainnet", {});
    const opts = httpMock.mock.calls.at(-1)![0];
    expect(opts.apiUrl).toBe("https://api.hyperliquid.xyz");
  });
});

const wsMock = WebSocketTransport as unknown as jest.Mock;

describe("client WS routing", () => {
  it("routes public subscriptions through a proxy wss host in proxy mode", () => {
    wsMock.mockClear();
    createSubsClient("mainnet");
    const url: string = wsMock.mock.calls.at(-1)![0].url;
    expect(url.startsWith("wss://")).toBe(true);
    expect(url.endsWith("/ws")).toBe(true);
    const host = url.slice("wss://".length, -"/ws".length);
    expect(POOL.map((p) => p.replace("https://", ""))).toContain(host);
  });
  it("keeps the private twap subscription on the direct wss endpoint", () => {
    wsMock.mockClear();
    createTwapSubsClient("mainnet");
    expect(wsMock.mock.calls.at(-1)![0].url).toBe("wss://api.hyperliquid.xyz/ws");
  });
});
