import { conditionalTriggered } from "./conditional";
import type { ConditionalParams } from "./types";

const P = (over: Partial<ConditionalParams> = {}): ConditionalParams => ({
  coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 100, triggerDirection: "above", ...over,
});

describe("conditionalTriggered", () => {
  it("above: fires at/above the trigger price, not below", () => {
    expect(conditionalTriggered(P({ triggerDirection: "above" }), 100)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "above" }), 101)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "above" }), 99)).toBe(false);
  });

  it("below: fires at/below the trigger price, not above", () => {
    expect(conditionalTriggered(P({ triggerDirection: "below" }), 100)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "below" }), 99)).toBe(true);
    expect(conditionalTriggered(P({ triggerDirection: "below" }), 101)).toBe(false);
  });
});
