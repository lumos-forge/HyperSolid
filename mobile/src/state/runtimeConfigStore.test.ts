import { useRuntimeConfigStore, arbitrumRpcFor, withdrawFeeFor, DEFAULT_WITHDRAW_FEE_USDC } from "./runtimeConfigStore";

describe("runtimeConfigStore", () => {
  beforeEach(() => {
    useRuntimeConfigStore.setState({
      arbitrumRpc: { mainnet: null, testnet: null },
      withdrawFeeUsdc: { mainnet: null, testnet: null },
    });
  });

  it("starts empty (nothing delivered yet)", () => {
    expect(arbitrumRpcFor("mainnet")).toBeNull();
    expect(arbitrumRpcFor("testnet")).toBeNull();
  });

  it("exposes the server-delivered RPC per network", () => {
    useRuntimeConfigStore.getState().setConfig({
      arbitrumRpc: { mainnet: "https://rpc.mainnet/key", testnet: "https://rpc.testnet/key" },
      withdrawFeeUsdc: { mainnet: null, testnet: null },
      strategyApiBaseUrl: null,
      geo: null,
    });
    expect(arbitrumRpcFor("mainnet")).toBe("https://rpc.mainnet/key");
    expect(arbitrumRpcFor("testnet")).toBe("https://rpc.testnet/key");
  });

  it("falls back to the default withdraw fee until the server delivers one", () => {
    expect(withdrawFeeFor("mainnet")).toBe(DEFAULT_WITHDRAW_FEE_USDC);
    useRuntimeConfigStore.getState().setConfig({
      arbitrumRpc: { mainnet: null, testnet: null },
      withdrawFeeUsdc: { mainnet: 2.5, testnet: null },
      strategyApiBaseUrl: null,
      geo: null,
    });
    expect(withdrawFeeFor("mainnet")).toBe(2.5);
    expect(withdrawFeeFor("testnet")).toBe(DEFAULT_WITHDRAW_FEE_USDC);
  });

  it("exposes the server-delivered strategy API base URL", () => {
    expect(useRuntimeConfigStore.getState().strategyApiBaseUrl).toBeNull();
    useRuntimeConfigStore.getState().setConfig({
      arbitrumRpc: { mainnet: null, testnet: null },
      withdrawFeeUsdc: { mainnet: null, testnet: null },
      strategyApiBaseUrl: "https://api.example.com",
      geo: null,
    });
    expect(useRuntimeConfigStore.getState().strategyApiBaseUrl).toBe("https://api.example.com");
  });
});
