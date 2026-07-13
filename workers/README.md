# HyperSolid Proxy Worker (M8)

A minimal Cloudflare Worker that proxies Hyperliquid **public** traffic for the China smart
routing feature (M8). It forwards only:

- `POST /info` → `https://api.hyperliquid.xyz/info` (public read queries)
- `/ws` WebSocket upgrade → `wss://api.hyperliquid.xyz/ws` (public market subscriptions)

Everything else — including `/exchange` (signed transactions) — returns `404`. Signed and
private traffic is **always** sent directly by the app and is never relayed through this
proxy, keeping the proxy's trust surface minimal.

The mobile client only routes through a proxy for China users who cannot reach Hyperliquid
directly (see `docs/CHINA-ACCESS-ANALYSIS.md`); signed txns stay direct, and failed proxy
requests auto-degrade to direct.

## Upstream (mainnet / testnet)

The upstream host defaults to mainnet. Send `X-Hl-Network: testnet` to target testnet, or set
the `HL_MAINNET_HOST` / `HL_TESTNET_HOST` vars (in `wrangler.toml` or the dashboard) to
override per deployment.

## Develop & test

```bash
cd workers
npm ci
npm run typecheck   # tsc --noEmit
npm test            # jest
```

(The handler logic is unit-tested with an injected `fetch`; WebSocket piping is a
Workers-runtime behavior verified in deployment.)

## Deploy

Deploy with Wrangler (no local install needed):

```bash
cd workers
npx wrangler login
npx wrangler deploy
```

### Deploying the pool (outbound-IP diversity)

Hyperliquid rate-limits by IP (1200 weight/min) and caps WebSocket to ≤10 unique users per IP.
To scale, deploy **many** instances so requests spread across different outbound IPs. Each
Cloudflare account/zone yields a distinct `*.workers.dev` origin:

1. Deploy this Worker under several names/accounts (e.g. `hypersolid-proxy-hk1` …
   `hypersolid-proxy-hk20`), giving ~20 distinct origins.
2. Collect the deployed URLs (`https://hypersolid-proxy-hkN.<subdomain>.workers.dev`).
3. Put them into the server-delivered app config as `proxyPool` (the `/app-config` response
   consumed by `mobile/src/services/appConfig.ts`). The client hashes each user to a stable
   pool entry (WS ≤10-users/IP), and falls back to direct on failure.

Until `proxyPool` is populated, the client routes everything directly (a safe no-op).
