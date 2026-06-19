import { useEnvStore } from "./envStore";

describe("envStore", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
  });

  it("defaults to mainnet", () => {
    expect(useEnvStore.getState().network).toBe("mainnet");
  });

  it("toggles to testnet and back", () => {
    useEnvStore.getState().toggleNetwork();
    expect(useEnvStore.getState().network).toBe("testnet");
    useEnvStore.getState().toggleNetwork();
    expect(useEnvStore.getState().network).toBe("mainnet");
  });

  it("sets network explicitly", () => {
    useEnvStore.getState().setNetwork("testnet");
    expect(useEnvStore.getState().network).toBe("testnet");
  });
});
