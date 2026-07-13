import type { RoutingMode } from "../../state/routingStore";

/** Hyperliquid traffic classes for routing. Signed txns and private WS stay direct
 *  (70–90% success from China); read queries and public WS are proxy-eligible. */
export type TrafficType = "signedExchange" | "readInfo" | "privateWs" | "publicWs";

const PROXY_ELIGIBLE: Record<TrafficType, boolean> = {
  signedExchange: false,
  privateWs: false,
  readInfo: true,
  publicWs: true,
};

/** Deterministic 32-bit string hash (Java-style, ×31). Stable across runs/devices. */
export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Consistent proxy pick: same userId → same pool entry (WS ≤10 users/IP). null if pool empty. */
export function pickProxy(userId: string, pool: string[]): string | null {
  if (pool.length === 0) return null;
  const idx = ((hashCode(userId) % pool.length) + pool.length) % pool.length;
  return pool[idx];
}

export interface RouteInput {
  mode: RoutingMode;
  traffic: TrafficType;
  userId: string;
  pool: string[];
  directBase: string;
  proxyRecommended: boolean;
}
export interface Route {
  baseUrl: string;
  viaProxy: boolean;
}

/**
 * Decide the base URL for a request. Traffic separation always applies when the proxy layer
 * is active: only readInfo/publicWs are proxied; signedExchange/privateWs stay direct. The
 * proxy layer is active when mode is "proxy", or "auto" and the environment recommends it.
 * An empty pool falls back to direct even for proxy-eligible traffic.
 */
export function selectRoute(input: RouteInput): Route {
  const { mode, traffic, userId, pool, directBase, proxyRecommended } = input;
  const proxyLayer = mode === "proxy" || (mode === "auto" && proxyRecommended);
  if (proxyLayer && PROXY_ELIGIBLE[traffic]) {
    const p = pickProxy(userId, pool);
    if (p) return { baseUrl: p, viaProxy: true };
  }
  return { baseUrl: directBase, viaProxy: false };
}
