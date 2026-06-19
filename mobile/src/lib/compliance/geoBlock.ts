/**
 * Geo-restriction list per Hyperliquid + Apple compliance (spec §9, gap analysis D).
 * Codes are ISO 3166-1 alpha-2.
 */
export const RESTRICTED_COUNTRIES = [
  "US", // United States
  "CU", // Cuba
  "IR", // Iran
  "MM", // Myanmar
  "KP", // North Korea
  "SY", // Syria
] as const;

export interface GeoContext {
  country?: string; // alpha-2
  region?: string; // e.g. "ON"
}

export function isRestricted(ctx: GeoContext): boolean {
  const country = ctx.country?.toUpperCase();
  if (!country) return false; // unknown — fail open at data layer; gate decided upstream
  if ((RESTRICTED_COUNTRIES as readonly string[]).includes(country)) return true;
  const region = ctx.region?.toUpperCase();
  if (country === "CA" && region === "ON") return true; // Ontario
  return false;
}

export function restrictionReason(ctx: GeoContext): string | null {
  if (!isRestricted(ctx)) return null;
  return "根据合规要求，HyperSolid 在您所在的司法管辖区不可用。";
}
