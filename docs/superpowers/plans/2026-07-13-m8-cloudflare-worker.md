# M8 Cloudflare Worker Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A tested, deployable Cloudflare Worker (`workers/` package) that proxies `POST /info` and the `/ws` WebSocket upgrade to Hyperliquid, plus wrangler config, README, and a CI job.

**Architecture:** New `workers/` TS package mirroring `server/` (ts-jest); a pure `handle(request, env, fetchImpl)` handler; `wrangler.toml`; a `workers` CI job.

Spec: `docs/superpowers/specs/2026-07-13-m8-cloudflare-worker-design.md`
Branch: `feat/m8-cloudflare-worker`
Validation: `cd workers && npx tsc --noEmit && npx jest`.

---

### Task 1: Scaffold the `workers/` package

**Files:** `workers/package.json`, `workers/tsconfig.json`, `workers/jest.config.js`, `workers/.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "hypersolid-proxy-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "jest", "typecheck": "tsc --noEmit" },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.11.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.2",
    "typescript": "^5.4.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node", "jest"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `jest.config.js`** (ESM-friendly ts-jest)

```js
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
};
```

- [ ] **Step 4: `.gitignore`**

```
node_modules/
dist/
.wrangler/
```

- [ ] **Step 5: Install deps (generates package-lock.json)**

Run: `cd workers && npm install`
Expected: creates `node_modules` + `package-lock.json`.

- [ ] **Step 6: Commit**

```bash
git add workers/package.json workers/package-lock.json workers/tsconfig.json workers/jest.config.js workers/.gitignore
git commit -m "chore(m8): scaffold workers/ package (Cloudflare Worker proxy)"
```

---

### Task 2: Handler (TDD)

**Files:** Create `workers/src/index.ts`, `workers/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { handle, upstreamHost, type Env } from "./index";

type FakeReq = { method: string; url: string; headers: { get(k: string): string | null }; text(): Promise<string> };
function req(o: { method?: string; url?: string; headers?: Record<string, string>; body?: string }): FakeReq {
  const h = o.headers ?? {};
  return {
    method: o.method ?? "GET",
    url: o.url ?? "https://worker.dev/",
    headers: { get: (k) => h[k.toLowerCase()] ?? null },
    text: async () => o.body ?? "",
  };
}
const env: Env = {};
const asReq = (r: FakeReq) => r as unknown as Request;

describe("upstreamHost", () => {
  it("defaults to mainnet and honors the testnet header + env overrides", () => {
    expect(upstreamHost(asReq(req({})), {})).toBe("api.hyperliquid.xyz");
    expect(upstreamHost(asReq(req({ headers: { "x-hl-network": "testnet" } })), {})).toBe("api.hyperliquid-testnet.xyz");
    expect(upstreamHost(asReq(req({})), { HL_MAINNET_HOST: "m.example" })).toBe("m.example");
  });
});

describe("handle", () => {
  it("forwards POST /info to the mainnet upstream with the body and CORS", async () => {
    const fetchImpl = jest.fn(async () => new Response("{\"ok\":1}", { status: 200 }));
    const res = await handle(asReq(req({ method: "POST", url: "https://w.dev/info", headers: { "content-type": "application/json" }, body: "{\"type\":\"meta\"}" })), env, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.hyperliquid.xyz/info", expect.objectContaining({ method: "POST", body: "{\"type\":\"meta\"}" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("routes the testnet header to the testnet upstream", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 200 }));
    await handle(asReq(req({ method: "POST", url: "https://w.dev/info", headers: { "x-hl-network": "testnet" }, body: "{}" })), env, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.hyperliquid-testnet.xyz/info", expect.anything());
  });

  it("answers OPTIONS preflight with 204 + CORS", async () => {
    const res = await handle(asReq(req({ method: "OPTIONS", url: "https://w.dev/info" })), env, (async () => new Response()) as unknown as typeof fetch);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("proxies a /ws upgrade to the upstream ws", async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 101 }));
    await handle(asReq(req({ method: "GET", url: "https://w.dev/ws", headers: { upgrade: "websocket" } })), env, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.hyperliquid.xyz/ws", expect.anything());
  });

  it("404s a websocket upgrade to a non-/ws path, GET /, and POST /exchange", async () => {
    const fetchImpl = jest.fn(async () => new Response());
    expect((await handle(asReq(req({ method: "GET", url: "https://w.dev/nope", headers: { upgrade: "websocket" } })), env, fetchImpl as unknown as typeof fetch)).status).toBe(404);
    expect((await handle(asReq(req({ method: "GET", url: "https://w.dev/" })), env, fetchImpl as unknown as typeof fetch)).status).toBe(404);
    expect((await handle(asReq(req({ method: "POST", url: "https://w.dev/exchange", body: "{}" })), env, fetchImpl as unknown as typeof fetch)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers && npx jest`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `src/index.ts`** — exactly the handler from the spec's "workers/src/index.ts".

- [ ] **Step 4: Run to verify it passes**

Run: `cd workers && npx jest`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd workers && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add workers/src/index.ts workers/src/index.test.ts
git commit -m "feat(m8): Cloudflare Worker proxy handler (/info + /ws, mainnet/testnet)"
```

---

### Task 3: `wrangler.toml` + README

**Files:** Create `workers/wrangler.toml`, `workers/README.md`

- [ ] **Step 1: `wrangler.toml`** — from the spec.

- [ ] **Step 2: `README.md`** — what it does; `/info` + `/ws` only; `npm test` / `npm run typecheck`; `npx wrangler deploy`; deploying a pool of instances (separate accounts/names) for IP diversity; setting the resulting URLs into the server `app-config.proxyPool`; the `x-hl-network` header note.

- [ ] **Step 3: Commit**

```bash
git add workers/wrangler.toml workers/README.md
git commit -m "docs(m8): wrangler config + deploy guide for the proxy worker"
```

---

### Task 4: CI job

**Files:** Modify `.github/workflows/ci.yml`

- [ ] **Step 1: Add a `workers` job** mirroring `server` (checkout, setup-node 24 with `cache-dependency-path: workers/package-lock.json`, `npm ci`, `npx tsc --noEmit`, `npx jest --ci`, `working-directory: workers`).

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(m8): typecheck + test the workers/ package"
```

---

### Task 5: Finish the branch

- [ ] **Step 1: Validate** — `cd workers && npx tsc --noEmit && npx jest` green.
- [ ] **Step 2: Push + PR** — `gh pr create --title "feat(m8): Cloudflare Worker proxy (/info + /ws)" --body-file <body>`. Body: new workers/ package, handler, wrangler, README, CI job; only /info + /ws relayed; deploy is operator-run.
- [ ] **Step 3: Code review + CI** — dispatch code-review (background) + `gh pr checks <n> --watch`.
- [ ] **Step 4: Merge** — clean review + green CI → `gh pr merge --squash --delete-branch`; sync main.

---

## Self-review

- **Spec coverage:** package scaffold (T1), handler + tests for upstream selection/info-forward/CORS/WS/404 (T2), wrangler + README (T3), CI job (T4).
- **Placeholder scan:** none.
- **Type consistency:** `handle(request, env, fetchImpl?)` + `upstreamHost(request, env)` + `Env` match spec and tests; tests use structural fakes cast to `Request`.
- **Trust surface:** only `POST /info` and `/ws` upgrade are relayed; `/exchange`/others → 404.
