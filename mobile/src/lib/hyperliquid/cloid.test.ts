import { generateCloid, isValidCloid } from "./cloid";

describe("cloid", () => {
  it("generates a 0x + 32 hex (16-byte) id", () => {
    const c = generateCloid();
    expect(isValidCloid(c)).toBe(true);
  });

  it("generates unique ids", () => {
    const set = new Set(Array.from({ length: 100 }, () => generateCloid()));
    expect(set.size).toBe(100);
  });

  it("rejects malformed cloids", () => {
    expect(isValidCloid("0x123")).toBe(false);
    expect(isValidCloid("nope")).toBe(false);
    expect(isValidCloid("0x" + "g".repeat(32))).toBe(false);
  });
});
