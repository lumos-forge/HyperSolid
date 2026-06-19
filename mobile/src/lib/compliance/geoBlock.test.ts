import { isRestricted, restrictionReason, RESTRICTED_COUNTRIES } from "./geoBlock";

describe("geoBlock", () => {
  it("blocks restricted countries", () => {
    for (const c of RESTRICTED_COUNTRIES) {
      expect(isRestricted({ country: c })).toBe(true);
    }
  });

  it("blocks Ontario specifically but not the rest of Canada", () => {
    expect(isRestricted({ country: "CA", region: "ON" })).toBe(true);
    expect(isRestricted({ country: "CA", region: "BC" })).toBe(false);
    expect(isRestricted({ country: "CA" })).toBe(false);
  });

  it("allows non-restricted jurisdictions", () => {
    expect(isRestricted({ country: "SG" })).toBe(false);
    expect(isRestricted({ country: "JP" })).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isRestricted({ country: "us" })).toBe(true);
  });

  it("fails open on unknown country (gate decided upstream)", () => {
    expect(isRestricted({})).toBe(false);
  });

  it("provides a reason only when restricted", () => {
    expect(restrictionReason({ country: "US" })).toMatch(/不可用/);
    expect(restrictionReason({ country: "SG" })).toBeNull();
  });
});
