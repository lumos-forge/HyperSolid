import { useAuthStore } from "./authStore";

beforeEach(() => useAuthStore.setState({ status: "unknown", lastActiveAt: 0 }));

describe("authStore", () => {
  it("evaluate -> noWallet when no wallet persisted", async () => {
    await useAuthStore.getState().evaluate(async () => false);
    expect(useAuthStore.getState().status).toBe("noWallet");
  });

  it("evaluate -> locked when a wallet exists", async () => {
    await useAuthStore.getState().evaluate(async () => true);
    expect(useAuthStore.getState().status).toBe("locked");
  });

  it("evaluate fails closed to locked when the existence check throws", async () => {
    await useAuthStore.getState().evaluate(async () => {
      throw new Error("keychain error");
    });
    expect(useAuthStore.getState().status).toBe("locked");
  });

  it("unlock sets status to unlocked and stamps lastActiveAt", () => {
    useAuthStore.getState().unlock();
    expect(useAuthStore.getState().status).toBe("unlocked");
    expect(useAuthStore.getState().lastActiveAt).toBeGreaterThan(0);
  });

  it("lock returns to locked", () => {
    useAuthStore.getState().unlock();
    useAuthStore.getState().lock();
    expect(useAuthStore.getState().status).toBe("locked");
  });
});
