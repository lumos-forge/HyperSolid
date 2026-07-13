# M8 Unit E2 — Public WebSocket Routing

Date: 2026-07-13
Status: Approved

## Context

Unit E routed HL HTTP (`/info` proxy-eligible, `/exchange` direct). This unit extends routing
to **WebSocket** subscriptions: public market streams (allMids, l2Book, trades) become
proxy-eligible, while the private user-data stream stays direct. The
`@nktkas/hyperliquid` `WebSocketTransport` accepts a custom `url` (a full `wss://host/ws`
endpoint), which is the injection point. A single proxy host serves both `POST /info` and the
`/ws` upgrade, so WS reuses the same server-delivered `proxyPool` (HTTP `https://` base →
`wss://.../ws`).

## Goal

Route public WS subscriptions through the proxy pool (when routing is active) and keep the
private WS stream direct, by passing a routing-derived `url` to `WebSocketTransport`. Safe
no-op with an empty pool (direct `wss` equals the SDK default).

## Design (all in `mobile/`)

### 1. `lib/routing/resolveApiUrl.ts` — add `resolveWsUrl` (shared core)

Refactor to share the `selectRoute` call, then derive the WS endpoint:
```ts
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

/** HL HTTP base for a traffic class (M8 routing decision). */
export function resolveApiUrl(network: Network, traffic: TrafficType): string {
  return routedBase(network, traffic);
}

/** HL WebSocket endpoint for a traffic class: the routed base as `wss://host/ws`.
 *  Direct → `wss://api.hyperliquid[-testnet].xyz/ws` (identical to the SDK default). */
export function resolveWsUrl(network: Network, traffic: TrafficType): string {
  const base = routedBase(network, traffic).replace(/\/$/, "");
  return `${base.replace(/^http/, "ws")}/ws`;
}
```
- `https://host` → `wss://host` (the `^http`→`ws` swap turns `https`→`wss`); trailing slash is
  stripped first so a pool URL with a trailing `/` never yields `//ws`.

### 2. Wire `lib/hyperliquid/client.ts` WebSocket factories

Each `WebSocketTransport({ isTestnet: resolveIsTestnet(network) })` gains a `url`:
- `createSubsClient` (allMids) → `url: resolveWsUrl(network, "publicWs")`.
- `createDetailSubsClient` (l2Book, trades) → `url: resolveWsUrl(network, "publicWs")`.
- `createTwapSubsClient` (userTwapSliceFills — private user data) → `url: resolveWsUrl(network, "privateWs")`.

The HTTP factories from unit E are unchanged.

## Data flow

```
createSubsClient(network)         → url = resolveWsUrl(network, "publicWs")
  proxy active + pool             → wss://{poolHost}/ws
  direct / empty pool             → wss://api.hyperliquid.xyz/ws  (SDK default)
createTwapSubsClient(network)     → url = resolveWsUrl(network, "privateWs") → always direct wss
```

## Error handling / edge cases

- Empty pool → `routedBase` returns the direct base → `wss://…/ws` equals the SDK default →
  no behavior change until a pool ships.
- `privateWs` is never proxy-eligible → the user TWAP stream is always direct.
- Trailing-slash pool URLs are normalised before appending `/ws`.
- `url` is fixed at transport construction (same lifecycle note as unit E).

## Testing

- `lib/routing/resolveApiUrl.test.ts` (extend): `resolveWsUrl`
  - direct/auto not-recommended → `wss://api.hyperliquid.xyz/ws` (mainnet), testnet variant.
  - forced `proxy` + non-empty pool → `publicWs` → `wss://{poolHost}/ws` (a pool entry mapped
    to `wss` with `/ws`); assert scheme is `wss:` and path ends `/ws`.
  - forced `proxy` → `privateWs` → direct `wss://api.hyperliquid.xyz/ws`.
- `lib/hyperliquid/client.test.ts` (extend): capture `WebSocketTransport` args.
  - proxy mode: `createSubsClient("mainnet")` → `url` is a `wss://{poolHost}/ws` (host from the pool).
  - proxy mode: `createTwapSubsClient("mainnet")` → `url` is `wss://api.hyperliquid.xyz/ws` (direct).
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred (later M8 units)

- D — auto-degradation (429/failure → pool cooldown → direct) reacting to `viaProxy`.
- F — the Cloudflare Worker proxy itself (must handle both `POST /info` and the `/ws` upgrade)
  and the real `proxyPool` values.
