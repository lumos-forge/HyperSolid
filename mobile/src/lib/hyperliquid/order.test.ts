import {
  roundSize,
  stripTrailingZeros,
  formatPrice,
  validateOrder,
  rejectionMessage,
} from "./order";

describe("roundSize", () => {
  it("rounds to szDecimals", () => {
    expect(roundSize(1.23456789, 5)).toBe(1.23457);
    expect(roundSize(1.23456789, 2)).toBe(1.23);
  });
});

describe("stripTrailingZeros", () => {
  it("removes trailing zeros and dangling dot", () => {
    expect(stripTrailingZeros("1.2300")).toBe("1.23");
    expect(stripTrailingZeros("100.000")).toBe("100");
    expect(stripTrailingZeros("100")).toBe("100");
  });
});

describe("formatPrice", () => {
  it("allows integer prices verbatim", () => {
    expect(formatPrice(123456, 5)).toBe("123456");
  });
  it("limits to ≤5 significant figures", () => {
    // szDecimals 0 -> maxDecimals 6; 5 sig figs binds
    expect(formatPrice(1.234567, 0)).toBe("1.2346");
  });
  it("respects perp max decimals = 6 - szDecimals", () => {
    // szDecimals 5 -> maxDecimals 1
    expect(formatPrice(0.123456, 5)).toBe("0.1");
  });
  it("strips trailing zeros", () => {
    expect(formatPrice(2.5, 4)).toBe("2.5");
  });
  it("uses spot max decimals = 8 - szDecimals", () => {
    // spot, szDecimals 5 -> maxDecimals 3; 5 sig figs not binding here
    expect(formatPrice(0.123456, 5, "spot")).toBe("0.123");
  });
  it("spot still caps at 5 significant figures", () => {
    // spot, szDecimals 0 -> maxDecimals 8, but 5 sig figs binds
    expect(formatPrice(1.234567, 0, "spot")).toBe("1.2346");
  });
  it("clamps max decimals to 0 when szDecimals >= base", () => {
    // perp, szDecimals 6 -> maxDecimals 0 -> rounds to integer-ish
    expect(formatPrice(1.49, 6)).toBe("1");
    // spot, szDecimals 8 -> maxDecimals 0
    expect(formatPrice(2.6, 8, "spot")).toBe("3");
  });
});

describe("validateOrder", () => {
  const sz = 5;
  it("accepts a valid order", () => {
    expect(validateOrder({ price: 60000, size: 0.001, szDecimals: sz })).toBeNull();
  });
  it("rejects notional below $10", () => {
    expect(validateOrder({ price: 100, size: 0.05, szDecimals: sz })).toBe("minTradeNtlRejected");
  });
  it("rejects non-positive price/size", () => {
    expect(validateOrder({ price: 0, size: 1, szDecimals: sz })).toBe("priceRejected");
    expect(validateOrder({ price: 100, size: 0, szDecimals: sz })).toBe("sizeRejected");
  });
  it("rejects size that rounds to zero at lot precision", () => {
    expect(validateOrder({ price: 100000, size: 0.0000001, szDecimals: 2 })).toBe("sizeRejected");
  });
});

describe("rejectionMessage", () => {
  it("maps known codes to Chinese", () => {
    expect(rejectionMessage("minTradeNtlRejected")).toMatch(/\$10/);
    expect(rejectionMessage("badAloPxRejected")).toMatch(/ALO/);
  });
  it("falls back for unknown codes", () => {
    expect(rejectionMessage("weirdCode")).toMatch(/weirdCode/);
  });
});
