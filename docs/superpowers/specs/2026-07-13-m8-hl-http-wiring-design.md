# M8 Unit E — HL HTTP Client Wiring (routing goes live)

Date: 2026-07-13
Status: Approved

## Context

Units A (preference), B (`selectRoute`), and C (`proxyRecommended`) are in place but nothing
consumes them yet. This unit wires routing into the **HTTP** Hyperliquid transports so
`/info` (read queries) can flow through the proxy pool while `/exchange` (signed txns) stays
direct. The `@nktkas/hyperliquid` `HttpTransport` accepts a custom `apiUrl`, which is the
injection point. Public-WebSocket routing is deferred to a follow-up (E2).

The proxy pool is server-delivered config and defaults to empty; with an empty pool
`selectRoute` falls back to direct, so **merging this unit changes nothing until a pool is
configured** (safe no-op before the Worker exists in unit F).

## Goal

Route HL HTTP requests via `selectRoute`: all `/info` clients use `readInfo` (proxy-eligible);
the exchange client uses `signedExchange` (always direct). Add the server-delivered
`proxyPool` config the router draws from.

## Design (all in `mobile/`)

### 1. `proxyPool` runtime config

`state/runtimeConfigStore.ts`:
- `AppRuntimeConfig` += `proxyPool: string[]` (server-delivered proxy base URLs; `[]` until delivered).
- Store initial state: `proxyPool: []`.
- `setConfig` copies `proxyPool: cfg.proxyPool`.

`services/appConfig.ts`:
- `RawAppConfig` += `proxyPool?: string[]`.
- `loadAppConfig` maps `proxyPool: raw.proxyPool ?? []`.

### 2. `lib/routing/resolveApiUrl.ts`

```ts
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
```

### 3. Wire `lib/hyperliquid/client.ts`

Every `HttpTransport({ isTestnet: resolveIsTestnet(network) })` in an **info** factory becomes:
```ts
new HttpTransport({ isTestnet: resolveIsTestnet(network), apiUrl: resolveApiUrl(network, "readInfo") })
```
Applies to: `createInfoClient`, `createDetailInfoClient`, `createPositionsInfoClient`,
`createFillsInfoClient`, `createOrdersInfoClient`, `createTwapInfoClient`,
`createFundingsInfoClient`, `createOrderStatusInfoClient`.

`createExchangeClient` uses the signed class (always direct):
```ts
new HttpTransport({ isTestnet: resolveIsTestnet(network), apiUrl: resolveApiUrl(network, "signedExchange") })
```

WebSocket factories (`createSubsClient`, `createDetailSubsClient`, `createTwapSubsClient`) are
**unchanged** (WS routing is E2). Import `resolveApiUrl` at the top of `client.ts`.

## Data flow

```
createInfoClient(network)
  → apiUrl = resolveApiUrl(network, "readInfo")
      = selectRoute({ mode, proxyRecommended, pool, address, directBase }).baseUrl
  → HttpTransport({ isTestnet, apiUrl }) → POST {apiUrl}/info
createExchangeClient(network, wallet)
  → apiUrl = resolveApiUrl(network, "signedExchange") → always directBase → POST {direct}/exchange
```

## Error handling / edge cases

- Empty `proxyPool` → `selectRoute` returns `directBase` → `apiUrl` equals the SDK default →
  no behavioral change (safe until a pool is delivered / the Worker ships in F).
- No wallet address yet → `userId=""`; still hashes deterministically to a pool entry (or
  direct if not proxy-eligible/empty). Signed traffic is direct regardless.
- `apiUrl` is fixed at client construction; routing changes take effect on the next client
  build (acceptable — detection runs at startup; dynamic switching is unit D's concern).

## Testing

- `lib/routing/resolveApiUrl.test.ts`:
  - default (mode `auto`, `proxyRecommended:false`, non-empty pool) → `readInfo` → `directBase`.
  - mode `proxy` + non-empty pool → `readInfo` → a pool entry (`viaProxy` path); `signedExchange` → `directBase`.
  - Reset the four stores (`routingStore`, `routingEnvStore`, `runtimeConfigStore`, `walletStore`) per test.
- `lib/hyperliquid/client.test.ts` (new): mock `@nktkas/hyperliquid` to capture `HttpTransport`
  constructor args. With `routingStore.mode="proxy"`, a non-empty `proxyPool`, an address, assert
  `createInfoClient("mainnet")` builds an `HttpTransport` whose `apiUrl` is a pool entry, and
  `createExchangeClient("mainnet", {})` builds one whose `apiUrl` is the direct mainnet base.
- `services/appConfig.test.ts`: assert `proxyPool` defaults to `[]` and is parsed when present.
- `state/runtimeConfigStore.test.ts`: add `proxyPool: []` to the existing `setConfig` fixtures
  (required field) so tsc/tests stay green.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred (later M8 units)

- E2 — public-WebSocket routing (`WebSocketTransport.url`, scheme conversion, subs clients).
- D — auto-degradation (429/failure → pool cooldown → direct) reacting to `viaProxy`.
- F — the Cloudflare Worker proxy itself + the actual `proxyPool` values.
