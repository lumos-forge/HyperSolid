# M8 Network Environment Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and store `proxyRecommended = isChina && !directReachable` at startup, using the server-delivered geo and a short HL reachability probe; non-China users skip the probe.

**Architecture:** Pure helpers + a probe in `lib/routing/detectEnv.ts`, a small `routingEnvStore`, an orchestrator `services/routingEnv.ts`, wired once in `App.tsx` after config hydrate.

**Tech Stack:** Expo RN + TypeScript, zustand, jest-expo. Reuses `fetchWithTimeout` and `useRuntimeConfigStore.geo`.

Spec: `docs/superpowers/specs/2026-07-13-m8-env-detection-design.md`
Branch: `feat/m8-env-detection`
Validation: `cd mobile && npx tsc --noEmit && npm test`.

---

### Task 1: pure helpers + probe (TDD)

**Files:**
- Create: `mobile/src/lib/routing/detectEnv.ts`
- Test: `mobile/src/lib/routing/detectEnv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { hlRestBase, decideProxyRecommended, probeDirectReachable } from "./detectEnv";

describe("hlRestBase", () => {
  it("maps network to the HL REST base", () => {
    expect(hlRestBase("mainnet")).toBe("https://api.hyperliquid.xyz");
    expect(hlRestBase("testnet")).toBe("https://api.hyperliquid-testnet.xyz");
  });
});

describe("decideProxyRecommended", () => {
  it("recommends proxy only for China + unreachable", () => {
    expect(decideProxyRecommended({ isChina: true, directReachable: false })).toBe(true);
    expect(decideProxyRecommended({ isChina: true, directReachable: true })).toBe(false);
    expect(decideProxyRecommended({ isChina: false, directReachable: false })).toBe(false);
    expect(decideProxyRecommended({ isChina: false, directReachable: true })).toBe(false);
  });
});

describe("probeDirectReachable", () => {
  it("returns true on an ok response", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true }) as Response);
    await expect(probeDirectReachable("https://api.hyperliquid.xyz", fetchImpl, 3000)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });
  it("returns false on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false }) as Response);
    await expect(probeDirectReachable("https://api.hyperliquid.xyz", fetchImpl, 3000)).resolves.toBe(false);
  });
  it("returns false when the fetch rejects (timeout/error)", async () => {
    const fetchImpl = jest.fn(async () => { throw new Error("timeout"); });
    await expect(probeDirectReachable("https://api.hyperliquid.xyz", fetchImpl as unknown as typeof fetch, 3000)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/lib/routing/detectEnv.test.ts`
Expected: FAIL (Cannot find module './detectEnv').

- [ ] **Step 3: Write the implementation**

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/lib/routing/detectEnv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/routing/detectEnv.ts mobile/src/lib/routing/detectEnv.test.ts
git commit -m "feat(m8): env-detection helpers (HL base, decision rule, reachability probe)"
```

---

### Task 2: `routingEnvStore`

**Files:**
- Create: `mobile/src/state/routingEnvStore.ts`

- [ ] **Step 1: Write the store**

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

- [ ] **Step 2: Typecheck**

Run: `cd mobile && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/state/routingEnvStore.ts
git commit -m "feat(m8): routingEnvStore (detected proxyRecommended)"
```

---

### Task 3: `detectRoutingEnv` orchestrator (TDD)

**Files:**
- Create: `mobile/src/services/routingEnv.ts`
- Test: `mobile/src/services/routingEnv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { detectRoutingEnv } from "./routingEnv";
import { useRoutingEnvStore } from "../state/routingEnvStore";

beforeEach(() => {
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: false });
});

describe("detectRoutingEnv", () => {
  it("does not probe and does not recommend proxy outside China", async () => {
    const fetchImpl = jest.fn();
    const rec = await detectRoutingEnv({ network: "mainnet", geoCountry: "US", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rec).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(useRoutingEnvStore.getState().proxyRecommended).toBe(false);
    expect(useRoutingEnvStore.getState().detected).toBe(true);
  });

  it("recommends proxy for China when HL is unreachable", async () => {
    const fetchImpl = jest.fn(async () => { throw new Error("blocked"); });
    const rec = await detectRoutingEnv({ network: "mainnet", geoCountry: "CN", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rec).toBe(true);
    expect(useRoutingEnvStore.getState().proxyRecommended).toBe(true);
  });

  it("does not recommend proxy for China when HL is reachable", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true }) as Response);
    const rec = await detectRoutingEnv({ network: "mainnet", geoCountry: "cn", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rec).toBe(false);
    expect(useRoutingEnvStore.getState().proxyRecommended).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mobile && npx jest src/services/routingEnv.test.ts`
Expected: FAIL (Cannot find module './routingEnv').

- [ ] **Step 3: Write the implementation**

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mobile && npx jest src/services/routingEnv.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/routingEnv.ts mobile/src/services/routingEnv.test.ts
git commit -m "feat(m8): detectRoutingEnv orchestrator (geo + probe -> proxyRecommended)"
```

---

### Task 4: Wire into `App.tsx` startup

**Files:**
- Modify: `mobile/App.tsx`

- [ ] **Step 1: Add the import**

Near the other service imports:
```ts
import { detectRoutingEnv } from "./src/services/routingEnv";
import { useRuntimeConfigStore } from "./src/state/runtimeConfigStore";
```
(If `useRuntimeConfigStore` is already imported, do not duplicate it.)

- [ ] **Step 2: Chain detection after config hydrate**

Replace the existing config-hydrate effect:
```ts
  useEffect(() => {
    const baseUrl = process.env.EXPO_PUBLIC_APP_CONFIG_URL;
    if (baseUrl) void hydrateRuntimeConfig(baseUrl);
  }, []);
```
with:
```ts
  useEffect(() => {
    const baseUrl = process.env.EXPO_PUBLIC_APP_CONFIG_URL;
    void (async () => {
      if (baseUrl) await hydrateRuntimeConfig(baseUrl);
      void detectRoutingEnv({
        network: useEnvStore.getState().network,
        geoCountry: useRuntimeConfigStore.getState().geo?.country,
      });
    })();
  }, []);
```

- [ ] **Step 3: Full typecheck + suite**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 4: Commit**

```bash
git add mobile/App.tsx
git commit -m "feat(m8): run network-environment detection once at startup"
```

---

### Task 5: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/m8-env-detection
gh pr create --title "feat(m8): network environment detection (proxyRecommended)" --body-file <body>
```
Body: summarize helpers/probe + store + orchestrator + startup wiring + tests; note China-only probe, server-geo reuse, and that this feeds selectRoute's `auto` mode (unit E wires it).

- [ ] **Step 3: Code review + CI** — dispatch code-review (background) + `gh pr checks <n> --watch`.

- [ ] **Step 4: Merge** — on clean review + green CI: `gh pr merge --squash --delete-branch`; then `git checkout main && git pull`.

---

## Self-review

- **Spec coverage:** `hlRestBase`/`decideProxyRecommended`/`probeDirectReachable` (Task 1), store (Task 2), orchestrator with China-only probe + best-effort (Task 3), startup wiring (Task 4); tests for the truth table, probe ok/non-ok/reject, and orchestrator non-China/China-unreachable/China-reachable.
- **Placeholder scan:** none — full code + commands.
- **Type consistency:** `Network` imported from `envStore` in both `detectEnv.ts` and `routingEnv.ts`; `detectRoutingEnv` deps shape matches the test; store `setProxyRecommended` sets `detected:true`.
- **Reuse:** `fetchWithTimeout` (existing), `useRuntimeConfigStore.geo` (existing server-delivered geo) — no new third-party dependency.
