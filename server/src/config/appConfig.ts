/**
 * The runtime config the mobile app fetches at startup via `GET /app-config`. Keyed endpoints (the
 * Arbitrum RPC with the provider key) and tunables (withdraw fee, the strategy API base URL) are
 * delivered from the server at runtime — never embedded in the app via EXPO_PUBLIC_*. Values are
 * sourced from env at deploy; absent ones serialize as null and the app degrades gracefully.
 */
export interface AppConfigPayload {
  arbitrumRpc: { mainnet: string | null; testnet: string | null };
  withdrawFeeUsdc: { mainnet: number | null; testnet: number | null };
  strategyApiBaseUrl: string | null;
  /** Caller geo derived per-request from a proxy header (added by the /app-config handler). */
  geo?: { country?: string; region?: string };
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Build the app-config payload from environment variables (defensive: missing/invalid → null). */
export function appConfigFromEnv(env: NodeJS.ProcessEnv): AppConfigPayload {
  return {
    arbitrumRpc: {
      mainnet: env.ARBITRUM_RPC_MAINNET ?? null,
      testnet: env.ARBITRUM_RPC_TESTNET ?? null,
    },
    withdrawFeeUsdc: {
      mainnet: num(env.WITHDRAW_FEE_USDC_MAINNET),
      testnet: num(env.WITHDRAW_FEE_USDC_TESTNET),
    },
    strategyApiBaseUrl: env.STRATEGY_API_BASE_URL ?? null,
  };
}

import type { GeoHeaderConfig } from "../http/geo";

/** Header names the /app-config handler reads the caller's country/region from (Cloudflare defaults). */
export function geoHeadersFromEnv(env: NodeJS.ProcessEnv): GeoHeaderConfig {
  return {
    countryHeader: env.GEO_COUNTRY_HEADER ?? "cf-ipcountry",
    regionHeader: env.GEO_REGION_HEADER ?? "cf-region",
  };
}
