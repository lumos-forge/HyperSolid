import { generateCloid, deriveCloid, isValidCloid } from "./cloid";

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

describe("deriveCloid", () => {
  const primary = "0x0102030405060708090a0b0c0d0e0f10" as const;

  it("returns the primary unchanged for index 0", () => {
    expect(deriveCloid(primary, 0)).toBe(primary);
  });

  it("is deterministic for the same (primary, index) — survives retries", () => {
    expect(deriveCloid(primary, 1)).toBe(deriveCloid(primary, 1));
    expect(deriveCloid(primary, 7)).toBe(deriveCloid(primary, 7));
  });

  it("produces a valid, distinct cloid per leg index", () => {
    const ids = [0, 1, 2, 3, 300].map((i) => deriveCloid(primary, i));
    ids.forEach((c) => expect(isValidCloid(c)).toBe(true));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("differs across distinct primaries", () => {
    const other = "0xffeeddccbbaa99887766554433221100" as const;
    expect(deriveCloid(primary, 1)).not.toBe(deriveCloid(other, 1));
  });
});
