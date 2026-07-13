# M8 Unit D — Auto-Degradation (proxy cooldown + direct fallback)

Date: 2026-07-13
Status: Approved

## Context

Units A–E route HL HTTP/WS traffic through the proxy pool. When a proxy IP fails (rate limit
or connection failure), the app should stop using it briefly and fall back to a direct
connection, self-healing after a cooldown (`docs/CHINA-ACCESS-ANALYSIS.md` §4.3). This unit
adds that resilience to the **HTTP** read path: a cooldown registry, cooldown-aware routing,
and a routing transport that on a proxy failure marks a 30s cooldown and retries direct once.
Public-WS failure triggering is deferred to D2 (though WS routing already degrades away from a
cooling proxy via the shared resolver).

## Goal

On a proxy HTTP failure (429 / gateway 5xx / network-timeout), mark the proxy for a 30s
cooldown and transparently retry the request direct; while cooling, routing selects direct
for that proxy. Normal HL error responses (the proxy worked) do NOT trigger cooldown.

## Design (all in `mobile/`)

### 1. `lib/routing/proxyCooldown.ts` — cooldown registry

```ts
const cooldownUntil = new Map<string, number>();
export const PROXY_COOLDOWN_MS = 30_000;

/** Put a proxy base URL into cooldown until now+ms (no-op for an empty url). */
export function markCooldown(url: string, now: number = Date.now(), ms: number = PROXY_COOLDOWN_MS): void {
  if (url) cooldownUntil.set(url, now + ms);
}

/** True while the url is cooling down; expired entries self-clear. */
export function isCoolingDown(url: string, now: number = Date.now()): boolean {
  const until = cooldownUntil.get(url);
  if (until === undefined) return false;
  if (now >= until) { cooldownUntil.delete(url); return false; }
  return true;
}

/** Test helper: clear all cooldowns. */
export function _resetCooldowns(): void { cooldownUntil.clear(); }
```

### 2. `lib/routing/resolveApiUrl.ts` — degrade a cooling proxy to direct

`routedBase` returns direct when the consistently-hashed proxy is currently cooling:
```ts
function routedBase(network: Network, traffic: TrafficType): string {
  const directBase = hlRestBase(network);
  const r = selectRoute({ mode: …, traffic, userId: …, pool: …, directBase, proxyRecommended: … });
  if (r.viaProxy && isCoolingDown(r.baseUrl)) return directBase;
  return r.baseUrl;
}
```
(Consistent hashing is preserved — a user's proxy stays their proxy; it simply resolves to
direct while cooling. Both `resolveApiUrl` and `resolveWsUrl` inherit this.)

### 3. `lib/hyperliquid/routingHttpTransport.ts` — failure→cooldown→direct retry

```ts
import { HttpTransport } from "@nktkas/hyperliquid";
import type { IRequestTransport } from "@nktkas/hyperliquid";
import type { Network } from "../../state/envStore";
import type { TrafficType } from "../routing/selectRoute";
import { resolveApiUrl } from "../routing/resolveApiUrl";
import { hlRestBase } from "../routing/detectEnv";
import { markCooldown } from "../routing/proxyCooldown";
import { resolveIsTestnet } from "./network";

/** A proxy-attributable failure: 429 / gateway 5xx, or a network/timeout error (no response).
 *  A normal HL error response (e.g. 400/422) means the proxy worked → not a proxy failure. */
export function isProxyFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (typeof status === "number") return status === 429 || status === 502 || status === 503 || status === 504;
  return true; // no response → connection/timeout/abort
}

/** IRequestTransport that resolves the base per-request (respecting cooldown) and, on a proxy
 *  failure, marks a cooldown and retries once directly. Direct requests are not retried. */
export class RoutingHttpTransport implements IRequestTransport {
  isTestnet: boolean;
  constructor(private network: Network, private traffic: TrafficType) {
    this.isTestnet = resolveIsTestnet(network);
  }
  async request<T>(endpoint: "info" | "exchange" | "explorer", payload: unknown, signal?: AbortSignal): Promise<T> {
    const base = resolveApiUrl(this.network, this.traffic);
    const direct = hlRestBase(this.network);
    try {
      return await new HttpTransport({ isTestnet: this.isTestnet, apiUrl: base }).request<T>(endpoint, payload, signal);
    } catch (e) {
      if (base !== direct && isProxyFailure(e)) {
        markCooldown(base);
        return await new HttpTransport({ isTestnet: this.isTestnet, apiUrl: direct }).request<T>(endpoint, payload, signal);
      }
      throw e;
    }
  }
}
```
(If `IRequestTransport` isn't re-exported at the package root, declare the minimal interface
locally — structural typing satisfies `InfoConfig<T extends IRequestTransport>`.)

### 4. Wire `lib/hyperliquid/client.ts` info factories

Replace each info factory's `new HttpTransport({ isTestnet, apiUrl: resolveApiUrl(network, "readInfo") })`
with `new RoutingHttpTransport(network, "readInfo")`:
`createInfoClient`, `createDetailInfoClient`, `createPositionsInfoClient`, `createFillsInfoClient`,
`createOrdersInfoClient`, `createTwapInfoClient`, `createFundingsInfoClient`, `createOrderStatusInfoClient`.
`createExchangeClient` is **unchanged** (always direct — no proxy, no retry). WS factories are
unchanged.

## Data flow

```
InfoClient.request → RoutingHttpTransport.request
  base = resolveApiUrl(network, "readInfo")   (direct if the proxy is cooling)
  try proxy → ok → return
           → fail & isProxyFailure & base≠direct
                → markCooldown(proxy, 30s) → retry direct → return
           → fail & !isProxyFailure (HL business error) → rethrow (no cooldown)
subsequent resolves → routedBase sees the cooldown → returns direct until it expires
```

## Error handling / edge cases

- Only 429/502/503/504/network-timeout mark cooldown; genuine HL error responses do not
  (avoids false-positives disabling a healthy proxy on a bad request).
- Direct requests never retry (there's nowhere to fall back to).
- Empty pool / direct routing → `base === direct` → the `try` runs once, errors propagate normally.
- Cooldown entries self-expire after 30s (`isCoolingDown` clears them lazily).
- `markCooldown("")` is a no-op.

## Testing

- `lib/routing/proxyCooldown.test.ts`: `markCooldown`+`isCoolingDown` true within window, false
  after expiry (self-clearing), empty-url no-op; use explicit `now` values.
- `lib/routing/resolveApiUrl.test.ts` (extend): with a cooled proxy, `resolveApiUrl`/`resolveWsUrl`
  in forced `proxy` mode return the direct base/wss (degrade).
- `lib/hyperliquid/routingHttpTransport.test.ts`: mock `@nktkas/hyperliquid` `HttpTransport` so its
  `request` resolves for the direct apiUrl and rejects (429) for a proxy apiUrl; in forced proxy mode
  assert a 429 → the proxy is marked cooling AND a second transport is built with the direct base and
  its value returned; a non-proxy error (status 400) rethrows without cooldown; a direct-base request
  error rethrows without retry. Reset stores + `_resetCooldowns()` per test.
- `lib/hyperliquid/client.test.ts` (extend/adjust): the info factories now build a
  `RoutingHttpTransport` (not a bare `HttpTransport`); assert routing still yields a proxy read path
  end-to-end (e.g. spy that a proxy request is attempted). Keep the exchange-direct assertion.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred

- D2 — public-WS failure triggering (react to `WebSocketTransport` reconnect/failure signals).
- F — the Cloudflare Worker proxy itself + the real `proxyPool`.
