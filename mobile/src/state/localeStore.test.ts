import { act, renderHook } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { useLocaleStore } from "./localeStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

describe("localeStore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    act(() => useLocaleStore.setState({ locale: "en" }));
  });

  it("defaults to en", () => {
    expect(useLocaleStore.getState().locale).toBe("en");
  });

  it("setLocale sets and persists the locale", () => {
    setItem.mockResolvedValue(undefined);
    act(() => useLocaleStore.getState().setLocale("zh"));
    expect(useLocaleStore.getState().locale).toBe("zh");
    expect(setItem).toHaveBeenCalledWith("hypersolid.pref.locale", "zh", expect.anything());
  });

  it("toggleLocale flips en<->zh", () => {
    const { result } = renderHook(() => useLocaleStore((s) => s.locale));
    act(() => useLocaleStore.getState().toggleLocale());
    expect(result.current).toBe("zh");
    act(() => useLocaleStore.getState().toggleLocale());
    expect(result.current).toBe("en");
  });

  it("hydrates a persisted locale", async () => {
    getItem.mockResolvedValue("zh");
    await useLocaleStore.getState().hydrate();
    expect(useLocaleStore.getState().locale).toBe("zh");
  });

  it("keeps the default when nothing (or an invalid value) is persisted", async () => {
    getItem.mockResolvedValue("bogus");
    await useLocaleStore.getState().hydrate();
    expect(useLocaleStore.getState().locale).toBe("en");
  });
});
