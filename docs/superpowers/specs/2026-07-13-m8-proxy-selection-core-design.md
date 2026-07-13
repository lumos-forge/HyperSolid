# M8 Unit B — Proxy-Selection Core

Date: 2026-07-13
Status: Approved

## Context

M8 routes some traffic through a Cloudflare Workers proxy pool for China-mainland users
(`docs/CHINA-ACCESS-ANALYSIS.md`). Unit A added the user routing preference
(`auto`/`direct`/`proxy`). This unit is the **pure decision core**: given the mode, the
traffic type, the user id, the proxy pool, and whether the environment recommends proxying,
it returns the target base URL and whether it is proxied. It has no I/O and no React — it is
the heart of client routing, consumed later by unit E (HL-client wiring) with inputs from
unit C (environment detection) and pool config.

## Goal

A pure `selectRoute(input) => { baseUrl, viaProxy }` that applies traffic separation and
consistent-hash proxy selection, so the same user always maps to the same proxy IP (needed
for HL's WS ≤10-users/IP limit) and signed/private traffic stays direct.

## Design — `mobile/src/lib/routing/selectRoute.ts`

```ts
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
  const idx = ((hashCode(userId) % pool.length) + pool.length) % pool.length; // guard negative
  return pool[idx];
}

export interface RouteInput {
  mode: RoutingMode;
  traffic: TrafficType;
  userId: string;
  pool: string[];        // proxy base URLs (may be empty)
  directBase: string;    // HL direct base for the active network
  proxyRecommended: boolean; // from env detection (unit C); only consulted for "auto"
}
export interface Route { baseUrl: string; viaProxy: boolean; }

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
```

## Decision table

| mode | proxyRecommended | traffic | result |
|------|------------------|---------|--------|
| direct | any | any | direct |
| proxy | any | readInfo / publicWs | proxy (hash pick) |
| proxy | any | signedExchange / privateWs | direct |
| auto | false | any | direct |
| auto | true | readInfo / publicWs | proxy (hash pick) |
| auto | true | signedExchange / privateWs | direct |
| proxy/auto(true) | — | proxy-eligible but pool empty | direct (fallback) |

## Error handling / edge cases

- Empty pool → direct fallback (`viaProxy:false`) so routing never breaks when unconfigured.
- Negative `hashCode` is normalised with `((h % n) + n) % n`.
- `viaProxy` is returned so a later unit (D, auto-degradation) can react to proxy-path errors.
- Pure and total: no throws, no I/O, deterministic for identical inputs.

## Testing — `mobile/src/lib/routing/selectRoute.test.ts`

- `hashCode` is deterministic (same input → same output) and distinct common strings differ.
- `pickProxy`: empty pool → `null`; same `userId` → same entry across calls; a `userId`
  whose `hashCode` is negative still yields a valid in-range entry.
- `selectRoute`:
  - `direct` mode → direct for every traffic type (incl. readInfo).
  - `proxy` mode → readInfo/publicWs → proxy (`viaProxy:true`); signedExchange/privateWs → direct.
  - `auto` + `proxyRecommended:false` → readInfo stays direct.
  - `auto` + `proxyRecommended:true` → readInfo → proxy; signedExchange → direct.
  - proxy-eligible + empty pool → direct fallback (`viaProxy:false`).
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred (later M8 units)

- C — environment detection producing `proxyRecommended`.
- D — auto-degradation (429/failure → pool cooldown → direct), which consumes `viaProxy`.
- E — wiring `selectRoute` into `createInfoClient`/`createSubsClient`/`createExchangeClient`
  and sourcing `pool`/`directBase` from config.
- F — the Cloudflare Worker proxy itself.
