import { useRuntimeConfigStore, type AppRuntimeConfig } from "../state/runtimeConfigStore";
import { fetchWithTimeout } from "../lib/fetchWithTimeout";

interface RawAppConfig {
  arbitrumRpc?: { mainnet?: string | null; testnet?: string | null };
  withdrawFeeUsdc?: { mainnet?: number | null; testnet?: number | null };
  strategyApiBaseUrl?: string | null;
  geo?: { country?: string; region?: string };
}

/**
 * Fetch the app's runtime config from the server (spec: secrets/keyed endpoints are server-delivered,
 * not embedded via EXPO_PUBLIC_*). `baseUrl` is the app's own backend (not secret); the response
 * carries the keyed RPC URLs. `fetchImpl` is injectable for tests.
 */
export async function loadAppConfig(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppRuntimeConfig> {
  const res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/app-config`, undefined, 10_000, fetchImpl);
  if (!res.ok) throw new Error(`app-config request failed: ${res.status}`);
  const raw = (await res.json()) as RawAppConfig;
  return {
    arbitrumRpc: {
      mainnet: raw.arbitrumRpc?.mainnet ?? null,
      testnet: raw.arbitrumRpc?.testnet ?? null,
    },
    withdrawFeeUsdc: {
      mainnet: raw.withdrawFeeUsdc?.mainnet ?? null,
      testnet: raw.withdrawFeeUsdc?.testnet ?? null,
    },
    strategyApiBaseUrl: raw.strategyApiBaseUrl ?? null,
    geo: raw.geo ?? null,
  };
}

/** Best-effort hydrate of the runtime config store from the server. Never throws (config stays empty). */
export async function hydrateRuntimeConfig(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const cfg = await loadAppConfig(baseUrl, fetchImpl);
    useRuntimeConfigStore.getState().setConfig(cfg);
  } catch {
    // Leave the config empty; consumers (e.g. deposit) block with a clear message until it arrives.
  }
}
