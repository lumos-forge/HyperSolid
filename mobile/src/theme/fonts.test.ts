import { fonts, fontFamilies } from "./fonts";

describe("font tokens", () => {
  it("exposes mono / display / body family tokens as strings", () => {
    for (const group of [fonts.mono, fonts.display, fonts.body]) {
      for (const family of Object.values(group)) {
        expect(typeof family).toBe("string");
        expect(family.length).toBeGreaterThan(0);
      }
    }
  });

  it("maps roles to the expected Google font families", () => {
    expect(fonts.mono.regular).toBe("JetBrainsMono_400Regular");
    expect(fonts.mono.bold).toBe("JetBrainsMono_700Bold");
    expect(fonts.display.bold).toBe("SpaceMono_700Bold");
    expect(fonts.body.medium).toBe("InterTight_500Medium");
  });

  it("every family name is unique (no fontFamily collisions)", () => {
    const all = Object.values(fontFamilies);
    expect(new Set(all).size).toBe(all.length);
  });
});
