import { InMemoryKeyStore } from "./inMemoryKeyStore";
import { WalletManager } from "./walletManager";

describe("WalletManager (in-memory store)", () => {
  it("starts with no wallet", async () => {
    const mgr = new WalletManager(new InMemoryKeyStore());
    expect(await mgr.hasWallet()).toBe(false);
    expect(await mgr.loadWallet()).toBeNull();
  });

  it("creates, persists, and reloads the same wallet", async () => {
    const store = new InMemoryKeyStore();
    const mgr = new WalletManager(store);
    const { mnemonic, wallet } = await mgr.createWallet();
    expect(mnemonic.split(" ")).toHaveLength(12);
    expect(await mgr.hasWallet()).toBe(true);
    const reloaded = await mgr.loadWallet();
    expect(reloaded?.getAddress()).toBe(wallet.getAddress());
  });

  it("restores a wallet from a mnemonic", async () => {
    const mgr = new WalletManager(new InMemoryKeyStore());
    const m = "test test test test test test test test test test test junk";
    const w = await mgr.restoreWallet(m);
    expect(w.getAddress().toLowerCase()).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  it("imports a raw private key, persisting and reloading the same wallet", async () => {
    const mgr = new WalletManager(new InMemoryKeyStore());
    const w = await mgr.importPrivateKey("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(w.getAddress().toLowerCase()).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(await mgr.hasWallet()).toBe(true);
    expect((await mgr.loadWallet())?.getAddress()).toBe(w.getAddress());
  });

  it("rejects a malformed private key", async () => {
    const mgr = new WalletManager(new InMemoryKeyStore());
    await expect(mgr.importPrivateKey("0xnope")).rejects.toThrow();
    expect(await mgr.hasWallet()).toBe(false);
  });

  it("signOut clears the wallet", async () => {
    const mgr = new WalletManager(new InMemoryKeyStore());
    await mgr.createWallet();
    await mgr.signOut();
    expect(await mgr.hasWallet()).toBe(false);
  });

  it("exports the persisted mnemonic for backup, or null when absent", async () => {
    const mgr = new WalletManager(new InMemoryKeyStore());
    expect(await mgr.exportMnemonic()).toBeNull();
    const { mnemonic } = await mgr.createWallet();
    expect(await mgr.exportMnemonic()).toBe(mnemonic);
    await mgr.signOut();
    expect(await mgr.exportMnemonic()).toBeNull();
  });
});
