import { generateWalletMnemonic, LocalWalletService } from "./localWallet";

// Known test vector (BIP-39) — do NOT use for real funds.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("generateWalletMnemonic", () => {
  it("produces a 12-word mnemonic", () => {
    expect(generateWalletMnemonic().split(" ")).toHaveLength(12);
  });
  it("produces unique mnemonics", () => {
    expect(generateWalletMnemonic()).not.toBe(generateWalletMnemonic());
  });
});

describe("LocalWalletService", () => {
  it("derives a deterministic address from a known mnemonic", () => {
    const w = new LocalWalletService(TEST_MNEMONIC);
    expect(w.getAddress().toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("signs a message producing a 0x signature", async () => {
    const w = new LocalWalletService(TEST_MNEMONIC);
    const sig = await w.signMessage("hello hypersolid");
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("throws on an invalid mnemonic", () => {
    expect(() => new LocalWalletService("not a valid mnemonic phrase here")).toThrow();
  });
});
