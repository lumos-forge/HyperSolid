import * as SecureStore from "expo-secure-store";
import { usePushPrefsStore } from "./pushPrefsStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;
const delItem = SecureStore.deleteItemAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  usePushPrefsStore.setState({ enabled: false, token: null, hydrated: false });
});

describe("pushPrefsStore", () => {
  it("hydrates enabled + token from storage", async () => {
    getItem.mockImplementation(async (k: string) =>
      k === "hypersolid.push.enabled" ? "1" : "ExponentPushToken[t]");
    await usePushPrefsStore.getState().hydrate();
    const s = usePushPrefsStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.token).toBe("ExponentPushToken[t]");
    expect(s.hydrated).toBe(true);
  });

  it("hydrates disabled/null when nothing persisted", async () => {
    getItem.mockResolvedValue(null);
    await usePushPrefsStore.getState().hydrate();
    const s = usePushPrefsStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.token).toBeNull();
    expect(s.hydrated).toBe(true);
  });

  it("setEnabled updates state and persists", async () => {
    await usePushPrefsStore.getState().setEnabled(true);
    expect(usePushPrefsStore.getState().enabled).toBe(true);
    expect(setItem).toHaveBeenCalledWith("hypersolid.push.enabled", "1", expect.anything());
  });

  it("setToken persists a value and deletes on null", async () => {
    await usePushPrefsStore.getState().setToken("ExponentPushToken[t]");
    expect(usePushPrefsStore.getState().token).toBe("ExponentPushToken[t]");
    expect(setItem).toHaveBeenCalledWith("hypersolid.push.token", "ExponentPushToken[t]", expect.anything());
    await usePushPrefsStore.getState().setToken(null);
    expect(usePushPrefsStore.getState().token).toBeNull();
    expect(delItem).toHaveBeenCalledWith("hypersolid.push.token");
  });

  it("does not throw when SecureStore rejects (best-effort)", async () => {
    setItem.mockRejectedValue(new Error("keychain"));
    await expect(usePushPrefsStore.getState().setEnabled(true)).resolves.toBeUndefined();
    expect(usePushPrefsStore.getState().enabled).toBe(true);
  });
});
