import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

/**
 * Design-system guard (see docs/design/DESIGN-SYSTEM.md §5): every color hue must live in
 * `src/theme/tokens.ts` and reach components via `useTheme()` / `withAlpha`. This test fails on any
 * hardcoded CSS color hex literal anywhere in `src/**` outside `theme/`, so new UI cannot silently
 * drift from the token palette.
 */
const SRC = resolve(__dirname, "..");
const THEME_DIR = resolve(__dirname);
// #rgb, #rgba, #rrggbb, #rrggbbaa
const HEX_COLOR = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === THEME_DIR) continue; // tokens.ts is the one legitimate home for hex
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("design system: no hardcoded colors outside theme/", () => {
  it("every color hue comes from theme tokens", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (HEX_COLOR.test(line)) offenders.push(`${file.replace(SRC, "src")}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
