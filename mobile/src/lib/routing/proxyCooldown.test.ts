import { markCooldown, isCoolingDown, _resetCooldowns, PROXY_COOLDOWN_MS } from "./proxyCooldown";

beforeEach(() => _resetCooldowns());

describe("proxyCooldown", () => {
  it("is cooling within the window and clears after expiry", () => {
    const url = "https://p0.example";
    markCooldown(url, 1000);
    expect(isCoolingDown(url, 1000)).toBe(true);
    expect(isCoolingDown(url, 1000 + PROXY_COOLDOWN_MS - 1)).toBe(true);
    expect(isCoolingDown(url, 1000 + PROXY_COOLDOWN_MS)).toBe(false);
    expect(isCoolingDown(url, 1000)).toBe(false);
  });
  it("reports not-cooling for an unknown url", () => {
    expect(isCoolingDown("https://never", 0)).toBe(false);
  });
  it("ignores an empty url", () => {
    markCooldown("", 0);
    expect(isCoolingDown("", 0)).toBe(false);
  });
});
