import { withAlpha } from "./color";

describe("withAlpha", () => {
  it("appends a two-digit alpha to a hex color", () => {
    expect(withAlpha("#FFB454", 0.12)).toBe("#FFB4541f");
  });

  it("returns full opacity for alpha 1", () => {
    expect(withAlpha("#34C98B", 1)).toBe("#34C98Bff");
  });

  it("returns zero opacity for alpha 0", () => {
    expect(withAlpha("#000000", 0)).toBe("#00000000");
  });

  it("clamps out-of-range alpha", () => {
    expect(withAlpha("#FFFFFF", 5)).toBe("#FFFFFFff");
    expect(withAlpha("#FFFFFF", -1)).toBe("#FFFFFF00");
  });
});
