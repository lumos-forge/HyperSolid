import { resolveApiUrl } from "./resolveApiUrl";
import { resolveWsUrl } from "./resolveApiUrl";
import { markCooldown, _resetCooldowns } from "./proxyCooldown";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";

const POOL = ["https://p0.example", "https://p1.example"];

beforeEach(() => {
  _resetCooldowns();
  useRoutingStore.setState({ mode: "auto" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("resolveApiUrl", () => {
  it("returns the direct base for read traffic in auto mode when proxy is not recommended", () => {
    expect(resolveApiUrl("mainnet", "readInfo")).toBe("https://api.hyperliquid.xyz");
  });
  it("returns a pool entry for read traffic in forced proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    expect(POOL).toContain(resolveApiUrl("mainnet", "readInfo"));
  });
  it("keeps signed exchange traffic direct even in proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    expect(resolveApiUrl("mainnet", "signedExchange")).toBe("https://api.hyperliquid.xyz");
  });
  it("uses the testnet base", () => {
    expect(resolveApiUrl("testnet", "readInfo")).toBe("https://api.hyperliquid-testnet.xyz");
  });
});

describe("resolveWsUrl", () => {
  it("returns the direct wss endpoint in auto mode when proxy is not recommended", () => {
    expect(resolveWsUrl("mainnet", "publicWs")).toBe("wss://api.hyperliquid.xyz/ws");
    expect(resolveWsUrl("testnet", "publicWs")).toBe("wss://api.hyperliquid-testnet.xyz/ws");
  });
  it("proxies public WS through the pool host in forced proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    const url = resolveWsUrl("mainnet", "publicWs");
    expect(url.startsWith("wss://")).toBe(true);
    expect(url.endsWith("/ws")).toBe(true);
    const host = url.slice("wss://".length, -"/ws".length);
    expect(POOL.map((p) => p.replace("https://", ""))).toContain(host);
  });
  it("keeps private WS direct even in proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    expect(resolveWsUrl("mainnet", "privateWs")).toBe("wss://api.hyperliquid.xyz/ws");
  });
});

describe("routing degrades a cooling proxy to direct", () => {
  it("resolveApiUrl falls back to direct when the chosen proxy is cooling", () => {
    useRoutingStore.setState({ mode: "proxy" });
    const proxy = resolveApiUrl("mainnet", "readInfo");
    expect(POOL).toContain(proxy);
    markCooldown(proxy);
    expect(resolveApiUrl("mainnet", "readInfo")).toBe("https://api.hyperliquid.xyz");
  });
  it("resolveWsUrl falls back to the direct wss when the chosen proxy is cooling", () => {
    useRoutingStore.setState({ mode: "proxy" });
    const proxyWs = resolveWsUrl("mainnet", "publicWs");
    const proxyBase = proxyWs.replace(/^wss/, "https").replace(/\/ws$/, "");
    markCooldown(proxyBase);
    expect(resolveWsUrl("mainnet", "publicWs")).toBe("wss://api.hyperliquid.xyz/ws");
  });
});
