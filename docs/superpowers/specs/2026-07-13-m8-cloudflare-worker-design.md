# M8 Unit F — Cloudflare Worker Proxy

Date: 2026-07-13
Status: Approved

## Context

Units A–E make the mobile client route proxy-eligible traffic (public `/info` reads + public
WS) through a pool of proxy base URLs, with signed/private traffic always direct and HTTP
auto-degradation on failure. The pool has been empty (a safe no-op). This unit provides the
**proxy itself**: a Cloudflare Worker that forwards `POST /info` and the `/ws` WebSocket
upgrade to Hyperliquid, deployable as many instances for outbound-IP diversity
(`docs/CHINA-ACCESS-ANALYSIS.md` §4.2). It lives in a new `workers/` package. Actual
deployment (a pool of instances) requires the operator's Cloudflare account and is documented,
not performed here.

Trust-surface decision: the Worker forwards **only** `/info` and `/ws` — the exact traffic the
client proxies. It never relays `/exchange` (signed txns are always direct), keeping the
proxy's trust surface minimal.

## Goal

A tested, deployable Cloudflare Worker that transparently proxies HL public reads (`POST
/info`) and public WS (`/ws`), selecting mainnet/testnet upstream, with CORS handling; plus
its `wrangler.toml`, package tooling, README deploy guide, and a CI job.

## Design

### New package `workers/`

- `package.json` (name `hypersolid-proxy-worker`, `type: module`, scripts `test`/`typecheck`),
  `package-lock.json`, `tsconfig.json`, `jest.config.js` (ts-jest, node env) — mirroring
  `server/`. devDeps: `typescript`, `ts-jest`, `jest`, `@types/jest`, `@types/node`, `wrangler`.
- `wrangler.toml`, `README.md`.

### `workers/src/index.ts`

```ts
export interface Env {
  HL_MAINNET_HOST?: string;
  HL_TESTNET_HOST?: string;
}

const MAINNET = "api.hyperliquid.xyz";
const TESTNET = "api.hyperliquid-testnet.xyz";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-hl-network",
};

/** Upstream HL host: `x-hl-network: testnet` selects testnet; env vars can override. */
export function upstreamHost(request: Request, env: Env): string {
  const net = request.headers.get("x-hl-network");
  if (net === "testnet") return env.HL_TESTNET_HOST ?? TESTNET;
  return env.HL_MAINNET_HOST ?? MAINNET;
}

/** Proxy POST /info and the /ws WebSocket upgrade to Hyperliquid. Everything else → 404. */
export async function handle(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
    return fetchImpl(`https://${upstreamHost(request, env)}/ws`, request as unknown as RequestInit);
  }

  if (request.method === "POST" && url.pathname === "/info") {
    const body = await request.text();
    const upstream = await fetchImpl(`https://${upstreamHost(request, env)}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return new Response("Not found", { status: 404 });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
```

- WS: passing the original request as the second `fetch` argument is the Cloudflare pattern
  for transparent WebSocket proxying; the runtime pipes the 101 upgrade. Only `/ws` upgrades.
- `/info`: reads the body and re-POSTs to the HL upstream, mirroring status + streaming the
  body back with CORS headers added.
- Any other method/path (incl. `/exchange`) → 404 (never relayed).

### `workers/wrangler.toml`

```toml
name = "hypersolid-proxy"
main = "src/index.ts"
compatibility_date = "2024-09-23"

# Optional per-deployment upstream overrides (defaults: mainnet/testnet HL).
# [vars]
# HL_MAINNET_HOST = "api.hyperliquid.xyz"
# HL_TESTNET_HOST = "api.hyperliquid-testnet.xyz"
```

### CI

Add a `workers` job to `.github/workflows/ci.yml` mirroring `server` (working-directory
`workers`, `npm ci`, `npx tsc --noEmit`, `npx jest --ci`).

## Data flow

```
app (proxy mode) → POST https://{worker}/info  → Worker → POST https://api.hyperliquid.xyz/info → back (+CORS)
app (proxy mode) → wss://{worker}/ws (upgrade) → Worker → wss://api.hyperliquid.xyz/ws (piped)
x-hl-network: testnet header → testnet upstream
```

## Error handling / edge cases

- Non-`/info` POST, non-`/ws` upgrade, GET, and `/exchange` → 404 (minimal surface).
- Upstream errors pass through unchanged (the client's auto-degradation reacts to 429/5xx).
- `upstreamHost` defaults to mainnet; unknown `x-hl-network` values fall through to mainnet.
- CORS preflight (`OPTIONS`) answered locally.

## Testing — `workers/src/index.test.ts`

Use a lightweight fake `Request` (`{ method, url, headers: { get }, text() }`) and an injected
`fetchImpl`:
- `upstreamHost`: default mainnet; `x-hl-network: testnet` → testnet; env override wins.
- `handle` POST `/info` → `fetchImpl` called with `https://api.hyperliquid.xyz/info`, method POST,
  the forwarded body; response mirrors upstream status and carries CORS headers.
- testnet header → `https://api.hyperliquid-testnet.xyz/info`.
- `OPTIONS` → 204 with CORS.
- WS upgrade to `/ws` → `fetchImpl` called with `https://api.hyperliquid.xyz/ws`.
- WS upgrade to a non-`/ws` path → 404; `GET /` → 404; `POST /exchange` → 404 (not relayed).

WebSocket piping itself is a Workers-runtime behavior and is out of unit scope.
Validation: `cd workers && npx tsc --noEmit && npx jest`.

## Out of scope / deferred

- Actual deployment of a 20-instance pool (operator's Cloudflare accounts) — documented in the
  README; the resulting URLs go into the server `app-config.proxyPool`.
- Sending the `x-hl-network` header from the mobile client (a small later client tweak; the
  Worker defaults to mainnet, the production target).
- D2 — public-WS failure triggering on the client.
