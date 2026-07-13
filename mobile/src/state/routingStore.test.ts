import { act } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { useRoutingStore } from "./routingStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

describe("routingStore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    act(() => useRoutingStore.setState({ mode: "auto" }));
  });

  it("defaults to auto", () => {
    expect(useRoutingStore.getState().mode).toBe("auto");
  });

  it("setMode sets and persists the mode", () => {
    setItem.mockResolvedValue(undefined);
    act(() => useRoutingStore.getState().setMode("proxy"));
    expect(useRoutingStore.getState().mode).toBe("proxy");
    expect(setItem).toHaveBeenCalledWith("hypersolid.pref.routing", "proxy", expect.anything());
  });

  it("hydrates a persisted mode", async () => {
    getItem.mockResolvedValue("direct");
    await useRoutingStore.getState().hydrate();
    expect(useRoutingStore.getState().mode).toBe("direct");
  });

  it("keeps the default when an invalid value is persisted", async () => {
    getItem.mockResolvedValue("bogus");
    await useRoutingStore.getState().hydrate();
    expect(useRoutingStore.getState().mode).toBe("auto");
  });
});
