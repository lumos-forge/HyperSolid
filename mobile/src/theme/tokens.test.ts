import { themes, type ThemeName, type ThemeTokens } from "./tokens";

const names: ThemeName[] = ["electrum", "daylight", "oscilloscope"];

describe("theme tokens", () => {
  it.each(names)("%s has all required keys", (name) => {
    const t: ThemeTokens = themes[name];
    for (const key of ["bg", "surface", "line", "text", "muted", "brand", "up", "down"] as const) {
      expect(typeof t[key]).toBe("string");
      expect(t[key]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it.each(names)("%s keeps brand separate from up/down semantics", (name) => {
    const t = themes[name];
    expect(t.brand).not.toBe(t.up);
    expect(t.brand).not.toBe(t.down);
  });

  it("defaults to electrum", () => {
    expect(themes.electrum.bg).toBe("#0A1217");
    expect(themes.electrum.brand).toBe("#E8C98F");
  });
});
