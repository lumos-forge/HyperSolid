import { unlockSession, lockSession } from "./sessionController";
import { useAuthStore } from "../state/authStore";
import { useWalletStore } from "../state/walletStore";
import { AlwaysTrustedIntegrity } from "./deviceIntegrity";
import type { WalletService } from "./types";

const fakeWallet = { getAddress: () => "0xabc" } as unknown as WalletService;
const trusted = new AlwaysTrustedIntegrity();
const compromised = { check: async () => "compromised" as const };
const unknown = { check: async () => "unknown" as const };

beforeEach(() => {
  useAuthStore.setState({ status: "locked", lastActiveAt: 0 });
  useWalletStore.setState({ mode: "none", wallet: null, address: null });
});

describe("sessionController", () => {
  it("refuses on a compromised device: no gate, no load, returns 'compromised'", async () => {
    const gate = { authenticate: jest.fn() };
    const manager = { loadWallet: jest.fn() };
    const r = await unlockSession(gate as never, manager as never, compromised as never);
    expect(r).toBe("compromised");
    expect(gate.authenticate).not.toHaveBeenCalled();
    expect(manager.loadWallet).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe("locked");
  });

  it("fails closed on 'unknown' integrity: blocks without prompting or loading", async () => {
    const gate = { authenticate: jest.fn() };
    const manager = { loadWallet: jest.fn() };
    const r = await unlockSession(gate as never, manager as never, unknown as never);
    expect(r).toBe("compromised");
    expect(gate.authenticate).not.toHaveBeenCalled();
    expect(manager.loadWallet).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe("locked");
  });

  it("on success loads wallet into store and unlocks", async () => {
    const gate = { authenticate: jest.fn().mockResolvedValue("success") };
    const manager = { loadWallet: jest.fn().mockResolvedValue(fakeWallet) };
    const r = await unlockSession(gate as never, manager as never, trusted);
    expect(r).toBe("success");
    expect(useWalletStore.getState().wallet).toBe(fakeWallet);
    expect(useAuthStore.getState().status).toBe("unlocked");
  });

  it("on failed auth keeps locked and loads nothing", async () => {
    const gate = { authenticate: jest.fn().mockResolvedValue("failed") };
    const manager = { loadWallet: jest.fn() };
    const r = await unlockSession(gate as never, manager as never, trusted);
    expect(r).toBe("failed");
    expect(manager.loadWallet).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe("locked");
  });

  it("lockSession clears in-memory wallet and locks", () => {
    useWalletStore.setState({ mode: "local", wallet: fakeWallet, address: "0xabc" });
    useAuthStore.setState({ status: "unlocked", lastActiveAt: 1 });
    lockSession();
    expect(useWalletStore.getState().wallet).toBeNull();
    expect(useAuthStore.getState().status).toBe("locked");
  });
});
