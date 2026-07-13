# M8 Unit C — Network Environment Detection

Date: 2026-07-13
Status: Approved

## Context

M8 unit B's `selectRoute` consults a `proxyRecommended` boolean when the routing mode is
`auto`. This unit produces that boolean by detecting the network environment at startup:
**is the user in China mainland, and is Hyperliquid unreachable directly?** The app already
receives server-delivered geo (`useRuntimeConfigStore.geo.country`, from the request IP —
used by the geo-block gate), so no third-party IP-geolocation call is needed. Detection runs
once at launch (network-switch / foreground re-detection is deferred).

## Goal

Detect and store `proxyRecommended = isChina && !directReachable`, where China comes from
the server-delivered geo and reachability from a short-timeout probe of Hyperliquid's REST
endpoint. Non-China users never probe (proxy is never recommended for them).

## Design (all in `mobile/`)

### 1. `lib/routing/detectEnv.ts` — pure helpers + probe

```ts
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
```

### 2. `state/routingEnvStore.ts` — detected state

```ts
import { create } from "zustand";

interface RoutingEnvState {
  proxyRecommended: boolean;
  detected: boolean;
  setProxyRecommended: (v: boolean) => void;
}

/** Result of startup network-environment detection (M8 unit C); consumed by selectRoute's `auto` mode. */
export const useRoutingEnvStore = create<RoutingEnvState>((set) => ({
  proxyRecommended: false,
  detected: false,
  setProxyRecommended: (proxyRecommended) => set({ proxyRecommended, detected: true }),
}));
```

### 3. `services/routingEnv.ts` — orchestrator

```ts
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
```

### 4. `App.tsx` — run once at startup (best-effort)

After the runtime-config hydrate resolves (so geo is available), fire detection non-blocking:
```ts
useEffect(() => {
  const baseUrl = process.env.EXPO_PUBLIC_APP_CONFIG_URL;
  const run = async () => {
    if (baseUrl) await hydrateRuntimeConfig(baseUrl);
    void detectRoutingEnv({ network, geoCountry: useRuntimeConfigStore.getState().geo?.country });
  };
  void run();
}, []);
```
(Adapt to the existing config-hydrate effect; `network` from `useEnvStore`.)

## Data flow

```
startup → hydrateRuntimeConfig → geo.country available
  → detectRoutingEnv({ network, geoCountry })
      isChina? no  → proxyRecommended=false (no probe)
      isChina? yes → probe HL /info (3s) → reachable? → recommended = !reachable
  → routingEnvStore.proxyRecommended  (consumed by selectRoute auto mode in unit E)
```

## Error handling / edge cases

- Probe error/timeout → `directReachable=false` (for China → recommend proxy).
- Missing/unknown geo → `isChina=false` → never recommends proxy (fail-safe: default direct).
- Non-China users skip the probe entirely (no startup latency for the 99% case).
- Detection is best-effort and non-blocking; the store defaults to `proxyRecommended:false`.

## Testing

- `lib/routing/detectEnv.test.ts`:
  - `hlRestBase`: mainnet/testnet URLs.
  - `decideProxyRecommended`: truth table (China×reachable → only China&!reachable is true).
  - `probeDirectReachable`: injected fetch returning `{ok:true}` → true; `{ok:false}` → false;
    a rejecting fetch (timeout/error) → false.
- `services/routingEnv.test.ts`:
  - non-China (`geoCountry:"US"`) → `proxyRecommended:false`, and the probe fetch is NOT called.
  - China + unreachable (fetch rejects) → `proxyRecommended:true`; store updated (`detected:true`).
  - China + reachable (fetch ok) → `proxyRecommended:false`.
- Validation: `cd mobile && npx tsc --noEmit && npm test`.

## Out of scope / deferred (later M8 units)

- Re-detection on network switch / foreground resume (startup-only for now).
- D — auto-degradation on 429/failure.
- E — wiring `selectRoute` + `proxyRecommended` + pool config into the HL clients.
- F — the Cloudflare Worker proxy itself.
