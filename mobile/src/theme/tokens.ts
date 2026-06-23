export type ThemeName = "electrum" | "daylight" | "oscilloscope";

export interface ThemeTokens {
  bg: string;
  surface: string;
  /** Deeper surface for inset blocks (charts, summaries). */
  surfaceAlt: string;
  line: string;
  /** Stronger hairline for card borders / dividers. */
  lineStrong: string;
  text: string;
  muted: string;
  /** Dimmest label tier (axis labels, micro-captions). */
  faint: string;
  brand: string;
  /** Brand highlight used for hero-number glow. */
  glow: string;
  up: string;
  down: string;
  /** Caution color for the asymmetric testnet warning — distinct from brand. */
  warn: string;
}

export const themes: Record<ThemeName, ThemeTokens> = {
  electrum: {
    bg: "#0A1217",
    surface: "#0F1A20",
    surfaceAlt: "#0C151A",
    line: "#1C2A32",
    lineStrong: "#263742",
    text: "#EAF1F4",
    muted: "#8BA0AB",
    faint: "#5E6E78",
    brand: "#E8C98F",
    glow: "#F6E4BE",
    up: "#37D69A",
    down: "#FF6168",
    warn: "#FFA53D",
  },
  daylight: {
    bg: "#EEF1F3",
    surface: "#FFFFFF",
    surfaceAlt: "#F5F7FA",
    line: "#DDE3E8",
    lineStrong: "#C7D0D6",
    text: "#11201F",
    muted: "#5A6B6E",
    faint: "#93A0A3",
    brand: "#0E5A6B",
    glow: "#2E7E8F",
    up: "#1E7F5C",
    down: "#C0492F",
    warn: "#C77A1E",
  },
  oscilloscope: {
    bg: "#0C0A07",
    surface: "#14110B",
    surfaceAlt: "#100D08",
    line: "#2A2418",
    lineStrong: "#352D1C",
    text: "#F3ECDD",
    muted: "#9A8E73",
    faint: "#6E6450",
    brand: "#FFB454",
    glow: "#FFD9A0",
    up: "#6FE0C0",
    down: "#FF7A6B",
    warn: "#FF9233",
  },
};

export const defaultTheme: ThemeName = "electrum";
