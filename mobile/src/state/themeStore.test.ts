import * as SecureStore from "expo-secure-store";
import { useThemeStore } from "./themeStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

describe("themeStore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useThemeStore.setState({ name: "electrum" });
  });

  it("defaults to electrum", () => {
    expect(useThemeStore.getState().name).toBe("electrum");
  });

  it("switches theme and persists the choice", () => {
    setItem.mockResolvedValue(undefined);
    useThemeStore.getState().setTheme("daylight");
    expect(useThemeStore.getState().name).toBe("daylight");
    expect(setItem).toHaveBeenCalledWith("hypersolid.pref.theme", "daylight", expect.anything());
  });

  it("hydrates a persisted theme", async () => {
    getItem.mockResolvedValue("oscilloscope");
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().name).toBe("oscilloscope");
  });

  it("keeps the default when nothing (or an invalid value) is persisted", async () => {
    getItem.mockResolvedValue(null);
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().name).toBe("electrum");
    getItem.mockResolvedValue("bogus");
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().name).toBe("electrum");
  });
});
