import { themes, type ThemeName, type ThemeTokens } from "./tokens";

const names: ThemeName[] = ["electrum", "daylight", "oscilloscope"];

describe("theme tokens", () => {
  it.each(names)("%s has all required keys", (name) => {
    const t: ThemeTokens = themes[name];
    for (const key of ["bg", "surface", "surfaceAlt", "line", "lineStrong", "text", "muted", "faint", "brand", "glow", "up", "down", "warn"] as const) {
      expect(typeof t[key]).toBe("string");
      expect(t[key]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it.each(names)("%s keeps brand separate from up/down semantics", (name) => {
    const t = themes[name];
    expect(t.brand).not.toBe(t.up);
    expect(t.brand).not.toBe(t.down);
  });

  it.each(names)("%s warn is a distinct caution color (not brand/up/down)", (name) => {
    const t = themes[name];
    expect(t.warn).not.toBe(t.brand);
    expect(t.warn).not.toBe(t.up);
    expect(t.warn).not.toBe(t.down);
  });

  it("electrum aligns to the v8 design tokens", () => {
    const e = themes.electrum;
    expect(e.bg).toBe("#0A1217");
    expect(e.brand).toBe("#E8C98F");
    expect(e.up).toBe("#37D69A");
    expect(e.down).toBe("#FF6168");
    expect(e.warn).toBe("#FFA53D");
  });
});
