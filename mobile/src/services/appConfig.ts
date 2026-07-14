import { useRuntimeConfigStore, type AppRuntimeConfig } from "../state/runtimeConfigStore";
import { fetchWithTimeout } from "../lib/fetchWithTimeout";

interface RawAppConfig {
  arbitrumRpc?: { mainnet?: string | null; testnet?: string | null };
  withdrawFeeUsdc?: { mainnet?: number | null; testnet?: number | null };
  strategyApiBaseUrl?: string | null;
  geo?: { country?: string; region?: string };
  proxyPool?: string[];
  builder?: { address?: string; perpFeeTenthBps?: number } | null;
}

/** Accept a server builder config only when the address is 0x+40hex and the fee is an int in [1,100]. */
function parseBuilder(raw: RawAppConfig["builder"]): { address: `0x${string}`; perpFeeTenthBps: number } | null {
  const address = raw?.address;
  const fee = raw?.perpFeeTenthBps;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 1 || fee > 100) return null;
  return { address: address as `0x${string}`, perpFeeTenthBps: fee };
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
    proxyPool: (raw.proxyPool ?? []).map((u) => u.replace(/\/$/, "")),
    builder: parseBuilder(raw.builder),
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
