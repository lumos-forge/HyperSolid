# M8 Public WS Failure Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `RoutingWsTransport` that marks a proxy's cooldown when a proxied public-WS subscription's `failureSignal` aborts; wire it into the two public-WS client factories.

**Architecture:** Mirrors D's `RoutingHttpTransport` — wrap a single `WebSocketTransport` at the routed WS endpoint; attach a one-shot failure listener for proxied endpoints that calls `markCooldown`.

Spec: `docs/superpowers/specs/2026-07-13-m8-ws-failure-trigger-design.md`
Branch: `feat/m8-ws-failure-trigger`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: `RoutingWsTransport` + `wsToHttpBase` (TDD)

**Files:** Create `mobile/src/lib/hyperliquid/routingWsTransport.ts`, `mobile/src/lib/hyperliquid/routingWsTransport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { WebSocketTransport } from "@nktkas/hyperliquid";
import { RoutingWsTransport, wsToHttpBase } from "./routingWsTransport";
import { useRoutingStore } from "../../state/routingStore";
import { useRoutingEnvStore } from "../../state/routingEnvStore";
import { useRuntimeConfigStore } from "../../state/runtimeConfigStore";
import { useWalletStore } from "../../state/walletStore";
import { isCoolingDown, _resetCooldowns } from "../routing/proxyCooldown";

const POOL = ["https://p0.example", "https://p1.example"];
const controllers: AbortController[] = [];

jest.mock("@nktkas/hyperliquid", () => ({
  WebSocketTransport: jest.fn().mockImplementation((opts) => ({
    isTestnet: opts.isTestnet,
    url: opts.url,
    subscribe: jest.fn(async () => {
      const ac = new AbortController();
      controllers.push(ac);
      return { unsubscribe: async () => {}, failureSignal: ac.signal };
    }),
  })),
}));
const wsMock = WebSocketTransport as unknown as jest.Mock;

beforeEach(() => {
  wsMock.mockClear();
  controllers.length = 0;
  _resetCooldowns();
  useRoutingStore.setState({ mode: "proxy" });
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: true });
  useRuntimeConfigStore.setState({ proxyPool: POOL });
  useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
});

describe("wsToHttpBase", () => {
  it("maps a wss endpoint to the http cooldown key", () => {
    expect(wsToHttpBase("wss://p0.example/ws")).toBe("https://p0.example");
  });
});

describe("RoutingWsTransport", () => {
  it("cools the proxy when a proxied subscription fails", async () => {
    const t = new RoutingWsTransport("mainnet", "publicWs");
    await t.subscribe("allMids", {}, () => {});
    const wsUrl: string = wsMock.mock.calls[0][0].url;
    expect(wsUrl.startsWith("wss://")).toBe(true);
    controllers[controllers.length - 1].abort();
    expect(isCoolingDown(wsToHttpBase(wsUrl), Date.now())).toBe(true);
  });

  it("does not cool a private (always-direct) subscription", async () => {
    const t = new RoutingWsTransport("mainnet", "privateWs");
    await t.subscribe("userTwapSliceFills", {}, () => {});
    const wsUrl: string = wsMock.mock.calls[0][0].url;
    expect(wsUrl).toBe("wss://api.hyperliquid.xyz/ws");
    controllers[controllers.length - 1].abort();
    expect(isCoolingDown(wsToHttpBase(wsUrl), Date.now())).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/hyperliquid/routingWsTransport.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation** — exactly the module from the spec's `routingWsTransport.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/hyperliquid/routingWsTransport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/hyperliquid/routingWsTransport.ts mobile/src/lib/hyperliquid/routingWsTransport.test.ts
git commit -m "feat(m8): RoutingWsTransport (proxy WS failure -> cooldown)"
```

---

### Task 2: Wire public-WS factories (TDD)

**Files:** Modify `mobile/src/lib/hyperliquid/client.ts`, `mobile/src/lib/hyperliquid/client.test.ts`

- [ ] **Step 1: Add the failing test**

In `client.test.ts`, import the class + SubscriptionClient, and add to the WS describe block:
```ts
import { RoutingWsTransport } from "./routingWsTransport";
import { SubscriptionClient } from "@nktkas/hyperliquid";
```
```ts
  it("gives the public subs client a RoutingWsTransport", () => {
    createSubsClient("mainnet");
    const cfg = (SubscriptionClient as unknown as jest.Mock).mock.calls.at(-1)![0];
    expect(cfg.transport).toBeInstanceOf(RoutingWsTransport);
  });
```
(The existing "routes public subscriptions through a proxy wss host" test still holds — the inner `WebSocketTransport` is still constructed with the proxy wss inside `RoutingWsTransport`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: FAIL (public subs client still gets a bare WebSocketTransport).

- [ ] **Step 3: Wire the factories**

In `client.ts` add:
```ts
import { RoutingWsTransport } from "./routingWsTransport";
```
- `createSubsClient`: replace `const transport = new WebSocketTransport({ isTestnet: resolveIsTestnet(network), url: resolveWsUrl(network, "publicWs") });` with `const transport = new RoutingWsTransport(network, "publicWs");`.
- `createDetailSubsClient`: replace `transport: new WebSocketTransport({ isTestnet: resolveIsTestnet(network), url: resolveWsUrl(network, "publicWs") }),` with `transport: new RoutingWsTransport(network, "publicWs"),`.
- `createTwapSubsClient`: unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/lib/hyperliquid/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/lib/hyperliquid/client.ts mobile/src/lib/hyperliquid/client.test.ts
git commit -m "feat(m8): public subs clients use RoutingWsTransport (WS failure -> cooldown)"
```

---

### Task 3: Finish the branch

- [ ] **Step 1: Validate** — `cd mobile && npx tsc --noEmit && npm test` green.
- [ ] **Step 2: Push + PR** — `gh pr create --title "feat(m8): public WS failure trigger (cooldown on WS abort)" --body-file <body>`. Body: RoutingWsTransport + wiring + tests; note the honest scope (marks cooldown for future routing; live socket not force-switched).
- [ ] **Step 3: Code review + CI** — dispatch code-review (background) + `gh pr checks <n> --watch`.
- [ ] **Step 4: Merge** — clean review + green CI → `gh pr merge --squash --delete-branch`; sync main.

---

## Self-review

- **Spec coverage:** `RoutingWsTransport` + `wsToHttpBase` + one-shot failure listener (Task 1), public-WS factory wiring + client test (Task 2). Tests: cooldown on proxied WS abort, no-cooldown on private/direct, key mapping.
- **Placeholder scan:** none.
- **Type consistency:** `RoutingWsTransport implements` a structural `ISubscriptionTransport` accepted by `SubscriptionConfig<T extends ISubscriptionTransport>`; `TrafficType` from selectRoute; cooldown key equals D's (`wsToHttpBase` → `https://host`).
- **Regression:** twap (private) factory unchanged; existing WS-url assertions still pass (inner WebSocketTransport still built with the proxy wss).
