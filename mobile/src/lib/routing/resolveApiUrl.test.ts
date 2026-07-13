import { resolveApiUrl } from "./resolveApiUrl";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";

const POOL = ["https://p0.example", "https://p1.example"];

beforeEach(() => {
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
