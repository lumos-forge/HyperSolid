import { hlRestBase, decideProxyRecommended, probeDirectReachable } from "../lib/routing/detectEnv";
import { useRoutingEnvStore } from "../state/routingEnvStore";
import type { Network } from "../state/envStore";

/** Detect + store `proxyRecommended`. China users probe HL directly; others skip the probe
 *  (proxy never recommended). Best-effort: any failure resolves to "not recommended". */
export async function detectRoutingEnv(deps: {
  network: Network;
  geoCountry?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const isChina = (deps.geoCountry ?? "").toUpperCase() === "CN";
  const directReachable = isChina ? await probeDirectReachable(hlRestBase(deps.network), deps.fetchImpl) : true;
  const rec = decideProxyRecommended({ isChina, directReachable });
  useRoutingEnvStore.getState().setProxyRecommended(rec);
  return rec;
}
