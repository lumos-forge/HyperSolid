import type { Network } from "../../state/envStore";
import { selectRoute, type TrafficType } from "./selectRoute";
import { hlRestBase } from "./detectEnv";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";

/** Resolve the HL HTTP base URL for a traffic class, applying the M8 routing decision from
 *  the current preference, detected environment, server-delivered pool, and wallet address. */
export function resolveApiUrl(network: Network, traffic: TrafficType): string {
  return selectRoute({
    mode: useRoutingStore.getState().mode,
    traffic,
    userId: useWalletStore.getState().address ?? "",
    pool: useRuntimeConfigStore.getState().proxyPool,
    directBase: hlRestBase(network),
    proxyRecommended: useRoutingEnvStore.getState().proxyRecommended,
  }).baseUrl;
}
