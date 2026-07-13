import { fetchWithTimeout } from "../fetchWithTimeout";
import type { Network } from "../../state/envStore";

/** Hyperliquid REST base per network (the M8 direct base). */
export function hlRestBase(network: Network): string {
  return network === "testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
}

/** Rule: recommend the proxy only for China users who cannot reach HL directly. */
export function decideProxyRecommended(input: { isChina: boolean; directReachable: boolean }): boolean {
  return input.isChina && !input.directReachable;
}

/** Probe direct reachability of HL: a light POST /info with a 3s timeout. ok → reachable; any error/timeout → not. */
export async function probeDirectReachable(
  directBase: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${directBase}/info`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "meta" }) },
      timeoutMs,
      fetchImpl,
    );
    return res.ok;
  } catch {
    return false;
  }
}
