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
  /** Builder-code revenue config; omitted when unset (feature dark). perpFeeTenthBps in 1/10 bps. */
  builder?: { address: `0x${string}`; perpFeeTenthBps: number };
  /** Caller geo derived per-request from a proxy header (added by the /app-config handler). */
  geo?: { country?: string; region?: string };
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse the builder config from env; returns undefined unless the address is 0x+40hex AND the fee is
 *  an integer in [1, 100] (the perp cap). A misconfig disables the feature rather than risking rejects. */
function builderFromEnv(env: NodeJS.ProcessEnv): { address: `0x${string}`; perpFeeTenthBps: number } | undefined {
  const address = env.BUILDER_ADDRESS;
  const fee = Number(env.BUILDER_PERP_FEE_TENTH_BPS);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  if (!Number.isInteger(fee) || fee < 1 || fee > 100) return undefined;
  return { address: address as `0x${string}`, perpFeeTenthBps: fee };
}

/** Build the app-config payload from environment variables (defensive: missing/invalid → null). */
export function appConfigFromEnv(env: NodeJS.ProcessEnv): AppConfigPayload {
  const builder = builderFromEnv(env);
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
    ...(builder ? { builder } : {}),
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
