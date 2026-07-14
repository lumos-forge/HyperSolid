# Cutover Delegation PR ② — Signer-Backed Exchange Client + clientFor Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a signer-backed HL exchange client so that, for delegated (keyId-custody) owners, the engine signs every L1 action via the Go signer and submits the pre-signed action to Hyperliquid itself — never holding a private key. Still fully behind `SIGNER_DELEGATION` (off by default).

**Architecture:** A new `makeSignerBackedExchangeClient` implements the `order` / `cancelByCloid` / `scheduleCancel` surfaces used by the placer, resting executor, and dead-man executor. For each call it builds the canonical HL L1 action object (field order identical to the Go signer's `Build*Action`), calls `signer.sign`, submits `{action, signature, nonce}` to `transport.request("exchange", …)`, and best-effort reconciles the order lifecycle back to the signer. `makeClientFor` routes keyId records to this client; privateKey records keep the local `ExchangeClient`. The hash-critical action shape lives in one shared module (`l1Action.ts`) reused by the shadow verifier.

**Tech Stack:** TypeScript (server/), `@nktkas/hyperliquid` (`HttpTransport`, `createL1ActionHash`), Node `crypto`, Jest.

---

## Background / invariants (read before starting)

- **Signer `/v1/sign/l1` contract:** request `{ keyId, kind, params, cloid, isTestnet }` → response `{ r, s, v, nonce, duplicate }`. A **non-empty `cloid` is REQUIRED for every kind** (it is the nonce-ledger idempotency key; empty → 400 "missing cloid"). Reuse with the **same** action digest → `duplicate:true` (idempotent). Reuse with a **different** digest → 409 "cloid reuse mismatch".
- **Sign-then-submit:** the signer only signs; the engine submits the pre-signed action to HL `/exchange` via `transport.request("exchange", { action, signature:{r,s,v}, nonce })` (verified: `@nktkas/.../execute.js` submits exactly this shape). The `action` object must msgpack-hash to precisely what the signer signed, so it MUST be built in HL field order matching the Go `Build*Action`.
- **Canonical action field order (from `backend/internal/hl/action.go`):**
  - `order`: `{ type:"order", orders:[ { a, b, p, s, r, t:{limit:{tif}} (, c) } ], grouping }` — `c` omitted when cloid empty.
  - `cancelByCloid`: `{ type:"cancelByCloid", cancels:[ { asset, cloid } ] }`.
  - `scheduleCancel`: `{ type:"scheduleCancel" }` when no time, else `{ type:"scheduleCancel", time }`.
- **Signer `params` per kind (from `backend/internal/hl/digest.go` `ActionFromKind`):**
  - `order`: `{ asset, isBuy, px, sz, reduceOnly, tif, grouping, cloid }`.
  - `cancelByCloid`: `{ cancels:[ { asset, cloid } ] }`.
  - `scheduleCancel`: `{ time? }`.
- **Reconcile lifecycle:** after a successful sign the ledger record is `signed`. Valid forward edges from `signed`: `submitted`, `open`, `filled`, `canceled`, `rejected` (see `backend/internal/ledger/reconcile.go`). We reconcile **only `order`** (map the HL response); `cancelByCloid` / `scheduleCancel` are fire-and-forget control actions with per-content unique cloids, left at `signed` (never reused with a different digest, so harmless).
- **Fail-closed:** the placer/resting/deadMan already wrap `client.*` in try/catch and return `{ok:false}` / `false` on a throw. So a signer error (policy/notLeader/5xx → `SignerError`) or transport error must **propagate** out of the client methods; do not swallow.
- **HL cloid width:** `0x` + 32 hex chars (16 bytes), matching `cloidFor` in `scheduler.ts`.
- **The flag stays OFF this PR.** No behavior change unless `SIGNER_DELEGATION=1` AND a keyId record exists. All existing tests must pass unchanged.

**Files:**
- Create: `server/src/agent/l1Action.ts` — shared canonical L1 action builder + param types.
- Create: `server/src/agent/l1Action.test.ts`
- Modify: `server/src/agent/signerShadow.ts` — import `actionFromKindParams` from `./l1Action`, delete the local copy.
- Create: `server/src/agent/signerExchangeClient.ts` — `makeSignerBackedExchangeClient`.
- Create: `server/src/agent/signerExchangeClient.test.ts`
- Modify: `server/src/agent/hlRuntime.ts` — `makeClientFor` gains an optional delegation arg; routes keyId records to the signer-backed client.
- Create: `server/src/agent/hlRuntime.test.ts`
- Modify: `server/src/index.ts` — pass `{ signer, isTestnet }` to `makeClientFor` when delegation is on.

---

## Task 1: Extract the shared canonical L1 action builder

**Files:**
- Create: `server/src/agent/l1Action.ts`
- Create: `server/src/agent/l1Action.test.ts`
- Modify: `server/src/agent/signerShadow.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/l1Action.test.ts`:

```ts
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { actionFromKindParams } from "./l1Action";

describe("actionFromKindParams", () => {
  it("builds an order action in HL field order (cloid included)", () => {
    const a = actionFromKindParams("order", {
      asset: 3, isBuy: true, px: "100.0", sz: "0.5", reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0xabc",
    });
    expect(a).toEqual({
      type: "order",
      orders: [{ a: 3, b: true, p: "100.0", s: "0.5", r: false, t: { limit: { tif: "Ioc" } }, c: "0xabc" }],
      grouping: "na",
    });
  });

  it("omits the order cloid when absent and defaults grouping to na", () => {
    const a = actionFromKindParams("order", {
      asset: 1, isBuy: false, px: "1", sz: "1", reduceOnly: true, tif: "Alo",
    }) as { orders: Array<Record<string, unknown>>; grouping: string };
    expect("c" in a.orders[0]).toBe(false);
    expect(a.grouping).toBe("na");
  });

  it("builds a cancelByCloid action", () => {
    expect(actionFromKindParams("cancelByCloid", { cancels: [{ asset: 2, cloid: "0x1" }] })).toEqual({
      type: "cancelByCloid",
      cancels: [{ asset: 2, cloid: "0x1" }],
    });
  });

  it("builds scheduleCancel with and without a time", () => {
    expect(actionFromKindParams("scheduleCancel", { time: 123 })).toEqual({ type: "scheduleCancel", time: 123 });
    expect(actionFromKindParams("scheduleCancel", {})).toEqual({ type: "scheduleCancel" });
    expect(actionFromKindParams("scheduleCancel", undefined)).toEqual({ type: "scheduleCancel" });
  });

  it("returns undefined for an unsupported kind", () => {
    expect(actionFromKindParams("updateLeverage", {})).toBeUndefined();
  });

  it("produces a stable, hashable action (createL1ActionHash is deterministic)", () => {
    const a = actionFromKindParams("order", { asset: 0, isBuy: true, px: "50", sz: "1", reduceOnly: false, tif: "Ioc", cloid: "0xdeadbeef" });
    const h1 = createL1ActionHash({ action: a as Record<string, unknown>, nonce: 1 });
    const h2 = createL1ActionHash({ action: a as Record<string, unknown>, nonce: 1 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]+$/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/agent/l1Action.test.ts`
Expected: FAIL — `Cannot find module './l1Action'`.

- [ ] **Step 3: Create `server/src/agent/l1Action.ts`**

```ts
/**
 * Canonical HL L1 action builder shared by the shadow verifier and the signer-backed exchange client.
 * The object returned here is msgpack-hashed (with a nonce) to produce exactly the digest the Go signer
 * signs, so the field ORDER and shape must stay identical to the signer's `Build*Action`
 * (backend/internal/hl/action.go). This is the single source of truth for that shape.
 */

/** Semantic params for a single limit `order` (mirrors the signer's ActionFromKind "order" case). */
export interface OrderParams {
  asset: number;
  isBuy: boolean;
  px: string;
  sz: string;
  reduceOnly: boolean;
  tif: string; // "Gtc" | "Ioc" | "Alo"
  grouping?: string; // default "na"
  cloid?: string;
}

/** Semantic params for a `cancelByCloid` action. */
export interface CancelByCloidParams {
  cancels: Array<{ asset: number; cloid: string }>;
}

/** Semantic params for a `scheduleCancel` (dead-man switch) action. */
export interface ScheduleCancelParams {
  time?: number;
}

/**
 * Build the raw HL action object from a semantic kind + params. Returns undefined for kinds this engine
 * does not emit. Fields are emitted in HL byte order to match the signer's Go builders exactly.
 */
export function actionFromKindParams(kind: string, params: unknown): Record<string, unknown> | undefined {
  if (kind === "order") {
    const p = params as OrderParams;
    const o: Record<string, unknown> = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    return { type: "order", orders: [o], grouping: p.grouping ?? "na" };
  }
  if (kind === "cancelByCloid") {
    const p = params as CancelByCloidParams;
    return { type: "cancelByCloid", cancels: p.cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })) };
  }
  if (kind === "scheduleCancel") {
    const p = (params ?? {}) as ScheduleCancelParams;
    return p.time === undefined ? { type: "scheduleCancel" } : { type: "scheduleCancel", time: p.time };
  }
  return undefined;
}
```

- [ ] **Step 4: Refactor `signerShadow.ts` to use the shared builder**

In `server/src/agent/signerShadow.ts`, add the import near the top (after the existing `createL1ActionHash` import):

```ts
import { actionFromKindParams } from "./l1Action";
```

Then DELETE the entire local `function actionFromKindParams(...) { ... }` block (the one with the JSDoc "Build the raw HL action object from a semantic kind + params (only `order` is mapped for now)."). The `makeShadowVerifier` body already calls `actionFromKindParams(kind, params)` — it now resolves to the import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx jest src/agent/l1Action.test.ts src/agent/signerShadow.test.ts`
Expected: PASS (both the new l1Action suite and the untouched shadow suite).

- [ ] **Step 6: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: clean (no output).

- [ ] **Step 7: Commit**

```bash
git add server/src/agent/l1Action.ts server/src/agent/l1Action.test.ts server/src/agent/signerShadow.ts
git commit -m "refactor(cutover): extract shared canonical L1 action builder

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: SignerBackedExchangeClient

**Files:**
- Create: `server/src/agent/signerExchangeClient.ts`
- Create: `server/src/agent/signerExchangeClient.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/signerExchangeClient.test.ts`:

```ts
import { makeSignerBackedExchangeClient, type ExchangeTransport, type SignerLike } from "./signerExchangeClient";
import { SignerError } from "./signerClient";

const SIG = { r: "0xr", s: "0xs", v: 27, nonce: 42, duplicate: false };

function fakeSigner(over: Partial<SignerLike> = {}): {
  signer: SignerLike;
  signCalls: unknown[];
  reconcileCalls: unknown[];
} {
  const signCalls: unknown[] = [];
  const reconcileCalls: unknown[] = [];
  const signer: SignerLike = {
    sign: async (req) => {
      signCalls.push(req);
      return SIG;
    },
    reconcile: async (keyId, cloid, status) => {
      reconcileCalls.push({ keyId, cloid, status });
    },
    ...over,
  };
  return { signer, signCalls, reconcileCalls };
}

function fakeTransport(res: unknown): { transport: ExchangeTransport; calls: Array<{ endpoint: string; payload: unknown }> } {
  const calls: Array<{ endpoint: string; payload: unknown }> = [];
  const transport: ExchangeTransport = {
    request: async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      return res;
    },
  };
  return { transport, calls };
}

const ORDER_ARG = {
  orders: [{ a: 3, b: true, p: "100.0", s: "0.5", r: false, t: { limit: { tif: "Ioc" as const } }, c: "0xcloid" }],
  grouping: "na" as const,
};

describe("makeSignerBackedExchangeClient.order", () => {
  it("signs the order (kind+params+cloid), submits the pre-signed action, reconciles filled", async () => {
    const { signer, signCalls, reconcileCalls } = fakeSigner();
    const filled = { response: { data: { statuses: [{ filled: { totalSz: "0.5", avgPx: "100" } }] } } };
    const { transport, calls } = fakeTransport(filled);
    const client = makeSignerBackedExchangeClient({ keyId: "agent:0xo", signer, transport, isTestnet: true });

    const res = await client.order(ORDER_ARG);

    expect(signCalls).toEqual([
      { keyId: "agent:0xo", kind: "order", params: { asset: 3, isBuy: true, px: "100.0", sz: "0.5", reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0xcloid" }, cloid: "0xcloid", isTestnet: true },
    ]);
    expect(calls).toEqual([
      {
        endpoint: "exchange",
        payload: {
          action: { type: "order", orders: [{ a: 3, b: true, p: "100.0", s: "0.5", r: false, t: { limit: { tif: "Ioc" } }, c: "0xcloid" }], grouping: "na" },
          signature: { r: "0xr", s: "0xs", v: 27 },
          nonce: 42,
        },
      },
    ]);
    expect(reconcileCalls).toEqual([{ keyId: "agent:0xo", cloid: "0xcloid", status: "filled" }]);
    expect(res).toBe(filled);
  });

  it("reconciles open when the order rests", async () => {
    const { signer, reconcileCalls } = fakeSigner();
    const { transport } = fakeTransport({ response: { data: { statuses: [{ resting: { oid: 7 } }] } } });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.order(ORDER_ARG);
    expect(reconcileCalls).toEqual([{ keyId: "k", cloid: "0xcloid", status: "open" }]);
  });

  it("reconciles rejected on an error status", async () => {
    const { signer, reconcileCalls } = fakeSigner();
    const { transport } = fakeTransport({ response: { data: { statuses: [{ error: "bad" }] } } });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.order(ORDER_ARG);
    expect(reconcileCalls).toEqual([{ keyId: "k", cloid: "0xcloid", status: "rejected" }]);
  });

  it("propagates a SignerError from sign (caller fails closed) and never submits", async () => {
    const { signer } = fakeSigner({ sign: async () => { throw new SignerError(403, "policy", "denied"); } });
    const { transport, calls } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await expect(client.order(ORDER_ARG)).rejects.toBeInstanceOf(SignerError);
    expect(calls).toEqual([]);
  });

  it("does not throw if reconcile fails (best-effort) and still returns the response", async () => {
    const { signer } = fakeSigner({ reconcile: async () => { throw new Error("reconcile down"); } });
    const filled = { response: { data: { statuses: [{ filled: { totalSz: "1", avgPx: "1" } }] } } };
    const { transport } = fakeTransport(filled);
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await expect(client.order(ORDER_ARG)).resolves.toBe(filled);
  });
});

describe("makeSignerBackedExchangeClient.cancelByCloid", () => {
  it("signs cancelByCloid with a derived cloid and submits the action (no reconcile)", async () => {
    const { signer, signCalls, reconcileCalls } = fakeSigner();
    const { transport, calls } = fakeTransport({ ok: true });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: true });

    await client.cancelByCloid({ cancels: [{ asset: 2, cloid: "0xaa" }, { asset: 5, cloid: "0xbb" }] });

    const call = signCalls[0] as { keyId: string; kind: string; params: unknown; cloid: string; isTestnet: boolean };
    expect(call.kind).toBe("cancelByCloid");
    expect(call.params).toEqual({ cancels: [{ asset: 2, cloid: "0xaa" }, { asset: 5, cloid: "0xbb" }] });
    expect(call.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(calls[0]).toEqual({
      endpoint: "exchange",
      payload: {
        action: { type: "cancelByCloid", cancels: [{ asset: 2, cloid: "0xaa" }, { asset: 5, cloid: "0xbb" }] },
        signature: { r: "0xr", s: "0xs", v: 27 },
        nonce: 42,
      },
    });
    expect(reconcileCalls).toEqual([]);
  });

  it("derives the same cloid for the same cancel set and a different one otherwise", async () => {
    const { signer, signCalls } = fakeSigner();
    const { transport } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: true });
    await client.cancelByCloid({ cancels: [{ asset: 1, cloid: "0x1" }] });
    await client.cancelByCloid({ cancels: [{ asset: 1, cloid: "0x1" }] });
    await client.cancelByCloid({ cancels: [{ asset: 2, cloid: "0x2" }] });
    const cloids = signCalls.map((c) => (c as { cloid: string }).cloid);
    expect(cloids[0]).toBe(cloids[1]);
    expect(cloids[0]).not.toBe(cloids[2]);
  });
});

describe("makeSignerBackedExchangeClient.scheduleCancel", () => {
  it("signs scheduleCancel with a time and submits the action", async () => {
    const { signer, signCalls, reconcileCalls } = fakeSigner();
    const { transport, calls } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.scheduleCancel({ time: 1_700_000_000_000 });
    const call = signCalls[0] as { kind: string; params: unknown; cloid: string };
    expect(call.kind).toBe("scheduleCancel");
    expect(call.params).toEqual({ time: 1_700_000_000_000 });
    expect(call.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(calls[0].payload).toEqual({
      action: { type: "scheduleCancel", time: 1_700_000_000_000 },
      signature: { r: "0xr", s: "0xs", v: 27 },
      nonce: 42,
    });
    expect(reconcileCalls).toEqual([]);
  });

  it("signs a bare scheduleCancel (clear) when no time is given", async () => {
    const { signer, signCalls } = fakeSigner();
    const { transport, calls } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.scheduleCancel({});
    expect((signCalls[0] as { params: unknown }).params).toEqual({});
    expect((calls[0].payload as { action: unknown }).action).toEqual({ type: "scheduleCancel" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/agent/signerExchangeClient.test.ts`
Expected: FAIL — `Cannot find module './signerExchangeClient'`.

- [ ] **Step 3: Create `server/src/agent/signerExchangeClient.ts`**

```ts
import { createHash } from "node:crypto";
import type { SignerClient, ReconcileStatus } from "./signerClient";
import { actionFromKindParams } from "./l1Action";

/** Minimal HL transport surface: submit a pre-signed action to /exchange. @nktkas HttpTransport satisfies it. */
export interface ExchangeTransport {
  request(endpoint: "exchange", payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** The signer methods this client needs: sign an action, and reconcile an order's lifecycle. */
export type SignerLike = Pick<SignerClient, "sign" | "reconcile">;

export interface SignerExchangeDeps {
  /** The signer keyId that custodies this owner's agent key. */
  keyId: string;
  signer: SignerLike;
  transport: ExchangeTransport;
  isTestnet: boolean;
}

/** The `orders[0]` tuple the placer/resting executor build (HL field-letter shape). */
interface OrderTuple {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: string } };
  c?: string;
}
interface OrderArg {
  orders: OrderTuple[];
  grouping?: string;
}
interface CancelByCloidArg {
  cancels: Array<{ asset: number; cloid: string }>;
}

/** A 16-byte (0x + 32 hex) HL cloid deterministically derived from an action's content, so identical
 *  retries dedupe at the signer's nonce ledger and distinct actions get distinct idempotency keys. */
function deriveCloid(seed: string): string {
  return "0x" + createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** Map an HL /exchange order response to a reconcile status (all valid `signed → X` edges). */
function reconcileStatusFromRes(res: unknown): ReconcileStatus {
  const st = (res as { response?: { data?: { statuses?: Array<{ filled?: unknown; resting?: unknown; error?: unknown }> } } })
    ?.response?.data?.statuses?.[0];
  if (st?.filled) return "filled";
  if (st?.resting) return "open";
  if (st?.error) return "rejected";
  return "submitted";
}

/**
 * The engine-side signer-backed HL client for delegated (keyId-custody) owners. It holds NO key: for
 * each action it (1) builds the canonical L1 action, (2) has the signer sign it, (3) submits the
 * pre-signed `{action, signature, nonce}` to HL /exchange itself, and (4) best-effort reconciles the
 * order lifecycle. Structurally satisfies the placer / resting / dead-man client surfaces
 * (`order` / `cancelByCloid` / `scheduleCancel`). Signer and transport errors PROPAGATE so callers fail
 * closed; only reconcile is swallowed (best-effort telemetry, never blocks the trade).
 */
export function makeSignerBackedExchangeClient(deps: SignerExchangeDeps) {
  const { keyId, signer, transport, isTestnet } = deps;

  async function signAndSubmit(kind: string, params: unknown, cloid: string): Promise<unknown> {
    const action = actionFromKindParams(kind, params);
    if (!action) throw new Error(`unsupported signer action kind: ${kind}`);
    const sig = await signer.sign({ keyId, kind, params, cloid, isTestnet });
    return transport.request("exchange", {
      action,
      signature: { r: sig.r, s: sig.s, v: sig.v },
      nonce: sig.nonce,
    });
  }

  return {
    async order(arg: OrderArg): Promise<unknown> {
      const o = arg.orders[0];
      const grouping = arg.grouping ?? "na";
      const cloid = o.c ?? deriveCloid(`order:${o.a}:${o.b}:${o.p}:${o.s}:${o.r}:${o.t.limit.tif}:${grouping}`);
      const params = { asset: o.a, isBuy: o.b, px: o.p, sz: o.s, reduceOnly: o.r, tif: o.t.limit.tif, grouping, cloid };
      const res = await signAndSubmit("order", params, cloid);
      void signer.reconcile(keyId, cloid, reconcileStatusFromRes(res)).catch(() => undefined);
      return res;
    },

    async cancelByCloid(arg: CancelByCloidArg): Promise<unknown> {
      const cancels = arg.cancels.map((c) => ({ asset: c.asset, cloid: c.cloid }));
      const cloid = deriveCloid(`cancelByCloid:${cancels.map((c) => `${c.asset}:${c.cloid}`).join(",")}`);
      return signAndSubmit("cancelByCloid", { cancels }, cloid);
    },

    async scheduleCancel(arg: { time?: number }): Promise<unknown> {
      const params = arg.time === undefined ? {} : { time: arg.time };
      const cloid = deriveCloid(`scheduleCancel:${arg.time ?? "clear"}`);
      return signAndSubmit("scheduleCancel", params, cloid);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest src/agent/signerExchangeClient.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/signerExchangeClient.ts server/src/agent/signerExchangeClient.test.ts
git commit -m "feat(cutover): signer-backed exchange client (sign -> submit -> reconcile)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Route keyId records through `makeClientFor` + wire index.ts

**Files:**
- Modify: `server/src/agent/hlRuntime.ts`
- Create: `server/src/agent/hlRuntime.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/hlRuntime.test.ts`:

```ts
import type { HttpTransport } from "@nktkas/hyperliquid";
import { AgentManager, MemoryAgentStore } from "./agentManager";
import { makeClientFor } from "./hlRuntime";
import type { SignerLike, ExchangeTransport } from "./signerExchangeClient";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const FUTURE = 9_999_999_999_999;

function approvedStore(rec: { owner: string; agentAddress: string; privateKey?: `0x${string}`; keyId?: string }): MemoryAgentStore {
  const store = new MemoryAgentStore();
  store.set({ ...rec, approved: true, validUntil: FUTURE });
  return store;
}

describe("makeClientFor delegation routing", () => {
  const now = () => 0;

  it("routes a keyId record to a signer-backed client (order calls the signer)", async () => {
    const signCalls: unknown[] = [];
    const signer = {
      sign: async (req: unknown) => { signCalls.push(req); return { r: "0xr", s: "0xs", v: 27, nonce: 1, duplicate: false }; },
      reconcile: async () => undefined,
    } as unknown as SignerLike;
    const submitted: unknown[] = [];
    const transport = { request: async (_e: string, p: unknown) => { submitted.push(p); return {}; } } as unknown as HttpTransport;

    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo" }), () => PK);
    const clientFor = makeClientFor(agents, transport, now, { signer, isTestnet: true });

    const client = clientFor("0xo") as unknown as { order(a: unknown): Promise<unknown> };
    expect(client).toBeDefined();
    await client.order({ orders: [{ a: 0, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: "0xc" }], grouping: "na" });
    expect(signCalls).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it("returns a (local) client for a privateKey record and never touches the signer", () => {
    const signer = { sign: async () => { throw new Error("should not sign"); }, reconcile: async () => undefined } as unknown as SignerLike;
    const transport = {} as unknown as HttpTransport;
    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", privateKey: PK }), () => PK);
    const clientFor = makeClientFor(agents, transport, now, { signer, isTestnet: true });
    expect(clientFor("0xo")).toBeDefined();
  });

  it("returns undefined for an unapproved owner", () => {
    const signer = { sign: async () => ({}), reconcile: async () => undefined } as unknown as SignerLike;
    const store = new MemoryAgentStore();
    store.set({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo", approved: false });
    const agents = new AgentManager(store, () => PK);
    const clientFor = makeClientFor(agents, {} as unknown as HttpTransport, now, { signer, isTestnet: true });
    expect(clientFor("0xo")).toBeUndefined();
  });

  it("without delegation, a keyId-only record yields undefined (no local key to sign with)", () => {
    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo" }), () => PK);
    const clientFor = makeClientFor(agents, {} as unknown as HttpTransport, now);
    expect(clientFor("0xo")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/agent/hlRuntime.test.ts`
Expected: FAIL — `makeClientFor` does not accept a 4th arg / keyId record returns undefined.

- [ ] **Step 3: Modify `server/src/agent/hlRuntime.ts`**

Add imports at the top (after the existing imports):

```ts
import { makeSignerBackedExchangeClient, type SignerLike, type ExchangeTransport } from "./signerExchangeClient";
```

Add the delegation config type just above `makeClientFor`:

```ts
/** When present, owners whose agent key is custodied by the signer (keyId records) are routed to a
 *  signer-backed client instead of a local ExchangeClient. */
export interface ClientForDelegation {
  signer: SignerLike;
  isTestnet: boolean;
}
```

Replace the entire `makeClientFor` function body with:

```ts
export function makeClientFor(
  agents: AgentManager,
  transport: HttpTransport,
  now: () => number,
  delegation?: ClientForDelegation,
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
    const client = new ExchangeClient({ wallet, transport }) as unknown as RestingClientLike;
    cache.set(owner, client);
    return client;
  };
}
```

Also update the JSDoc above `makeClientFor` to reflect dual routing (replace the existing block comment):

```ts
/**
 * Build the placer's `clientFor`: a per-owner HL client, but only while the owner's agent is approved
 * and unexpired. When delegation is configured and the owner is a keyId (signer-custody) record, returns
 * a signer-backed client (signs via the Go signer, submits the pre-signed action); otherwise an
 * agent-signed local ExchangeClient whose key never leaves the process. Clients are cached per owner; a
 * revoked/expired or key-less owner yields `undefined`, so the placer fails closed.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest src/agent/hlRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire delegation into `index.ts`**

In `server/src/index.ts`, find the `clientFor` construction:

```ts
  const clientFor = makeClientFor(agents, transport, now);
```

Replace it with:

```ts
  const clientFor = makeClientFor(
    agents,
    transport,
    now,
    delegation ? { signer: delegation.signer, isTestnet } : undefined,
  );
```

(`delegation` is the `DelegationDeps | undefined` already built in PR ①; `isTestnet` is already in scope.)

- [ ] **Step 6: Typecheck + full test suite**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (existing 430 + new l1Action, signerExchangeClient, hlRuntime cases).

- [ ] **Step 7: Commit**

```bash
git add server/src/agent/hlRuntime.ts server/src/agent/hlRuntime.test.ts server/src/index.ts
git commit -m "feat(cutover): route keyId owners to the signer-backed client

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Finish — validate, PR, review, merge

- [ ] **Step 1: Full validation**

Run: `cd server && npm run typecheck && npm test`
Expected: tsc clean; all suites green.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/cutover-delegation-2-signing
```

- [ ] **Step 3: Open the PR** (`gh pr create`) summarizing: signer-backed exchange client (sign→submit→reconcile), keyId routing in `makeClientFor`, shared `l1Action` builder; flag still OFF; signing unchanged for local-key records.

- [ ] **Step 4:** Dispatch a background `code-review` agent on the branch diff AND run `gh pr checks <n> --watch` in parallel.

- [ ] **Step 5:** Address any high-confidence review findings; on clean review + green CI, squash-merge with `--delete-branch` and sync `main` (standing rule: merge directly).

---

## Self-review notes (coverage vs spec)

- **§4 SignerBackedExchangeClient** — Task 2 (order/cancelByCloid/scheduleCancel; sign→submit→reconcile; errors propagate). ✔
- **§5 makeClientFor routing** — Task 3 (keyId→signer-backed, privateKey→local, unapproved→undefined). ✔
- **§ Canonical-action correctness** — Task 1 centralizes the action shape (matched to the Go builders) + hash determinism test; shadow verifier stays live (unchanged) as the cross-check; testnet validation happens in PR ③. ✔
- **§ Config/flag** — Task 3 Step 5 reuses the PR ① `delegation` (flag stays OFF by default). ✔
- **Reconcile scope** — order only (control actions left at `signed`, per-content unique cloids). Documented in Background. ✔
- **Fail-closed** — signer/transport errors propagate; placer/resting/deadMan already return `{ok:false}`/`false` on throw. ✔
