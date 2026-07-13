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
