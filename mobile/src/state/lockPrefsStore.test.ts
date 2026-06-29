import * as SecureStore from "expo-secure-store";
import { useLockPrefsStore } from "./lockPrefsStore";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useLockPrefsStore.setState({ biometricEnabled: false, autoLockMinutes: 5, hydrated: false });
});

describe("lockPrefsStore", () => {
  it("hydrates enabled from a persisted '1'", async () => {
    getItem.mockResolvedValue("1");
    await useLockPrefsStore.getState().hydrate();
    expect(useLockPrefsStore.getState().biometricEnabled).toBe(true);
    expect(useLockPrefsStore.getState().hydrated).toBe(true);
  });

  it("hydrates disabled when nothing persisted", async () => {
    getItem.mockResolvedValue(null);
    await useLockPrefsStore.getState().hydrate();
    expect(useLockPrefsStore.getState().biometricEnabled).toBe(false);
    expect(useLockPrefsStore.getState().hydrated).toBe(true);
  });

  it("marks hydrated even when the read throws", async () => {
    getItem.mockRejectedValue(new Error("keychain"));
    await useLockPrefsStore.getState().hydrate();
    expect(useLockPrefsStore.getState().hydrated).toBe(true);
  });

  it("persists the choice and updates state immediately", async () => {
    setItem.mockResolvedValue(undefined);
    await useLockPrefsStore.getState().setBiometricEnabled(true);
    expect(useLockPrefsStore.getState().biometricEnabled).toBe(true);
    expect(setItem).toHaveBeenCalledWith("hypersolid.lock.biometricEnabled", "1", expect.anything());
  });

  it("hydrates the auto-lock timeout, defaulting to 5 minutes", async () => {
    getItem.mockImplementation(async (k: string) => (k === "hypersolid.lock.autoLockMinutes" ? "1" : null));
    await useLockPrefsStore.getState().hydrate();
    expect(useLockPrefsStore.getState().autoLockMinutes).toBe(1);
  });

  it("keeps the default timeout when none persisted", async () => {
    getItem.mockResolvedValue(null);
    await useLockPrefsStore.getState().hydrate();
    expect(useLockPrefsStore.getState().autoLockMinutes).toBe(5);
  });

  it("persists the auto-lock timeout", async () => {
    setItem.mockResolvedValue(undefined);
    await useLockPrefsStore.getState().setAutoLockMinutes(15);
    expect(useLockPrefsStore.getState().autoLockMinutes).toBe(15);
    expect(setItem).toHaveBeenCalledWith("hypersolid.lock.autoLockMinutes", "15", expect.anything());
  });
});
