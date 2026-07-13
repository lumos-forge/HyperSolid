# M8 Unit D2 — Public WebSocket Failure Trigger

Date: 2026-07-13
Status: Approved

## Context

Unit D added HTTP auto-degradation: a proxy `/info` failure marks a 30s cooldown, and
`routedBase` degrades a cooling proxy to direct (for both HTTP and WS resolution). This unit
adds the **WebSocket** side of the trigger: when a proxied public-WS subscription fails to
restore (its `failureSignal` aborts), mark the proxy's cooldown so subsequent HTTP requests
and newly-built WS clients route direct. It mirrors D's `RoutingHttpTransport`.

Honest scope: this marks the proxy cooling on WS failure — it does not force-redirect the
currently-retrying socket (that would require consumer-level reconnection, out of scope).
Combined with D's degrade-in-selection, new clients/requests go direct while cooling.

## Goal

A `RoutingWsTransport` (an `ISubscriptionTransport`) that resolves the proxy WS endpoint once,
wraps a single `WebSocketTransport`, and on a subscription's `failureSignal` abort marks the
proxy for cooldown. Wire it into the two public-WS client factories.

## Design (all in `mobile/`)

### 1. `lib/hyperliquid/routingWsTransport.ts`

```ts
import { WebSocketTransport } from "@nktkas/hyperliquid";
import type { Network } from "../../state/envStore";
import type { TrafficType } from "../routing/selectRoute";
import { resolveWsUrl } from "../routing/resolveApiUrl";
import { hlRestBase } from "../routing/detectEnv";
import { markCooldown } from "../routing/proxyCooldown";
import { resolveIsTestnet } from "./network";

interface Subscription { unsubscribe(): Promise<void>; failureSignal: AbortSignal; }
interface SubscriptionTransport {
  isTestnet: boolean;
  subscribe<T>(channel: string, payload: unknown, listener: (data: CustomEvent<T>) => void): Promise<Subscription>;
}

/** `wss://host/ws` → the http base used as the cooldown key (matches routedBase/markCooldown). */
export function wsToHttpBase(wsUrl: string): string {
  return wsUrl.replace(/^wss/, "https").replace(/\/ws$/, "");
}

/** Wraps a single WebSocketTransport at the routed WS endpoint; on a subscription failure
 *  (failureSignal abort) for a proxied endpoint, marks the proxy for cooldown so later
 *  requests/clients route direct. */
export class RoutingWsTransport implements SubscriptionTransport {
  isTestnet: boolean;
  private inner: WebSocketTransport;
  private wsUrl: string;
  private directWs: string;
  constructor(network: Network, traffic: TrafficType) {
    this.isTestnet = resolveIsTestnet(network);
    this.wsUrl = resolveWsUrl(network, traffic);
    this.directWs = `${hlRestBase(network).replace(/^http/, "ws")}/ws`;
    this.inner = new WebSocketTransport({ isTestnet: this.isTestnet, url: this.wsUrl });
  }
  async subscribe<T>(channel: string, payload: unknown, listener: (data: CustomEvent<T>) => void): Promise<Subscription> {
    const sub = await (this.inner as unknown as SubscriptionTransport).subscribe<T>(channel, payload, listener);
    if (this.wsUrl !== this.directWs) {
      sub.failureSignal.addEventListener("abort", () => markCooldown(wsToHttpBase(this.wsUrl)), { once: true });
    }
    return sub;
  }
}
```
- The WS endpoint is resolved **once** (in the constructor) to keep a single socket — reusing
  the transport across subscriptions (WS ≤10-users/IP relies on one socket per proxy).
- Only a proxied endpoint (`wsUrl !== directWs`) attaches the failure listener; direct/private
  endpoints never mark a cooldown.
- `wsToHttpBase` yields the same key D marks/checks (`https://host`), so a WS failure cools the
  shared proxy for HTTP + future WS alike.

### 2. Wire `lib/hyperliquid/client.ts`

- `createSubsClient` (allMids) → `new RoutingWsTransport(network, "publicWs")`.
- `createDetailSubsClient` (l2Book/trades) → `new RoutingWsTransport(network, "publicWs")`.
- `createTwapSubsClient` (private) → unchanged (always-direct `WebSocketTransport`).

Import `RoutingWsTransport`. `resolveWsUrl` is still imported (used inside RoutingWsTransport
and by the twap factory).

## Data flow

```
createSubsClient → RoutingWsTransport(network,"publicWs")
  wsUrl = resolveWsUrl(...)  (proxy wss while routing active & not cooling)
  subscribe → inner WebSocketTransport.subscribe → ISubscription
    if proxied: failureSignal 'abort' → markCooldown(wsToHttpBase(wsUrl))
next routedBase (HTTP or new WS client) → isCoolingDown → direct until it expires
```

## Error handling / edge cases

- Direct/private endpoints: `wsUrl === directWs` → no failure listener, never cooled.
- The listener is `{ once: true }` so it fires at most once per subscription.
- Cooldown key equals the HTTP base (`https://host`) — unified with unit D.
- The live socket keeps its own reconnect policy; this unit only affects future resolution.

## Testing

- `lib/hyperliquid/routingWsTransport.test.ts`: mock `@nktkas/hyperliquid` `WebSocketTransport`
  so `subscribe` returns a fake `ISubscription` whose `failureSignal` is a controllable
  `AbortController.signal`; set the routing stores.
  - proxy mode + non-empty pool: `subscribe` then `abort()` → the proxy's http base is cooling
    (`isCoolingDown` true); the inner transport was built with the proxy wss url.
  - `privateWs` (or direct): `abort()` → not cooling.
  - `wsToHttpBase("wss://p0.example/ws") === "https://p0.example"`.
  - Reset stores + `_resetCooldowns()` per test.
- `lib/hyperliquid/client.test.ts` (extend): `createSubsClient("mainnet")`'s SubscriptionClient
  receives a `RoutingWsTransport` (the existing WS-url assertions still hold — the inner
  WebSocketTransport is still constructed with the proxy wss).
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred

- Forcing the currently-retrying socket to switch to direct (needs consumer reconnection).
- Operator deployment of the proxy pool (unit F README).
