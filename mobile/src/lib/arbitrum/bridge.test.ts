import { MIN_DEPOSIT_USDC, validateDeposit } from "./deposit";
import { bridgeConstants, usdcToBaseUnits } from "./bridge";

describe("bridgeConstants", () => {
  it("returns the verified mainnet Bridge2 + native USDC (Arbitrum One)", () => {
    const c = bridgeConstants("mainnet");
    expect(c.chainId).toBe(42161);
    expect(c.bridge).toBe("0x2df1c51e09aecf9cacb7bc98cb1742757f163df7");
    expect(c.usdc).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  });

  it("returns the verified testnet Bridge2 + USDC (Arbitrum Sepolia)", () => {
    const c = bridgeConstants("testnet");
    expect(c.chainId).toBe(421614);
    expect(c.bridge).toBe("0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89");
    expect(c.usdc).toBe("0x1baAbB04529D43a73232B713C0FE471f7c7334d5");
  });
});

describe("usdcToBaseUnits", () => {
  it("scales USDC to 6-decimal base units", () => {
    expect(usdcToBaseUnits(5)).toBe(5_000_000n);
    expect(usdcToBaseUnits(25.5)).toBe(25_500_000n);
    expect(usdcToBaseUnits(MIN_DEPOSIT_USDC)).toBe(5_000_000n);
  });
});

describe("validateDeposit (re-exported guard)", () => {
  it("enforces the 5 USDC minimum", () => {
    expect(validateDeposit({ amount: 4.99 }).ok).toBe(false);
    expect(validateDeposit({ amount: 5 }).ok).toBe(true);
  });
});
