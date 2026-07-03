import { resolveGeo } from "./geo";

const cfg = { countryHeader: "cf-ipcountry", regionHeader: "cf-region" };

describe("resolveGeo", () => {
  it("reads and uppercases country + region from the configured headers", () => {
    expect(resolveGeo({ "cf-ipcountry": "us", "cf-region": "ca" }, cfg)).toEqual({ country: "US", region: "CA" });
  });
  it("returns country only when no region header is present", () => {
    expect(resolveGeo({ "cf-ipcountry": "CA" }, cfg)).toEqual({ country: "CA" });
  });
  it("treats Cloudflare unknown/tor sentinels (XX, T1) as absent", () => {
    expect(resolveGeo({ "cf-ipcountry": "XX" }, cfg)).toBeUndefined();
    expect(resolveGeo({ "cf-ipcountry": "T1" }, cfg)).toBeUndefined();
  });
  it("returns undefined when the country header is missing or empty", () => {
    expect(resolveGeo({}, cfg)).toBeUndefined();
    expect(resolveGeo({ "cf-ipcountry": "" }, cfg)).toBeUndefined();
  });
  it("handles array-valued headers (takes the first)", () => {
    expect(resolveGeo({ "cf-ipcountry": ["GB", "US"] }, cfg)).toEqual({ country: "GB" });
  });
});
