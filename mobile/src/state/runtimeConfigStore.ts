import { create } from "zustand";
import type { Network } from "./envStore";

/** Per-network values delivered from the server at runtime (never embedded in the bundle). */
export interface AppRuntimeConfig {
  arbitrumRpc: { mainnet: string | null; testnet: string | null };
  /** Hyperliquid flat withdraw fee (USDC) per network; null until delivered → fall back to default. */
  withdrawFeeUsdc: { mainnet: number | null; testnet: number | null };
  /** Strategy backend base URL (server-delivered); null until delivered → strategy automation gated. */
  strategyApiBaseUrl: string | null;
  /** Server-delivered caller geo (from the request IP); null when unknown → gate fails open. */
  geo: { country?: string; region?: string } | null;
  /** Server-delivered M8 proxy base URLs (Cloudflare Workers pool); empty until delivered. */
  proxyPool: string[];
  /** Server-delivered builder-code config; null until delivered / when disabled. perpFeeTenthBps in 1/10 bps. */
  builder: { address: `0x${string}`; perpFeeTenthBps: number } | null;
}

interface RuntimeConfigState extends AppRuntimeConfig {
  setConfig: (cfg: AppRuntimeConfig) => void;
}

/** Fallback HL flat withdraw fee (USDC) when the server hasn't delivered one. Server can override. */
export const DEFAULT_WITHDRAW_FEE_USDC = 1;

/**
 * Holds server-delivered runtime config (spec: secrets/keyed endpoints come from the server, not
 * EXPO_PUBLIC_* build env). Hydrated at startup by `loadAppConfig`; consumers read via `arbitrumRpcFor`.
 */
export const useRuntimeConfigStore = create<RuntimeConfigState>((set) => ({
  arbitrumRpc: { mainnet: null, testnet: null },
  withdrawFeeUsdc: { mainnet: null, testnet: null },
  strategyApiBaseUrl: null,
  geo: null,
  proxyPool: [],
  builder: null,
  setConfig: (cfg) =>
    set({
      arbitrumRpc: cfg.arbitrumRpc,
      withdrawFeeUsdc: cfg.withdrawFeeUsdc,
      strategyApiBaseUrl: cfg.strategyApiBaseUrl,
      geo: cfg.geo,
      proxyPool: cfg.proxyPool,
      builder: cfg.builder,
    }),
}));

/** The server-delivered Arbitrum RPC URL for a network, or null until it has been delivered. */
export function arbitrumRpcFor(network: Network): string | null {
  return useRuntimeConfigStore.getState().arbitrumRpc[network];
}

/** The withdraw fee (USDC) for a network — server-delivered when available, else the default. */
export function withdrawFeeFor(network: Network): number {
  return useRuntimeConfigStore.getState().withdrawFeeUsdc[network] ?? DEFAULT_WITHDRAW_FEE_USDC;
}

/** The server-delivered builder config, or null when absent/disabled. */
export function builderConfig(): { address: `0x${string}`; perpFeeTenthBps: number } | null {
  return useRuntimeConfigStore.getState().builder;
}
