jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "x",
  setItemAsync: jest.fn(async () => {}),
  getItemAsync: jest.fn(async () => null),
}));
import * as SecureStore from "expo-secure-store";
import { useDeadManStore, DEADMAN_TTL_OPTIONS } from "./deadManStore";

describe("deadManStore", () => {
  beforeEach(() => useDeadManStore.setState({ enabled: false, ttlMinutes: 2 }));

  it("defaults to disabled, 2 min", () => {
    expect(useDeadManStore.getState().enabled).toBe(false);
    expect(useDeadManStore.getState().ttlMinutes).toBe(2);
  });

  it("persists enable + ttl", () => {
    useDeadManStore.getState().setEnabled(true);
    useDeadManStore.getState().setTtlMinutes(5);
    expect(useDeadManStore.getState().enabled).toBe(true);
    expect(useDeadManStore.getState().ttlMinutes).toBe(5);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("hypersolid.pref.deadman.enabled", "1", expect.anything());
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("hypersolid.pref.deadman.ttlMinutes", "5", expect.anything());
  });

  it("hydrates a persisted value and rejects an out-of-range ttl", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (k: string) =>
      k.endsWith("enabled") ? "1" : "9");
    await useDeadManStore.getState().hydrate();
    expect(useDeadManStore.getState().enabled).toBe(true);
    expect(DEADMAN_TTL_OPTIONS).toContain(useDeadManStore.getState().ttlMinutes);
    expect(useDeadManStore.getState().ttlMinutes).toBe(2); // 9 rejected → default
  });
});
