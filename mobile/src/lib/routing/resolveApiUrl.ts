import type { Network } from "../../state/envStore";
import { selectRoute, type TrafficType } from "./selectRoute";
import { hlRestBase } from "./detectEnv";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";

/** Shared M8 routing decision: the routed HL base URL for a traffic class. */
function routedBase(network: Network, traffic: TrafficType): string {
  return selectRoute({
    mode: useRoutingStore.getState().mode,
    traffic,
    userId: useWalletStore.getState().address ?? "",
    pool: useRuntimeConfigStore.getState().proxyPool,
    directBase: hlRestBase(network),
    proxyRecommended: useRoutingEnvStore.getState().proxyRecommended,
  }).baseUrl;
}

/** Resolve the HL HTTP base URL for a traffic class, applying the M8 routing decision from
 *  the current preference, detected environment, server-delivered pool, and wallet address. */
export function resolveApiUrl(network: Network, traffic: TrafficType): string {
  return routedBase(network, traffic);
}

/** HL WebSocket endpoint for a traffic class: the routed base as `wss://host/ws`.
 *  Direct → `wss://api.hyperliquid[-testnet].xyz/ws` (identical to the SDK default). */
export function resolveWsUrl(network: Network, traffic: TrafficType): string {
  const base = routedBase(network, traffic).replace(/\/$/, "");
  return `${base.replace(/^http/, "ws")}/ws`;
}
