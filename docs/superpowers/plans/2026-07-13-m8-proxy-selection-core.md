# M8 Proxy-Selection Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure `selectRoute(input) => { baseUrl, viaProxy }` (plus `hashCode`, `pickProxy`, `TrafficType`) that applies traffic separation + consistent-hash proxy selection.

**Architecture:** One pure module `mobile/src/lib/routing/selectRoute.ts`, no I/O, referencing `RoutingMode` from the routing store. Consumed later by unit E.

**Tech Stack:** TypeScript, jest-expo.

Spec: `docs/superpowers/specs/2026-07-13-m8-proxy-selection-core-design.md`
Branch: `feat/m8-proxy-selection-core`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: `selectRoute` core (TDD)

**Files:**
- Create: `mobile/src/lib/routing/selectRoute.ts`
- Test: `mobile/src/lib/routing/selectRoute.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { selectRoute, pickProxy, hashCode, type RouteInput } from "./selectRoute";

const POOL = ["https://p0.example", "https://p1.example", "https://p2.example"];
const DIRECT = "https://api.hyperliquid.xyz";
const base = (over: Partial<RouteInput>): RouteInput => ({
  mode: "auto", traffic: "readInfo", userId: "0xabc", pool: POOL, directBase: DIRECT, proxyRecommended: false, ...over,
});

describe("hashCode", () => {
  it("is deterministic and distinguishes common strings", () => {
    expect(hashCode("0xabc")).toBe(hashCode("0xabc"));
    expect(hashCode("0xabc")).not.toBe(hashCode("0xdef"));
  });
});

describe("pickProxy", () => {
  it("returns null for an empty pool", () => {
    expect(pickProxy("0xabc", [])).toBeNull();
  });
  it("is consistent for the same user", () => {
    expect(pickProxy("0xabc", POOL)).toBe(pickProxy("0xabc", POOL));
  });
  it("always yields an in-range entry, even for negative hashes", () => {
    for (const u of ["0xabc", "0xdef", "zzz", "user-negative-hash", ""]) {
      const p = pickProxy(u, POOL);
      if (u === "") continue;
      expect(POOL).toContain(p);
    }
  });
});

describe("selectRoute", () => {
  it("direct mode is always direct", () => {
    expect(selectRoute(base({ mode: "direct", traffic: "readInfo" }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("proxy mode proxies read/public but keeps signed/private direct", () => {
    expect(selectRoute(base({ mode: "proxy", traffic: "readInfo" })).viaProxy).toBe(true);
    expect(selectRoute(base({ mode: "proxy", traffic: "publicWs" })).viaProxy).toBe(true);
    expect(selectRoute(base({ mode: "proxy", traffic: "signedExchange" }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
    expect(selectRoute(base({ mode: "proxy", traffic: "privateWs" }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("auto stays direct unless the environment recommends proxy", () => {
    expect(selectRoute(base({ mode: "auto", traffic: "readInfo", proxyRecommended: false })).viaProxy).toBe(false);
    expect(selectRoute(base({ mode: "auto", traffic: "readInfo", proxyRecommended: true })).viaProxy).toBe(true);
    expect(selectRoute(base({ mode: "auto", traffic: "signedExchange", proxyRecommended: true }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("falls back to direct when the pool is empty", () => {
    expect(selectRoute(base({ mode: "proxy", traffic: "readInfo", pool: [] }))).toEqual({ baseUrl: DIRECT, viaProxy: false });
  });
  it("routes a proxied request to a pool entry", () => {
    const r = selectRoute(base({ mode: "proxy", traffic: "readInfo" }));
    expect(POOL).toContain(r.baseUrl);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/lib/routing/selectRoute.test.ts`
Expected: FAIL (Cannot find module './selectRoute').

- [ ] **Step 3: Write the implementation**

```ts
import type { RoutingMode } from "../../state/routingStore";

/** Hyperliquid traffic classes for routing. Signed txns and private WS stay direct
 *  (70–90% success from China); read queries and public WS are proxy-eligible. */
export type TrafficType = "signedExchange" | "readInfo" | "privateWs" | "publicWs";

const PROXY_ELIGIBLE: Record<TrafficType, boolean> = {
  signedExchange: false,
  privateWs: false,
  readInfo: true,
  publicWs: true,
};

/** Deterministic 32-bit string hash (Java-style, ×31). Stable across runs/devices. */
export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Consistent proxy pick: same userId → same pool entry (WS ≤10 users/IP). null if pool empty. */
export function pickProxy(userId: string, pool: string[]): string | null {
  if (pool.length === 0) return null;
  const idx = ((hashCode(userId) % pool.length) + pool.length) % pool.length;
  return pool[idx];
}

export interface RouteInput {
  mode: RoutingMode;
  traffic: TrafficType;
  userId: string;
  pool: string[];
  directBase: string;
  proxyRecommended: boolean;
}
export interface Route { baseUrl: string; viaProxy: boolean; }

/**
 * Decide the base URL for a request. Traffic separation always applies when the proxy layer
 * is active: only readInfo/publicWs are proxied; signedExchange/privateWs stay direct. The
 * proxy layer is active when mode is "proxy", or "auto" and the environment recommends it.
 * An empty pool falls back to direct even for proxy-eligible traffic.
 */
export function selectRoute(input: RouteInput): Route {
  const { mode, traffic, userId, pool, directBase, proxyRecommended } = input;
  const proxyLayer = mode === "proxy" || (mode === "auto" && proxyRecommended);
  if (proxyLayer && PROXY_ELIGIBLE[traffic]) {
    const p = pickProxy(userId, pool);
    if (p) return { baseUrl: p, viaProxy: true };
  }
  return { baseUrl: directBase, viaProxy: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/lib/routing/selectRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/lib/routing/selectRoute.ts mobile/src/lib/routing/selectRoute.test.ts
git commit -m "feat(m8): pure proxy-selection core (traffic separation + consistent hash)"
```

---

### Task 2: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/m8-proxy-selection-core
gh pr create --title "feat(m8): proxy-selection core (traffic separation + consistent hash)" --body-file <body>
```
Body: summarize `selectRoute`/`hashCode`/`pickProxy` + the decision table + tests; note this is M8 unit B (pure logic, not yet wired — units C/E follow).

- [ ] **Step 3: Code review + CI**

Dispatch the code-review agent (background) + `gh pr checks <n> --watch` in parallel.

- [ ] **Step 4: Merge**

On clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** `hashCode`, `pickProxy`, `selectRoute` + traffic separation + consistent hash + empty-pool fallback all implemented and tested (Task 1); decision-table rows each have a matching assertion.
- **Placeholder scan:** none — full code and commands in every step.
- **Type consistency:** `RouteInput`/`Route`/`TrafficType` used identically in test and impl; `RoutingMode` imported from `routingStore` (unit A). `proxyLayer` gate matches the spec's decision table.
