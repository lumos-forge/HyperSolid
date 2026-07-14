# Engine Builder-Fee Attachment (Local-Key Path) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agentic engine attaches `builder { b: address, f: perpFeeTenthBps }` to its local-key `order` calls for owners whose on-chain `maxBuilderFee` covers the configured fee — earning the builder fee on strategy fills. Fail-open, config-driven, delegated path untouched.

**Architecture:** A per-owner `makeBuilderInjector` checks `maxBuilderFee` (positive result cached for the process, negative re-checked after a TTL). `makeClientFor` wraps the local `ExchangeClient` so `order()` merges the builder for approved owners; `cancelByCloid`/`scheduleCancel` and the delegated (signer) path are untouched. Config reuses `appConfigFromEnv().builder`.

**Tech Stack:** TypeScript (server/), `@nktkas/hyperliquid`, Jest.

**Spec:** `docs/superpowers/specs/2026-07-14-builder-fee-engine-design.md`

---

## Background / invariants (read first)

- Local-key path is active while `SIGNER_DELEGATION` is off. `placer.ts:82` and `restingExecutor.ts:85`
  both call `client.order({ orders:[o], grouping:"na" })`. `@nktkas` `ExchangeClient.order` accepts an
  optional `builder: { b, f }` sibling → attaching is a params merge, **no Go changes**.
- Agentic orders may carry a builder **only for owners who approved it** (main-wallet, via the app);
  else HL rejects the order. The engine only **checks** approval (`InfoClient.maxBuilderFee` returns the
  approved rate in tenth-bps) — it never prompts. Unapproved / query error → **no builder** (fail-open).
- `builder` config is `appConfigFromEnv(process.env).builder` (`{ address, perpFeeTenthBps } | undefined`,
  already validated 0x+40hex + int in [1,100]). `index.ts` already imports `appConfigFromEnv`.
- `makeClientFor` (current) routes: unapproved agent → `undefined`; delegated keyId → signer-backed
  client; else local `ExchangeClient`. The builder wrapper applies to the **local branch only**.
- The client surface used downstream: `order` (placer/resting), `cancelByCloid` (resting),
  `scheduleCancel` (deadMan, via cast). The wrapper must wrap `order` and pass the other two through with
  `this` preserved (call them as methods on the underlying client instance).
- Only perp `order` carries a builder — not cancels, `scheduleCancel`, or TWAP.
- Validate: `cd server && npm run typecheck && npm test` (and `go`/other packages untouched).

**Files:**
- Create: `server/src/agent/builderInjector.ts` (+ `builderInjector.test.ts`)
- Modify: `server/src/agent/hlRuntime.ts` (+ `hlRuntime.test.ts`)
- Modify: `server/src/index.ts`

---

## Task 1: `makeBuilderInjector`

**Files:** Create `server/src/agent/builderInjector.ts`, `server/src/agent/builderInjector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/builderInjector.test.ts`:

```ts
import { makeBuilderInjector, type BuilderInfoLike } from "./builderInjector";

const ADDR = ("0x" + "b".repeat(40)) as `0x${string}`;
const OWNER = "0x" + "1".repeat(40);

function fakeInfo(fn: BuilderInfoLike["maxBuilderFee"]): { info: BuilderInfoLike; calls: number } {
  const box = { info: null as unknown as BuilderInfoLike, calls: 0 };
  box.info = {
    maxBuilderFee: async (p) => {
      box.calls++;
      return fn(p);
    },
  };
  return box;
}

describe("makeBuilderInjector", () => {
  it("returns the builder when the approved rate covers the configured fee", async () => {
    const f = fakeInfo(async () => 100);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    expect(await inj.builderFor(OWNER)).toEqual({ b: ADDR, f: 20 });
  });

  it("returns undefined when the approved rate is below the fee", async () => {
    const f = fakeInfo(async () => 10);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    expect(await inj.builderFor(OWNER)).toBeUndefined();
  });

  it("fails open (undefined) when the query throws", async () => {
    const f = fakeInfo(async () => { throw new Error("net"); });
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    expect(await inj.builderFor(OWNER)).toBeUndefined();
  });

  it("caches an approved owner (no repeat query)", async () => {
    const f = fakeInfo(async () => 50);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    await inj.builderFor(OWNER);
    await inj.builderFor(OWNER);
    expect(f.calls).toBe(1);
  });

  it("re-checks an unapproved owner only after the negative TTL", async () => {
    let t = 0;
    let rate = 0;
    const f = fakeInfo(async () => rate);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20, now: () => t, negativeTtlMs: 1000 });
    expect(await inj.builderFor(OWNER)).toBeUndefined(); // query 1
    t = 500;
    expect(await inj.builderFor(OWNER)).toBeUndefined(); // cached, no query
    expect(f.calls).toBe(1);
    t = 1500; // past TTL
    rate = 100;
    expect(await inj.builderFor(OWNER)).toEqual({ b: ADDR, f: 20 }); // query 2, now approved
    expect(f.calls).toBe(2);
  });

  it("keys the cache case-insensitively", async () => {
    const f = fakeInfo(async () => 100);
    const inj = makeBuilderInjector({ info: f.info, address: ADDR, perpFeeTenthBps: 20 });
    await inj.builderFor(OWNER.toUpperCase());
    await inj.builderFor(OWNER.toLowerCase());
    expect(f.calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx jest src/agent/builderInjector.test.ts`
Expected: FAIL — `Cannot find module './builderInjector'`.

- [ ] **Step 3: Create `server/src/agent/builderInjector.ts`**

```ts
/** Narrow info surface: the approved builder fee rate (tenth-bps) for a user+builder. */
export interface BuilderInfoLike {
  maxBuilderFee(params: { user: `0x${string}`; builder: `0x${string}` }): Promise<number>;
}

/** The builder to attach to an order (@nktkas order `builder` sibling), or undefined when not approved. */
export interface BuilderInjector {
  builderFor(owner: string): Promise<{ b: `0x${string}`; f: number } | undefined>;
}

export interface BuilderInjectorDeps {
  info: BuilderInfoLike;
  address: `0x${string}`;
  perpFeeTenthBps: number;
  now?: () => number;
  /** How long an unapproved/unknown result is cached before re-checking (a user may approve any time). */
  negativeTtlMs?: number;
}

const DEFAULT_NEGATIVE_TTL_MS = 10 * 60_000;

/**
 * Per-owner builder-fee approval gate for the engine. `builderFor(owner)` returns the builder to attach
 * only when the owner's on-chain `maxBuilderFee` covers the configured fee. Approved results are cached
 * for the process lifetime (approval is effectively permanent); unapproved/unknown results are cached
 * for `negativeTtlMs` then re-checked (so an owner who approves in the app is picked up). A thrown query
 * fails open (undefined) so a builder is simply not attached that window — the order still places.
 */
export function makeBuilderInjector(deps: BuilderInjectorDeps): BuilderInjector {
  const now = deps.now ?? (() => Date.now());
  const negativeTtlMs = deps.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const builder = { b: deps.address, f: deps.perpFeeTenthBps };
  const cache = new Map<string, { approved: boolean; at: number }>();
  return {
    async builderFor(owner: string): Promise<{ b: `0x${string}`; f: number } | undefined> {
      const key = owner.toLowerCase();
      const t = now();
      const cached = cache.get(key);
      if (cached) {
        if (cached.approved) return builder;
        if (t - cached.at < negativeTtlMs) return undefined;
      }
      let approved = false;
      try {
        const rate = await deps.info.maxBuilderFee({ user: key as `0x${string}`, builder: deps.address });
        approved = rate >= deps.perpFeeTenthBps;
      } catch {
        approved = false; // fail-open: place without a builder this window
      }
      cache.set(key, { approved, at: t });
      return approved ? builder : undefined;
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx jest src/agent/builderInjector.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/builderInjector.ts server/src/agent/builderInjector.test.ts
git commit -m "feat(builder-fee): engine per-owner builder approval injector

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `makeClientFor` builder wrapper + `index.ts` wiring

**Files:** Modify `server/src/agent/hlRuntime.ts`, `server/src/agent/hlRuntime.test.ts`, `server/src/index.ts`

- [ ] **Step 1: Add the failing wrapper tests**

Append to `server/src/agent/hlRuntime.test.ts` (it already imports `makeClientFor`, `AgentManager`, `MemoryAgentStore`, `SignerLike`, `HttpTransport`, `PK`, `FUTURE`, `approvedStore` — reuse them). Add an import for the new export and two describes:

```ts
import { wrapClientWithBuilder } from "./hlRuntime";
import type { BuilderInjector } from "./builderInjector";

const BUILDER = ("0x" + "d".repeat(40)) as `0x${string}`;
const injector = (b: { b: `0x${string}`; f: number } | undefined): BuilderInjector => ({ builderFor: async () => b });

describe("wrapClientWithBuilder", () => {
  function fakeClient() {
    const calls: { order: unknown[]; cancel: unknown[]; sched: unknown[] } = { order: [], cancel: [], sched: [] };
    const client = {
      order: async (p: unknown) => { calls.order.push(p); return { ok: true }; },
      cancelByCloid: async (p: unknown) => { calls.cancel.push(p); return { ok: true }; },
      scheduleCancel: async (p: unknown) => { calls.sched.push(p); return { ok: true }; },
    } as unknown as import("./restingExecutor").RestingClientLike;
    return { client, calls };
  }

  it("merges the builder into order params for an approved owner", async () => {
    const { client, calls } = fakeClient();
    const wrapped = wrapClientWithBuilder(client, "0xo", injector({ b: BUILDER, f: 20 }));
    await wrapped.order({ orders: [{ a: 0 }], grouping: "na" });
    expect(calls.order[0]).toEqual({ orders: [{ a: 0 }], grouping: "na", builder: { b: BUILDER, f: 20 } });
  });

  it("leaves order params unchanged when the owner is not approved", async () => {
    const { client, calls } = fakeClient();
    const wrapped = wrapClientWithBuilder(client, "0xo", injector(undefined));
    await wrapped.order({ orders: [{ a: 0 }], grouping: "na" });
    expect(calls.order[0]).toEqual({ orders: [{ a: 0 }], grouping: "na" });
  });

  it("never attaches a builder to cancelByCloid or scheduleCancel", async () => {
    const { client, calls } = fakeClient();
    const wrapped = wrapClientWithBuilder(client, "0xo", injector({ b: BUILDER, f: 20 }));
    await wrapped.cancelByCloid({ cancels: [] });
    await (wrapped as unknown as { scheduleCancel(p: unknown): Promise<unknown> }).scheduleCancel({ time: 1 });
    expect(calls.cancel[0]).toEqual({ cancels: [] });
    expect(calls.sched[0]).toEqual({ time: 1 });
  });
});

describe("makeClientFor builder wiring", () => {
  const now = () => 0;

  it("wraps the local client so order() consults the injector for an approved owner", async () => {
    const builderFor = jest.fn(async () => undefined);
    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", privateKey: PK }), () => PK);
    const clientFor = makeClientFor(agents, {} as unknown as HttpTransport, now, undefined, { builderFor });
    const client = clientFor("0xo") as unknown as { order(p: unknown): Promise<unknown> };
    await client.order({ orders: [{ a: 0 }], grouping: "na" }).catch(() => undefined);
    expect(builderFor).toHaveBeenCalledWith("0xo");
  });

  it("does NOT apply the builder wrapper on the delegated (signer) path", async () => {
    const builderFor = jest.fn(async () => undefined);
    const signCalls: unknown[] = [];
    const signer = {
      sign: async (r: unknown) => { signCalls.push(r); return { r: "0xr", s: "0xs", v: 27, nonce: 1, duplicate: false }; },
      reconcile: async () => undefined,
    } as unknown as SignerLike;
    const transport = { request: async () => ({}) } as unknown as HttpTransport;
    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo" }), () => PK);
    const clientFor = makeClientFor(agents, transport, now, { signer, isTestnet: true }, { builderFor });
    const client = clientFor("0xo") as unknown as { order(p: unknown): Promise<unknown> };
    await client.order({ orders: [{ a: 0, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: "0xc" }], grouping: "na" });
    expect(builderFor).not.toHaveBeenCalled();
    expect(signCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx jest src/agent/hlRuntime.test.ts`
Expected: FAIL — `wrapClientWithBuilder` is not exported / `makeClientFor` ignores the 5th arg.

- [ ] **Step 3: Implement in `hlRuntime.ts`**

Add the import at the top:

```ts
import type { BuilderInjector } from "./builderInjector";
```

Add the exported wrapper above `makeClientFor`:

```ts
/**
 * Wrap a local HL client so `order` attaches the builder fee for approved owners (per the injector),
 * while `cancelByCloid` / `scheduleCancel` pass straight through (no fee). Methods are called on the
 * underlying client instance so `this` is preserved. A builder already on the params is not overwritten.
 */
export function wrapClientWithBuilder(
  client: RestingClientLike,
  owner: string,
  injector: BuilderInjector,
): RestingClientLike {
  const c = client as RestingClientLike & { scheduleCancel?: (p: unknown) => Promise<unknown> };
  return {
    order: async (params: unknown) => {
      const b = await injector.builderFor(owner);
      const p = (params ?? {}) as { builder?: unknown };
      const merged = b && p.builder === undefined ? { ...(params as object), builder: b } : params;
      return c.order(merged);
    },
    cancelByCloid: (params: unknown) => c.cancelByCloid(params),
    scheduleCancel: (params: unknown) => (c as { scheduleCancel: (p: unknown) => Promise<unknown> }).scheduleCancel(params),
  } as unknown as RestingClientLike;
}
```

Change `makeClientFor` to accept the injector and wrap the local branch. Replace the whole function:

```ts
export function makeClientFor(
  agents: AgentManager,
  transport: HttpTransport,
  now: () => number,
  delegation?: ClientForDelegation,
  builderInjector?: BuilderInjector,
): (owner: string) => RestingClientLike | undefined {
  const cache = new Map<string, RestingClientLike>();
  return (owner: string) => {
    if (!agents.status(owner, now()).approved) return undefined;
    const cached = cache.get(owner);
    if (cached) return cached;
    if (delegation) {
      const keyId = agents.keyIdFor(owner);
      if (keyId) {
        const client = makeSignerBackedExchangeClient({
          keyId,
          signer: delegation.signer,
          transport: transport as unknown as ExchangeTransport,
          isTestnet: delegation.isTestnet,
        }) as unknown as RestingClientLike;
        cache.set(owner, client);
        return client;
      }
    }
    const key = agents.privateKeyFor(owner);
    if (!key) return undefined;
    const wallet = privateKeyToAccount(key);
    const local = new ExchangeClient({ wallet, transport }) as unknown as RestingClientLike;
    const client = builderInjector ? wrapClientWithBuilder(local, owner, builderInjector) : local;
    cache.set(owner, client);
    return client;
  };
}
```

Update the `makeClientFor` JSDoc's last sentence to note the builder wrapper (optional, keeps it honest):

```ts
 * revoked/expired or key-less owner yields `undefined`, so the placer fails closed. When a builder
 * injector is supplied, the local client's `order` attaches the builder fee for approved owners.
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx jest src/agent/hlRuntime.test.ts && npx tsc --noEmit`
Expected: PASS (new + existing routing cases) + clean.

- [ ] **Step 5: Wire the injector in `index.ts`**

Add imports (near the other `agent/hlRuntime` / config imports):

```ts
import { makeBuilderInjector, type BuilderInfoLike } from "./agent/builderInjector";
```

After `info`/`resolvers` are built and before `clientFor`, construct the injector from the shared config:

```ts
  const builderCfg = appConfigFromEnv(process.env).builder;
  const builderInjector = builderCfg
    ? makeBuilderInjector({
        info: info as unknown as BuilderInfoLike,
        address: builderCfg.address,
        perpFeeTenthBps: builderCfg.perpFeeTenthBps,
        now,
      })
    : undefined;
```

Pass it as the 5th arg to `makeClientFor`:

```ts
  const clientFor = makeClientFor(
    agents,
    transport,
    now,
    delegation ? { signer: delegation.signer, isTestnet } : undefined,
    builderInjector,
  );
```

- [ ] **Step 6: Full validation**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (new builderInjector + hlRuntime cases; existing unaffected).

- [ ] **Step 7: Commit**

```bash
git add server/src/agent/hlRuntime.ts server/src/agent/hlRuntime.test.ts server/src/index.ts
git commit -m "feat(builder-fee): attach builder to engine local-key orders for approved owners

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Finish — PR, review, merge

- [ ] **Step 1: Full validation**

Run: `cd server && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/builder-fee-engine
```

- [ ] **Step 3: Open the PR** (`gh pr create`) summarizing: engine attaches the builder to local-key
  orders for approved owners; per-owner `maxBuilderFee` gate (cached, fail-open); cancels/scheduleCancel
  and the delegated path untouched; config reuses `appConfigFromEnv().builder`.

- [ ] **Step 4:** Dispatch a background `code-review` agent on the branch diff AND `gh pr checks <n> --watch` in parallel.

- [ ] **Step 5:** Address any high-confidence findings; on clean review + green CI, squash-merge with `--delete-branch` and sync `main`.

---

## Self-review notes (coverage vs spec)

- **Per-owner approval gate (`maxBuilderFee`), positive/negative caching, fail-open** — Task 1. ✔
- **Local `order` attaches builder for approved owners; cancels/scheduleCancel untouched** — Task 2 wrapper. ✔
- **Delegated path unchanged (no builder wrapper)** — Task 2 makeClientFor + test. ✔
- **Config reuses `appConfigFromEnv().builder`; injector only when configured** — Task 2 index.ts. ✔
- **No behavior change when no builder config (local client returned as today)** — Task 2 makeClientFor. ✔
