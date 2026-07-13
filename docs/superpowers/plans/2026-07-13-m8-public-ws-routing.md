# M8 Public WebSocket Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route public WS subscriptions (allMids/l2Book/trades) through the proxy pool while keeping the private WS stream direct, via a routing-derived `WebSocketTransport.url`.

**Architecture:** Add `resolveWsUrl` alongside `resolveApiUrl` (shared `routedBase`), converting the routed HTTP base to `wss://host/ws`; wire it into the three WS client factories.

**Tech Stack:** Expo RN + TypeScript, `@nktkas/hyperliquid`, jest-expo.

Spec: `docs/superpowers/specs/2026-07-13-m8-public-ws-routing-design.md`
Branch: `feat/m8-public-ws-routing`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: `resolveWsUrl` (TDD)

**Files:**
- Modify: `mobile/src/lib/routing/resolveApiUrl.ts`
- Test: `mobile/src/lib/routing/resolveApiUrl.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `resolveApiUrl.test.ts` (the `beforeEach` already sets the four stores):
```ts
import { resolveWsUrl } from "./resolveApiUrl";

describe("resolveWsUrl", () => {
  it("returns the direct wss endpoint in auto mode when proxy is not recommended", () => {
    expect(resolveWsUrl("mainnet", "publicWs")).toBe("wss://api.hyperliquid.xyz/ws");
    expect(resolveWsUrl("testnet", "publicWs")).toBe("wss://api.hyperliquid-testnet.xyz/ws");
  });
  it("proxies public WS through the pool host in forced proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    const url = resolveWsUrl("mainnet", "publicWs");
    expect(url.startsWith("wss://")).toBe(true);
    expect(url.endsWith("/ws")).toBe(true);
    const host = url.slice("wss://".length, -"/ws".length);
    expect(POOL.map((p) => p.replace("https://", ""))).toContain(host);
  });
  it("keeps private WS direct even in proxy mode", () => {
    useRoutingStore.setState({ mode: "proxy" });
    expect(resolveWsUrl("mainnet", "privateWs")).toBe("wss://api.hyperliquid.xyz/ws");
  });
});
```
(`resolveWsUrl` is imported from the same module; `POOL` and the store imports already exist in this file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/routing/resolveApiUrl.test.ts`
Expected: FAIL (`resolveWsUrl` is not exported).

- [ ] **Step 3: Refactor `resolveApiUrl.ts` to add `resolveWsUrl`**

Replace the current `resolveApiUrl` implementation with a shared core:
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
(Keep the existing imports; only the function bodies change.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/routing/resolveApiUrl.test.ts`
Expected: PASS (all resolveApiUrl + resolveWsUrl tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/routing/resolveApiUrl.ts mobile/src/lib/routing/resolveApiUrl.test.ts
git commit -m "feat(m8): resolveWsUrl (routed base -> wss endpoint)"
```

---

### Task 2: Wire WS factories (TDD)

**Files:**
- Modify: `mobile/src/lib/hyperliquid/client.ts`
- Test: `mobile/src/lib/hyperliquid/client.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `client.test.ts` (SDK is already mocked; stores set in `beforeEach` with `mode:"proxy"`):
```ts
import { WebSocketTransport } from "@nktkas/hyperliquid";
import { createSubsClient, createTwapSubsClient } from "./client";

const wsMock = WebSocketTransport as unknown as jest.Mock;

describe("client WS routing", () => {
  it("routes public subscriptions through a proxy wss host in proxy mode", () => {
    wsMock.mockClear();
    createSubsClient("mainnet");
    const url: string = wsMock.mock.calls.at(-1)![0].url;
    expect(url.startsWith("wss://")).toBe(true);
    expect(url.endsWith("/ws")).toBe(true);
    const host = url.slice("wss://".length, -"/ws".length);
    expect(POOL.map((p) => p.replace("https://", ""))).toContain(host);
  });
  it("keeps the private twap subscription on the direct wss endpoint", () => {
    wsMock.mockClear();
    createTwapSubsClient("mainnet");
    expect(wsMock.mock.calls.at(-1)![0].url).toBe("wss://api.hyperliquid.xyz/ws");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: FAIL (`url` undefined on the WS transport).

- [ ] **Step 3: Wire the WS factories**

In `client.ts`, add `resolveWsUrl` to the routing import:
```ts
import { resolveApiUrl, resolveWsUrl } from "../routing/resolveApiUrl";
```
Change the three `WebSocketTransport({ isTestnet: resolveIsTestnet(network) })` transports:
- `createSubsClient`:
  ```ts
  const transport = new WebSocketTransport({ isTestnet: resolveIsTestnet(network), url: resolveWsUrl(network, "publicWs") });
  ```
- `createDetailSubsClient`:
  ```ts
  transport: new WebSocketTransport({ isTestnet: resolveIsTestnet(network), url: resolveWsUrl(network, "publicWs") }),
  ```
- `createTwapSubsClient`:
  ```ts
  transport: new WebSocketTransport({ isTestnet: resolveIsTestnet(network), url: resolveWsUrl(network, "privateWs") }),
  ```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/lib/hyperliquid/client.ts mobile/src/lib/hyperliquid/client.test.ts
git commit -m "feat(m8): route public WS subscriptions via resolveWsUrl (twap stays direct)"
```

---

### Task 3: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/m8-public-ws-routing
gh pr create --title "feat(m8): route public WebSocket subscriptions via the routing core" --body-file <body>
```
Body: summarize `resolveWsUrl` + WS factory wiring + tests; emphasize public subs proxy-eligible, private TWAP stream stays direct, and the empty-pool no-op. Note D (auto-degradation) and F (Worker) remain.

- [ ] **Step 3: Code review + CI** — dispatch code-review (background) + `gh pr checks <n> --watch`.

- [ ] **Step 4: Merge** — on clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** `resolveWsUrl` (Task 1), all three WS factories wired with correct traffic class (Task 2); tests for direct/proxy/private WS resolution and the client wiring.
- **Placeholder scan:** none — full code + commands.
- **Type consistency:** `resolveWsUrl(network, traffic)` mirrors `resolveApiUrl`; `routedBase` shared; `publicWs`/`privateWs` are valid `TrafficType`s; WS factories keep `isTestnet` and add `url`.
- **Safety:** empty pool → direct `wss://…/ws` = SDK default (no change); `privateWs` never proxy-eligible.
