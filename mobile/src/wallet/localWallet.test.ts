import { generateWalletMnemonic, isPrivateKey, secretToPrivateKey, LocalWalletService } from "./localWallet";

// Known test vector (BIP-39) — do NOT use for real funds.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Hardhat account #0 private key — derives the SAME address as TEST_MNEMONIC.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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

  it("derives the same address from the matching raw private key", () => {
    const w = new LocalWalletService(TEST_PK);
    expect(w.getAddress().toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("signs a message with an imported private key", async () => {
    const sig = await new LocalWalletService(TEST_PK).signMessage("hi");
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });
});

describe("isPrivateKey", () => {
  it("recognises a 0x 32-byte hex key (trimming whitespace)", () => {
    expect(isPrivateKey(TEST_PK)).toBe(true);
    expect(isPrivateKey(`  ${TEST_PK}  `)).toBe(true);
  });
  it("rejects mnemonics and malformed keys", () => {
    expect(isPrivateKey(TEST_MNEMONIC)).toBe(false);
    expect(isPrivateKey("0x1234")).toBe(false);
    expect(isPrivateKey(`${TEST_PK}ff`)).toBe(false);
    expect(isPrivateKey("0xZZ0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")).toBe(false);
  });
});

describe("secretToPrivateKey", () => {
  it("returns an imported key normalized to lowercase", () => {
    expect(secretToPrivateKey(`  ${TEST_PK.toUpperCase().replace("0X", "0x")}  `)).toBe(TEST_PK);
  });
  it("derives the same key the mnemonic's first account uses", () => {
    expect(secretToPrivateKey(TEST_MNEMONIC)).toBe(TEST_PK);
  });
});
