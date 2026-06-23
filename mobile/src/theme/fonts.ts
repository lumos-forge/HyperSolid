/**
 * Font-family tokens for the v8 type system — pure strings, jest-safe (no .ttf imports).
 * The strings match the @expo-google-fonts shorthand keys loaded in `fontAssets.ts`:
 *   numbers/data -> JetBrains Mono · terminal voice/titles -> Space Mono · body -> Inter Tight.
 * Until the fonts finish loading the app falls back to the platform default (these names resolve
 * to system fonts if absent), so text never disappears.
 */
export const fontFamilies = {
  monoRegular: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  monoBold: "JetBrainsMono_700Bold",
  displayRegular: "SpaceMono_400Regular",
  displayBold: "SpaceMono_700Bold",
  bodyRegular: "InterTight_400Regular",
  bodyMedium: "InterTight_500Medium",
  bodySemiBold: "InterTight_600SemiBold",
  bodyBold: "InterTight_700Bold",
} as const;

export const fonts = {
  /** JetBrains Mono — all numerals / data (tabular). */
  mono: {
    regular: fontFamilies.monoRegular,
    medium: fontFamilies.monoMedium,
    bold: fontFamilies.monoBold,
  },
  /** Space Mono — terminal voice: titles, eyebrows, tickers, CTAs. */
  display: {
    regular: fontFamilies.displayRegular,
    bold: fontFamilies.displayBold,
  },
  /** Inter Tight — body sentences, settings, labels. */
  body: {
    regular: fontFamilies.bodyRegular,
    medium: fontFamilies.bodyMedium,
    semibold: fontFamilies.bodySemiBold,
    bold: fontFamilies.bodyBold,
  },
} as const;

export type Fonts = typeof fonts;
