import { HttpTransport } from "@nktkas/hyperliquid";
import { createInfoClient, createExchangeClient } from "./client";
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
  it("builds the info transport with a proxy apiUrl in proxy mode", () => {
    createInfoClient("mainnet");
    const opts = httpMock.mock.calls.at(-1)![0];
    expect(POOL).toContain(opts.apiUrl);
  });
  it("keeps the exchange transport on the direct base", () => {
    createExchangeClient("mainnet", {});
    const opts = httpMock.mock.calls.at(-1)![0];
    expect(opts.apiUrl).toBe("https://api.hyperliquid.xyz");
  });
});
