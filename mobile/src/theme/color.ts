/** Derive a translucent variant of a theme token color (keeps colors token-sourced). */
export function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const a = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}
