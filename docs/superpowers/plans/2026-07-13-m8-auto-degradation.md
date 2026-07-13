# M8 Auto-Degradation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a proxy HTTP failure (429 / gateway 5xx / network-timeout), mark a 30s cooldown and retry direct once; while cooling, routing resolves that proxy to direct. Normal HL error responses do not trigger cooldown.

**Architecture:** A cooldown registry; `routedBase` degrades a cooling proxy to direct; a `RoutingHttpTransport` (IRequestTransport) resolves per-request and does the failure→cooldown→direct-retry; wired into the info client factories.

**Tech Stack:** Expo RN + TypeScript, `@nktkas/hyperliquid`, jest-expo.

Spec: `docs/superpowers/specs/2026-07-13-m8-auto-degradation-design.md`
Branch: `feat/m8-auto-degradation`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: cooldown registry (TDD)

**Files:**
- Create: `mobile/src/lib/routing/proxyCooldown.ts`
- Test: `mobile/src/lib/routing/proxyCooldown.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { markCooldown, isCoolingDown, _resetCooldowns, PROXY_COOLDOWN_MS } from "./proxyCooldown";

beforeEach(() => _resetCooldowns());

describe("proxyCooldown", () => {
  it("is cooling within the window and clears after expiry", () => {
    const url = "https://p0.example";
    markCooldown(url, 1000);
    expect(isCoolingDown(url, 1000)).toBe(true);
    expect(isCoolingDown(url, 1000 + PROXY_COOLDOWN_MS - 1)).toBe(true);
    expect(isCoolingDown(url, 1000 + PROXY_COOLDOWN_MS)).toBe(false); // self-clears
    expect(isCoolingDown(url, 1000)).toBe(false); // entry removed
  });
  it("reports not-cooling for an unknown url", () => {
    expect(isCoolingDown("https://never", 0)).toBe(false);
  });
  it("ignores an empty url", () => {
    markCooldown("", 0);
    expect(isCoolingDown("", 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/routing/proxyCooldown.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

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

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/routing/proxyCooldown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/routing/proxyCooldown.ts mobile/src/lib/routing/proxyCooldown.test.ts
git commit -m "feat(m8): proxy cooldown registry"
```

---

### Task 2: degrade a cooling proxy in `routedBase` (TDD)

**Files:**
- Modify: `mobile/src/lib/routing/resolveApiUrl.ts`
- Test: `mobile/src/lib/routing/resolveApiUrl.test.ts`

- [ ] **Step 1: Add the failing tests + cooldown reset**

At the top of `resolveApiUrl.test.ts`, import the cooldown helpers:
```ts
import { markCooldown, _resetCooldowns } from "./proxyCooldown";
```
Add `_resetCooldowns();` to the existing `beforeEach`. Then append:
```ts
describe("routing degrades a cooling proxy to direct", () => {
  it("resolveApiUrl falls back to direct when the chosen proxy is cooling", () => {
    useRoutingStore.setState({ mode: "proxy" });
    const proxy = resolveApiUrl("mainnet", "readInfo"); // a pool entry
    markCooldown(proxy, 0);
    expect(resolveApiUrl("mainnet", "readInfo")).toBe("https://api.hyperliquid.xyz");
  });
  it("resolveWsUrl falls back to the direct wss when the chosen proxy is cooling", () => {
    useRoutingStore.setState({ mode: "proxy" });
    const proxyWs = resolveWsUrl("mainnet", "publicWs"); // wss pool entry
    const proxyBase = proxyWs.replace(/^wss/, "https").replace(/\/ws$/, "");
    markCooldown(proxyBase, 0);
    expect(resolveWsUrl("mainnet", "publicWs")).toBe("wss://api.hyperliquid.xyz/ws");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/routing/resolveApiUrl.test.ts`
Expected: FAIL (still returns the proxy — degrade not implemented).

- [ ] **Step 3: Implement the degrade in `routedBase`**

In `resolveApiUrl.ts`, import the cooldown check:
```ts
import { isCoolingDown } from "./proxyCooldown";
```
Change `routedBase` to:
```ts
function routedBase(network: Network, traffic: TrafficType): string {
  const directBase = hlRestBase(network);
  const r = selectRoute({
    mode: useRoutingStore.getState().mode,
    traffic,
    userId: useWalletStore.getState().address ?? "",
    pool: useRuntimeConfigStore.getState().proxyPool,
    directBase,
    proxyRecommended: useRoutingEnvStore.getState().proxyRecommended,
  });
  if (r.viaProxy && isCoolingDown(r.baseUrl)) return directBase;
  return r.baseUrl;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/routing/resolveApiUrl.test.ts`
Expected: PASS (all existing + degrade tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/routing/resolveApiUrl.ts mobile/src/lib/routing/resolveApiUrl.test.ts
git commit -m "feat(m8): degrade a cooling proxy to direct in routedBase"
```

---

### Task 3: `RoutingHttpTransport` + `isProxyFailure` (TDD)

**Files:**
- Create: `mobile/src/lib/hyperliquid/routingHttpTransport.ts`
- Test: `mobile/src/lib/hyperliquid/routingHttpTransport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { HttpTransport } from "@nktkas/hyperliquid";
import { RoutingHttpTransport, isProxyFailure } from "./routingHttpTransport";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";
import { isCoolingDown, _resetCooldowns } from "../routing/proxyCooldown";

const POOL = ["https://p0.example", "https://p1.example"];
const DIRECT = "https://api.hyperliquid.xyz";

jest.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: jest.fn().mockImplementation((opts) => ({
    isTestnet: opts.isTestnet,
    apiUrl: opts.apiUrl,
    request: jest.fn(async () => {
      if (opts.apiUrl === "https://api.hyperliquid.xyz") return { ok: "direct" };
      const err = new Error("429") as Error & { response?: { status: number } };
      err.response = { status: 429 };
      throw err;
    }),
  })),
}));

beforeEach(() => {
  (HttpTransport as unknown as jest.Mock).mockClear();
  _resetCooldowns();
  useRoutingStore.setState({ mode: "proxy" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("isProxyFailure", () => {
  it("flags 429 and gateway 5xx and connection errors, not normal HL errors", () => {
    expect(isProxyFailure({ response: { status: 429 } })).toBe(true);
    expect(isProxyFailure({ response: { status: 503 } })).toBe(true);
    expect(isProxyFailure(new Error("timeout"))).toBe(true);
    expect(isProxyFailure({ response: { status: 400 } })).toBe(false);
    expect(isProxyFailure({ response: { status: 422 } })).toBe(false);
  });
});

describe("RoutingHttpTransport", () => {
  it("on a proxy 429, cools the proxy and retries direct", async () => {
    const t = new RoutingHttpTransport("mainnet", "readInfo");
    const res = await t.request("info", { type: "meta" });
    expect(res).toEqual({ ok: "direct" });
    // the proxy that was tried is now cooling
    const proxyTried = (HttpTransport as unknown as jest.Mock).mock.calls[0][0].apiUrl;
    expect(POOL).toContain(proxyTried);
    expect(isCoolingDown(proxyTried, Date.now())).toBe(true);
    // the second transport was built with the direct base
    const second = (HttpTransport as unknown as jest.Mock).mock.calls[1][0].apiUrl;
    expect(second).toBe(DIRECT);
  });

  it("rethrows a non-proxy (business) error without cooldown or retry", async () => {
    (HttpTransport as unknown as jest.Mock).mockImplementationOnce((opts) => ({
      isTestnet: opts.isTestnet,
      apiUrl: opts.apiUrl,
      request: jest.fn(async () => { const e = new Error("bad") as Error & { response?: { status: number } }; e.response = { status: 400 }; throw e; }),
    }));
    const t = new RoutingHttpTransport("mainnet", "readInfo");
    await expect(t.request("info", {})).rejects.toThrow("bad");
    expect((HttpTransport as unknown as jest.Mock).mock.calls.length).toBe(1); // no retry
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/hyperliquid/routingHttpTransport.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

```ts
import { HttpTransport } from "@nktkas/hyperliquid";
import type { Network } from "../../state/envStore";
import type { TrafficType } from "../routing/selectRoute";
import { resolveApiUrl } from "../routing/resolveApiUrl";
import { hlRestBase } from "../routing/detectEnv";
import { markCooldown } from "../routing/proxyCooldown";
import { resolveIsTestnet } from "./network";

/** Minimal transport contract the SDK clients accept (structurally an IRequestTransport). */
interface RequestTransport {
  isTestnet: boolean;
  request<T>(endpoint: "info" | "exchange" | "explorer", payload: unknown, signal?: AbortSignal): Promise<T>;
}

/** A proxy-attributable failure: 429 / gateway 5xx, or a network/timeout error (no response).
 *  A normal HL error response (e.g. 400/422) means the proxy worked → not a proxy failure. */
export function isProxyFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (typeof status === "number") return status === 429 || status === 502 || status === 503 || status === 504;
  return true;
}

/** Resolves the base per-request (respecting cooldown); on a proxy failure marks a cooldown and
 *  retries once directly. Direct requests are not retried. */
export class RoutingHttpTransport implements RequestTransport {
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

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/hyperliquid/routingHttpTransport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/hyperliquid/routingHttpTransport.ts mobile/src/lib/hyperliquid/routingHttpTransport.test.ts
git commit -m "feat(m8): RoutingHttpTransport (proxy failure -> cooldown -> direct retry)"
```

---

### Task 4: wire info factories + update client test (TDD)

**Files:**
- Modify: `mobile/src/lib/hyperliquid/client.ts`, `mobile/src/lib/hyperliquid/client.test.ts`

- [ ] **Step 1: Update the client test for the routing transport**

In `client.test.ts`, import the class and replace the two HTTP info/exchange assertions:
```ts
import { RoutingHttpTransport } from "./routingHttpTransport";
import { InfoClient } from "@nktkas/hyperliquid";
```
Replace the existing `it("builds the info transport with a proxy apiUrl in proxy mode", …)` with:
```ts
  it("gives the info client a RoutingHttpTransport", () => {
    createInfoClient("mainnet");
    const cfg = (InfoClient as unknown as jest.Mock).mock.calls.at(-1)![0];
    expect(cfg.transport).toBeInstanceOf(RoutingHttpTransport);
  });
```
Keep the existing exchange test (still a bare `HttpTransport` with the direct base) and the WS tests unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: FAIL (info client still gets a plain HttpTransport).

- [ ] **Step 3: Wire the info factories**

In `client.ts`, add the import:
```ts
import { RoutingHttpTransport } from "./routingHttpTransport";
```
In each info factory, replace `new HttpTransport({ isTestnet: resolveIsTestnet(network), apiUrl: resolveApiUrl(network, "readInfo") })`
with `new RoutingHttpTransport(network, "readInfo")`:
`createInfoClient`, `createDetailInfoClient`, `createPositionsInfoClient`, `createFillsInfoClient`,
`createOrdersInfoClient`, `createTwapInfoClient`, `createFundingsInfoClient`, `createOrderStatusInfoClient`.
Leave `createExchangeClient` (bare `HttpTransport`, `resolveApiUrl(network, "signedExchange")`) and the WS
factories unchanged. `resolveApiUrl` is still imported (used by the exchange factory + RoutingHttpTransport).

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/lib/hyperliquid/client.ts mobile/src/lib/hyperliquid/client.test.ts
git commit -m "feat(m8): info clients use RoutingHttpTransport (auto-degradation)"
```

---

### Task 5: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/m8-auto-degradation
gh pr create --title "feat(m8): auto-degradation — proxy cooldown + direct fallback" --body-file <body>
```
Body: summarize cooldown registry + routedBase degrade + RoutingHttpTransport + info wiring; emphasize failure classification (only 429/gateway-5xx/network → cooldown; HL business errors do not), direct retry once, exchange unchanged. Note D2 (WS trigger) + F remain.

- [ ] **Step 3: Code review + CI** — dispatch code-review (background) + `gh pr checks <n> --watch`.

- [ ] **Step 4: Merge** — on clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** cooldown registry (Task 1), degrade-in-selection (Task 2), RoutingHttpTransport + isProxyFailure (Task 3), info-factory wiring + client test update (Task 4). Tests cover cooldown windows, degrade for HTTP+WS, 429→cooldown→direct retry, business-error rethrow, and the transport swap.
- **Placeholder scan:** none — full code + commands.
- **Type consistency:** `RoutingHttpTransport implements RequestTransport` (structural `IRequestTransport`) is accepted by `InfoConfig<T extends IRequestTransport>`; `TrafficType` from `selectRoute`; `resolveApiUrl`/`hlRestBase`/`markCooldown`/`isCoolingDown` signatures match.
- **Regression guard:** the old `client.test.ts` info-apiUrl assertion is replaced (info now builds a RoutingHttpTransport, which constructs the HttpTransport lazily per request); exchange + WS assertions are preserved.
