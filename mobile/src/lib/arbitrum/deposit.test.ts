import { MIN_DEPOSIT_USDC, validateDeposit } from "./deposit";

describe("validateDeposit", () => {
  it("rejects a non-positive amount", () => {
    expect(validateDeposit({ amount: 0 }).ok).toBe(false);
    expect(validateDeposit({ amount: -1 }).ok).toBe(false);
  });

  it("rejects below the 5 USDC minimum (would be lost)", () => {
    const r = validateDeposit({ amount: 4.99 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/5/);
  });

  it("rejects more than the wallet's available USDC", () => {
    expect(validateDeposit({ amount: 100, available: 50 }).ok).toBe(false);
  });

  it("accepts a valid at-or-above-minimum amount within balance", () => {
    expect(validateDeposit({ amount: MIN_DEPOSIT_USDC, available: 10 }).ok).toBe(true);
    expect(validateDeposit({ amount: 25 }).ok).toBe(true);
  });
});
