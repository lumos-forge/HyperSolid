# M8 HL HTTP Client Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route HL HTTP requests via `selectRoute` — `/info` clients as `readInfo` (proxy-eligible), the exchange client as `signedExchange` (direct) — and add the server-delivered `proxyPool` config the router draws from. Safe no-op until a pool is delivered.

**Architecture:** Add `proxyPool` to runtime config; a `resolveApiUrl(network, traffic)` helper reads the routing stores + config and returns the base URL; `client.ts` passes it as `HttpTransport.apiUrl`.

**Tech Stack:** Expo RN + TypeScript, zustand, `@nktkas/hyperliquid`, jest-expo.

Spec: `docs/superpowers/specs/2026-07-13-m8-hl-http-wiring-design.md`
Branch: `feat/m8-hl-http-wiring`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: `proxyPool` runtime config

**Files:**
- Modify: `mobile/src/state/runtimeConfigStore.ts`, `mobile/src/state/runtimeConfigStore.test.ts`
- Modify: `mobile/src/services/appConfig.ts`, `mobile/src/services/appConfig.test.ts`

- [ ] **Step 1: Add `proxyPool` to the config type + store**

In `runtimeConfigStore.ts`:
- In `AppRuntimeConfig`, after `geo`, add:
  ```ts
  /** Server-delivered M8 proxy base URLs (Cloudflare Workers pool); empty until delivered. */
  proxyPool: string[];
  ```
- In the store initial state, after `geo: null,` add `proxyPool: [],`.
- In `setConfig`, after `geo: cfg.geo,` add `proxyPool: cfg.proxyPool,`.

- [ ] **Step 2: Add `proxyPool` to appConfig parsing**

In `appConfig.ts`:
- In `RawAppConfig`, add `proxyPool?: string[];`.
- In `loadAppConfig`'s returned object, after `geo: raw.geo ?? null,` add `proxyPool: raw.proxyPool ?? [],`.

- [ ] **Step 3: Update existing store fixtures (required field) + add assertions**

In `runtimeConfigStore.test.ts`, add `proxyPool: [],` to EACH of the three `setConfig({ … })` fixtures (the RPC, withdraw-fee, and strategy-API tests).

In `appConfig.test.ts`, add assertions:
```ts
    expect(cfg.proxyPool).toEqual([]); // in the "empty/missing" test
```
and, in a present-value test (or the main parse test), if the fixture includes `proxyPool`, assert it parses; otherwise add a focused test:
```ts
  it("parses a server-delivered proxy pool (defaults to empty)", async () => {
    const withPool = jest.fn(async () => jsonResponse({ proxyPool: ["https://p0.example"] })) as unknown as typeof fetch;
    expect((await loadAppConfig("https://cfg", withPool)).proxyPool).toEqual(["https://p0.example"]);
    const without = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    expect((await loadAppConfig("https://cfg", without)).proxyPool).toEqual([]);
  });
```
(Reuse the file's existing `jsonResponse`/`loadAppConfig` import style.)

- [ ] **Step 4: Run the affected tests + typecheck**

Run: `cd mobile && npx jest src/state/runtimeConfigStore.test.ts src/services/appConfig.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/state/runtimeConfigStore.ts mobile/src/state/runtimeConfigStore.test.ts mobile/src/services/appConfig.ts mobile/src/services/appConfig.test.ts
git commit -m "feat(m8): server-delivered proxyPool runtime config"
```

---

### Task 2: `resolveApiUrl` (TDD)

**Files:**
- Create: `mobile/src/lib/routing/resolveApiUrl.ts`
- Test: `mobile/src/lib/routing/resolveApiUrl.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { resolveApiUrl } from "./resolveApiUrl";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";

const POOL = ["https://p0.example", "https://p1.example"];

beforeEach(() => {
  useRoutingStore.setState({ mode: "auto" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("resolveApiUrl", () => {
  it("returns the direct base for read traffic in auto mode when proxy is not recommended", () => {
    expect(resolveApiUrl("mainnet", "readInfo")).toBe("https://api.hyperliquid.xyz");
  });
  it("returns a pool entry for read traffic in forced proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    expect(POOL).toContain(resolveApiUrl("mainnet", "readInfo"));
  });
  it("keeps signed exchange traffic direct even in proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    expect(resolveApiUrl("mainnet", "signedExchange")).toBe("https://api.hyperliquid.xyz");
  });
  it("uses the testnet base", () => {
    expect(resolveApiUrl("testnet", "readInfo")).toBe("https://api.hyperliquid-testnet.xyz");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/lib/routing/resolveApiUrl.test.ts`
Expected: FAIL (Cannot find module './resolveApiUrl').

- [ ] **Step 3: Write the implementation**

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/lib/routing/resolveApiUrl.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/routing/resolveApiUrl.ts mobile/src/lib/routing/resolveApiUrl.test.ts
git commit -m "feat(m8): resolveApiUrl (routing decision -> HL HTTP base)"
```

---

### Task 3: Wire `client.ts` (TDD)

**Files:**
- Modify: `mobile/src/lib/hyperliquid/client.ts`
- Test: `mobile/src/lib/hyperliquid/client.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { HttpTransport } from "@nktkas/hyperliquid";
import { createInfoClient, createExchangeClient } from "./client";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";

jest.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: jest.fn(function () {}),
  WebSocketTransport: jest.fn(function () {}),
  InfoClient: jest.fn(function () {}),
  ExchangeClient: jest.fn(function () {}),
  SubscriptionClient: jest.fn(function () {}),
}));

const POOL = ["https://p0.example", "https://p1.example"];
const httpMock = HttpTransport as unknown as jest.Mock;

beforeEach(() => {
  httpMock.mockClear();
  useRoutingStore.setState({ mode: "proxy" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("client routing", () => {
  it("builds the info transport with a proxy apiUrl in proxy mode", () => {
    createInfoClient("mainnet");
    const opts = httpMock.mock.calls.at(-1)![0];
    expect(POOL).toContain(opts.apiUrl);
  });
  it("keeps the exchange transport on the direct base", () => {
    createExchangeClient("mainnet", {});
    const opts = httpMock.mock.calls.at(-1)![0];
    expect(opts.apiUrl).toBe("https://api.hyperliquid.xyz");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: FAIL (apiUrl undefined — not yet wired).

- [ ] **Step 3: Add the import + wire the transports**

In `client.ts`, add at the top (after the `resolveIsTestnet` import):
```ts
import { resolveApiUrl } from "../routing/resolveApiUrl";
```
Change each **info** factory's transport to include `apiUrl: resolveApiUrl(network, "readInfo")`:
```ts
new HttpTransport({ isTestnet: resolveIsTestnet(network), apiUrl: resolveApiUrl(network, "readInfo") })
```
for `createInfoClient`, `createDetailInfoClient`, `createPositionsInfoClient`,
`createFillsInfoClient`, `createOrdersInfoClient`, `createTwapInfoClient`,
`createFundingsInfoClient`, `createOrderStatusInfoClient`.

Change `createExchangeClient`'s transport to:
```ts
const transport = new HttpTransport({ isTestnet: resolveIsTestnet(network), apiUrl: resolveApiUrl(network, "signedExchange") });
```
Leave the three WebSocket factories unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/lib/hyperliquid/client.ts mobile/src/lib/hyperliquid/client.test.ts
git commit -m "feat(m8): route HL HTTP transports via resolveApiUrl (info->proxy-eligible, exchange->direct)"
```

---

### Task 4: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/m8-hl-http-wiring
gh pr create --title "feat(m8): route HL HTTP requests via the routing core" --body-file <body>
```
Body: summarize proxyPool config + resolveApiUrl + client wiring + tests; emphasize the safe no-op with an empty pool, and that signed `/exchange` always stays direct. Note WS routing is E2.

- [ ] **Step 3: Code review + CI** — dispatch code-review (background) + `gh pr checks <n> --watch`.

- [ ] **Step 4: Merge** — on clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** proxyPool config (Task 1), resolveApiUrl (Task 2), all 8 info factories + exchange wired with the correct traffic class (Task 3); tests for resolveApiUrl decisions, client apiUrl wiring, and config parsing.
- **Placeholder scan:** none — full code + commands.
- **Type consistency:** `AppRuntimeConfig.proxyPool: string[]` is required, so the three `setConfig` test fixtures are updated to include it; `resolveApiUrl(network, traffic)` signature matches the test and the client call sites (`"readInfo"`/`"signedExchange"`); `TrafficType` imported from `selectRoute`.
- **Safety:** empty pool → direct fallback → `apiUrl` equals the SDK default → no behavior change before a pool is delivered. Signed exchange is always `signedExchange` → direct.
