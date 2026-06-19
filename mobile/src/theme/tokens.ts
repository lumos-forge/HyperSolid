export type ThemeName = "electrum" | "daylight" | "oscilloscope";

export interface ThemeTokens {
  bg: string;
  surface: string;
  line: string;
  text: string;
  muted: string;
  brand: string;
  up: string;
  down: string;
}

export const themes: Record<ThemeName, ThemeTokens> = {
  electrum: {
    bg: "#0A1217",
    surface: "#0F1A20",
    line: "#20303A",
    text: "#EAF1F4",
    muted: "#7E929C",
    brand: "#E8C98F",
    up: "#34C98B",
    down: "#FF5C63",
  },
  daylight: {
    bg: "#EEF1F3",
    surface: "#FFFFFF",
    line: "#CBD5D8",
    text: "#11201F",
    muted: "#5A6B6E",
    brand: "#0E5A6B",
    up: "#1E7F5C",
    down: "#C0492F",
  },
  oscilloscope: {
    bg: "#0C0A07",
    surface: "#14110B",
    line: "#2A2418",
    text: "#F3ECDD",
    muted: "#9A8E73",
    brand: "#FFB454",
    up: "#6FE0C0",
    down: "#FF7A6B",
  },
};

export const defaultTheme: ThemeName = "electrum";
