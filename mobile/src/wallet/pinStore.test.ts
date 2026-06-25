const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
}));

import { PinStore, MAX_PIN_ATTEMPTS } from "./pinStore";

describe("PinStore", () => {
  beforeEach(() => mockStore.clear());
  const store = () => new PinStore(1000); // low KDF iterations for fast tests

  it("starts with no PIN", async () => {
    expect(await store().hasPin()).toBe(false);
  });

  it("sets a PIN and verifies it", async () => {
    const s = store();
    await s.setPin("123456");
    expect(await s.hasPin()).toBe(true);
    expect(await s.verify("123456")).toEqual({ ok: true });
  });

  it("counts down remaining attempts on wrong PINs, then locks out", async () => {
    const s = store();
    await s.setPin("123456");
    for (let i = 1; i < MAX_PIN_ATTEMPTS; i++) {
      expect(await s.verify("000000")).toEqual({ ok: false, lockedOut: false, remaining: MAX_PIN_ATTEMPTS - i });
    }
    // the final wrong attempt locks out
    expect(await s.verify("000000")).toEqual({ ok: false, lockedOut: true });
    // further attempts (even correct) stay locked out until clear()
    expect(await s.verify("123456")).toEqual({ ok: false, lockedOut: true });
  });

  it("resets the attempt counter after a correct PIN", async () => {
    const s = store();
    await s.setPin("123456");
    await s.verify("000000");
    await s.verify("000000");
    expect(await s.verify("123456")).toEqual({ ok: true });
    // counter was reset → a fresh wrong attempt shows full-1 remaining
    expect(await s.verify("000000")).toEqual({ ok: false, lockedOut: false, remaining: MAX_PIN_ATTEMPTS - 1 });
  });

  it("clear() removes the PIN and the attempt counter", async () => {
    const s = store();
    await s.setPin("123456");
    await s.clear();
    expect(await s.hasPin()).toBe(false);
    expect(await s.verify("123456")).toEqual({ ok: false, lockedOut: false, remaining: MAX_PIN_ATTEMPTS });
  });
});
