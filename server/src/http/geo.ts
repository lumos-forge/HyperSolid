/** Request headers as Fastify exposes them (string | string[] | undefined). */
export type Headers = Record<string, string | string[] | undefined>;

export interface GeoHeaderConfig {
  countryHeader: string;
  regionHeader: string;
}

export interface Geo {
  country?: string;
  region?: string;
}

/** Cloudflare sentinels for unknown / Tor exit — treat as "no country". */
const SENTINELS = new Set(["", "XX", "T1"]);

function first(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw?.trim().toUpperCase();
}

/**
 * Derive the caller's geo from a fronting proxy/CDN header (e.g. Cloudflare `cf-ipcountry`).
 * Returns `undefined` when the country cannot be determined (missing/empty/sentinel) so the app
 * fails open. Region is best-effort (only used for the CA-ON case).
 */
export function resolveGeo(headers: Headers, cfg: GeoHeaderConfig): Geo | undefined {
  const country = first(headers[cfg.countryHeader]);
  if (!country || SENTINELS.has(country)) return undefined;
  const region = first(headers[cfg.regionHeader]);
  return region ? { country, region } : { country };
}
