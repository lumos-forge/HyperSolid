import {
  orderTypeShape,
  toBaseSize,
  requiredMargin,
  buildScaleLevels,
  clampSizeInput,
  TAKER_FEE_RATE,
  MAKER_FEE_RATE,
  marketSlippagePrice,
  type TicketOrderType,
} from "./orderForm";

describe("clampSizeInput", () => {
  it("caps fractional digits to maxDecimals", () => {
    expect(clampSizeInput("0.123456789", 5)).toBe("0.12345");
    expect(clampSizeInput("12.349", 2)).toBe("12.34");
  });
  it("integer-only when maxDecimals is 0", () => {
    expect(clampSizeInput("12.34", 0)).toBe("12");
  });
  it("strips non-numeric chars and extra dots, keeps a trailing dot", () => {
    expect(clampSizeInput("1a2.b3", 4)).toBe("12.3");
    expect(clampSizeInput("1.2.3", 4)).toBe("1.23");
    expect(clampSizeInput("0.", 5)).toBe("0.");
    expect(clampSizeInput("", 5)).toBe("");
  });
});

describe("orderTypeShape", () => {
  const cases: Array<[TicketOrderType, boolean, boolean, boolean, "tp" | "sl"]> = [
    ["market", false, false, false, "sl"],
    ["limit", false, false, true, "sl"],
    ["stopLimit", true, false, true, "sl"],
    ["stopMarket", true, true, false, "sl"],
    ["tpLimit", true, false, true, "tp"],
    ["tpMarket", true, true, false, "tp"],
  ];
  it.each(cases)("%s → trigger/triggerMarket/limitPrice/tpsl", (type, isTrigger, triggerIsMarket, usesLimitPrice, tpsl) => {
    expect(orderTypeShape(type)).toEqual({ isTrigger, triggerIsMarket, usesLimitPrice, tpsl });
  });
});

describe("toBaseSize", () => {
  it("returns the value as-is for base units", () => {
    expect(toBaseSize("base", 0.5, 60000)).toBe(0.5);
  });
  it("divides by price for quote (USDC) units", () => {
    expect(toBaseSize("quote", 6000, 60000)).toBe(0.1);
  });
  it("guards zero/negative value and price", () => {
    expect(toBaseSize("quote", 6000, 0)).toBe(0);
    expect(toBaseSize("base", 0, 60000)).toBe(0);
    expect(toBaseSize("quote", -5, 60000)).toBe(0);
  });
});

describe("requiredMargin", () => {
  it("is notional / leverage", () => {
    expect(requiredMargin(1000, 10)).toBe(100);
    expect(requiredMargin(1000, 0)).toBe(0);
  });
});

describe("buildScaleLevels", () => {
  it("returns evenly-spaced prices inclusive of both ends", () => {
    expect(buildScaleLevels(100, 110, 3)).toEqual([100, 105, 110]);
    expect(buildScaleLevels(60000, 61000, 5)).toEqual([60000, 60250, 60500, 60750, 61000]);
  });
  it("descends when start > end", () => {
    expect(buildScaleLevels(110, 100, 3)).toEqual([110, 105, 100]);
  });
  it("returns a single price for count 1", () => {
    expect(buildScaleLevels(100, 110, 1)).toEqual([100]);
  });
});

describe("fee rates", () => {
  it("match the HL base perp tier", () => {
    expect(TAKER_FEE_RATE).toBeCloseTo(0.00045);
    expect(MAKER_FEE_RATE).toBeCloseTo(0.00015);
  });
});

describe("marketSlippagePrice", () => {
  it("bounds a buy above mid by the slippage pct", () => {
    expect(marketSlippagePrice(100, "buy", 0.05)).toBeCloseTo(105);
  });
  it("bounds a sell below mid by the slippage pct", () => {
    expect(marketSlippagePrice(100, "sell", 0.05)).toBeCloseTo(95);
  });
  it("defaults to a 5% cap", () => {
    expect(marketSlippagePrice(200, "buy")).toBeCloseTo(210);
  });
});
