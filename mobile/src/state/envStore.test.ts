import * as SecureStore from "expo-secure-store";
import { useEnvStore } from "./envStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

describe("envStore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useEnvStore.setState({ network: "mainnet" });
  });

  it("defaults to mainnet", () => {
    expect(useEnvStore.getState().network).toBe("mainnet");
  });

  it("toggles to testnet and back, persisting each change", () => {
    setItem.mockResolvedValue(undefined);
    useEnvStore.getState().toggleNetwork();
    expect(useEnvStore.getState().network).toBe("testnet");
    expect(setItem).toHaveBeenCalledWith("hypersolid.pref.network", "testnet", expect.anything());
    useEnvStore.getState().toggleNetwork();
    expect(useEnvStore.getState().network).toBe("mainnet");
  });

  it("sets network explicitly and persists it", () => {
    setItem.mockResolvedValue(undefined);
    useEnvStore.getState().setNetwork("testnet");
    expect(useEnvStore.getState().network).toBe("testnet");
    expect(setItem).toHaveBeenCalledWith("hypersolid.pref.network", "testnet", expect.anything());
  });

  it("hydrates a persisted testnet selection (survives restart)", async () => {
    getItem.mockResolvedValue("testnet");
    await useEnvStore.getState().hydrate();
    expect(useEnvStore.getState().network).toBe("testnet");
  });

  it("keeps mainnet default when nothing or an invalid value is persisted", async () => {
    getItem.mockResolvedValue(null);
    await useEnvStore.getState().hydrate();
    expect(useEnvStore.getState().network).toBe("mainnet");
    getItem.mockResolvedValue("bogus");
    await useEnvStore.getState().hydrate();
    expect(useEnvStore.getState().network).toBe("mainnet");
  });
});
