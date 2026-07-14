# Cutover Delegation Validation Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `npm run validate:delegation` harness that proves the delegated signing path is correct against a live signer (health + canonical-action parity + provision/sign/ecrecover), with an optional `--place` testnet E2E — a PASS/FAIL report + exit code to gate the `SIGNER_DELEGATION` flip.

**Architecture:** A tested core `runValidation(deps)` (injected deps) + a thin CLI wrapper that wires the real `SignerClient`, a `/v1/digest/l1` fetch, `@nktkas` `createL1ActionHash`, viem `hashTypedData`/`recoverAddress`, and an optional `HttpTransport` submit. No production-code change.

**Tech Stack:** TypeScript (server/), `@nktkas/hyperliquid`, viem (present), Jest.

**Spec:** `docs/superpowers/specs/2026-07-14-validate-delegation-harness-design.md`

---

## Background / invariants (read first)

- Signer endpoints (live): `GET /healthz`, `POST /v1/digest/l1` `{kind,params,nonce,isTestnet}` → `{actionHash}`, `POST /v1/keys`, `DELETE /v1/keys/{keyId}`, `POST /v1/sign/l1` → `{r,s,v,nonce,duplicate}`, `POST /v1/reconcile`.
- The engine's canonical action builder is `src/agent/l1Action.ts` `actionFromKindParams(kind, params)` (order ± cloid ± builder, cancelByCloid, scheduleCancel). `@nktkas/hyperliquid/signing` `createL1ActionHash({action, nonce})` is the local hash. **Both are already golden-verified** against the Go signer — the harness re-checks them against a *live* signer.
- The **phantom-agent EIP-712** digest (verified working in this repo): `hashTypedData({ domain:{name:"Exchange",version:"1",chainId:1337,verifyingContract: ZERO}, types:{Agent:[{name:"source",type:"string"},{name:"connectionId",type:"bytes32"}]}, primaryType:"Agent", message:{ source: isTestnet?"b":"a", connectionId: createL1ActionHash({action, nonce}) } })`. `recoverAddress({ hash, signature:{r,s,v} })` recovers the signer's agent address. (Confirmed round-trip with viem + a test key.)
- `SignerClient` (production) has `createKey`/`sign`/`deleteKey`/`reconcile`; **do not modify it** — the harness injects a `digest` fetch itself.
- Server has no `tsx`; run the built JS: `npm run build` (tsc) → `node dist/scripts/validateDelegation.js`. tsc compiles CommonJS → **no top-level await** (wrap in `main()`).
- Validate: `cd server && npm run typecheck && npm test`.

**Files:**
- Create: `server/src/agent/validateDelegation.ts` (+ `validateDelegation.test.ts`)
- Create: `server/src/scripts/validateDelegation.ts`
- Modify: `server/package.json` (add the `validate:delegation` script)

---

## Task 1: `runValidation` core + vectors + tests

**Files:** Create `server/src/agent/validateDelegation.ts`, `server/src/agent/validateDelegation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/agent/validateDelegation.test.ts`:

```ts
import { runValidation, buildValidationVectors, VALIDATE_NONCE, type ValidateDeps } from "./validateDelegation";
import { actionFromKindParams } from "./l1Action";

const AGENT = ("0x" + "a".repeat(40)) as `0x${string}`;
const OWNER = ("0x" + "1".repeat(40)) as `0x${string}`;

function baseDeps(over: Partial<ValidateDeps> = {}): { deps: ValidateDeps; deleted: string[] } {
  const deleted: string[] = [];
  const deps: ValidateDeps = {
    isTestnet: true,
    owner: OWNER,
    health: async () => true,
    // faithful digest: return exactly what localHash computes for the built action
    digest: async ({ kind, params, nonce }) => ({ actionHash: fakeHash(kind, params, nonce) }),
    localHash: (_action, nonce) => `h:${nonce}`, // deterministic; overridden per-test to match/mismatch
    agentDigest: () => ("0x" + "d".repeat(64)) as `0x${string}`,
    recover: async () => AGENT,
    signer: {
      createKey: async () => ({ keyId: "k", agentAddress: AGENT }),
      sign: async () => ({ r: "0xr", s: "0xs", v: 27, nonce: 1, duplicate: false }),
      deleteKey: async (id: string) => { deleted.push(id); },
    } as unknown as ValidateDeps["signer"],
    ...over,
  };
  return { deps, deleted };
}

// A stand-in hash keyed off the canonical action shape so "faithful digest" == localHash by construction.
function fakeHash(kind: string, params: unknown, nonce: number): string {
  const action = actionFromKindParams(kind, params);
  return `${JSON.stringify(action)}:${nonce}`;
}

describe("runValidation", () => {
  it("passes when health ok, parity matches, and the signature recovers to the agent", async () => {
    const { deps, deleted } = baseDeps({ localHash: (action, nonce) => `${JSON.stringify(action)}:${nonce}` });
    const report = await runValidation(deps);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "health")?.ok).toBe(true);
    expect(report.checks.filter((c) => c.name.startsWith("parity:")).every((c) => c.ok)).toBe(true);
    expect(report.checks.find((c) => c.name === "provision-sign-recover")?.ok).toBe(true);
    expect(deleted).toContain("k"); // cleanup happened
  });

  it("fails a parity check when the signer's actionHash differs", async () => {
    const { deps } = baseDeps({
      localHash: (action, nonce) => `${JSON.stringify(action)}:${nonce}`,
      digest: async () => ({ actionHash: "different" }),
    });
    const report = await runValidation(deps);
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => c.name.startsWith("parity:")).some((c) => !c.ok)).toBe(true);
  });

  it("fails provision-sign-recover when the signature recovers to a different address", async () => {
    const { deps } = baseDeps({
      localHash: (action, nonce) => `${JSON.stringify(action)}:${nonce}`,
      recover: async () => ("0x" + "b".repeat(40)) as `0x${string}`,
    });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "provision-sign-recover")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("reports a health failure", async () => {
    const { deps } = baseDeps({ localHash: (a, n) => `${JSON.stringify(a)}:${n}`, health: async () => false });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "health")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("still cleans up the key when signing throws", async () => {
    const { deps, deleted } = baseDeps({
      localHash: (a, n) => `${JSON.stringify(a)}:${n}`,
      signer: {
        createKey: async () => ({ keyId: "k", agentAddress: AGENT }),
        sign: async () => { throw new Error("sign boom"); },
        deleteKey: async (id: string) => { deleted.push(id); },
      } as unknown as ValidateDeps["signer"],
    });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "provision-sign-recover")?.ok).toBe(false);
    expect(deleted).toContain("k");
  });

  it("includes a place check only when a place fn is provided", async () => {
    const { deps } = baseDeps({ localHash: (a, n) => `${JSON.stringify(a)}:${n}`, place: async () => ({ ok: true, detail: "filled" }) });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "place")?.ok).toBe(true);
    const { deps: d2 } = baseDeps({ localHash: (a, n) => `${JSON.stringify(a)}:${n}` });
    expect((await runValidation(d2)).checks.find((c) => c.name === "place")).toBeUndefined();
  });

  it("builds parity vectors incl. order-builder", () => {
    const names = buildValidationVectors().map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(["order-gtc", "order-cloid", "order-builder", "cancelByCloid", "scheduleCancel"]));
    expect(VALIDATE_NONCE).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `cd server && npx jest src/agent/validateDelegation.test.ts`
Expected: FAIL — `Cannot find module './validateDelegation'`.

- [ ] **Step 3: Create `server/src/agent/validateDelegation.ts`**

```ts
import { actionFromKindParams } from "./l1Action";
import type { SignerClient } from "./signerClient";

/** Fixed nonce for the parity/recover checks (encoding is nonce-arbitrary; the hash is nonce-dependent). */
export const VALIDATE_NONCE = 1_700_000_000_000;

export interface DigestResult {
  actionHash: string;
}
export interface Sig {
  r: string;
  s: string;
  v: number;
}

/** Injected surface so the core is unit-testable without a live signer / chain. */
export interface ValidateDeps {
  isTestnet: boolean;
  owner: `0x${string}`;
  health(): Promise<boolean>;
  digest(req: { kind: string; params: unknown; nonce: number; isTestnet: boolean }): Promise<DigestResult>;
  localHash(action: Record<string, unknown>, nonce: number): string;
  agentDigest(action: Record<string, unknown>, nonce: number, isTestnet: boolean): `0x${string}`;
  recover(digest: `0x${string}`, sig: Sig): Promise<`0x${string}`>;
  signer: Pick<SignerClient, "createKey" | "sign" | "deleteKey">;
  /** Optional fund-moving testnet place (only wired with --place). */
  place?: () => Promise<{ ok: boolean; detail: string }>;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface ValidationReport {
  ok: boolean;
  checks: Check[];
}

export interface ValidationVector {
  name: string;
  kind: string;
  params: Record<string, unknown>;
}

/** Representative actions covering the delegated path's encodings (incl. the builder fee field). */
export function buildValidationVectors(): ValidationVector[] {
  const cloid = "0x00000000000000000000000000000001";
  const builder = { b: ("0x" + "11".repeat(20)) as `0x${string}`, f: 20 };
  const order = { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na" };
  return [
    { name: "order-gtc", kind: "order", params: { ...order } },
    { name: "order-cloid", kind: "order", params: { ...order, cloid } },
    { name: "order-builder", kind: "order", params: { ...order, builder } },
    { name: "cancelByCloid", kind: "cancelByCloid", params: { cancels: [{ asset: 2, cloid }] } },
    { name: "scheduleCancel", kind: "scheduleCancel", params: { time: VALIDATE_NONCE } },
  ];
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run the pre-flip validation of the delegated signing path against a live signer (via injected deps):
 * health, canonical-action parity (engine `l1Action` vs the signer's /v1/digest/l1), and a
 * provision→sign→ecrecover proof (the signer signs a digest that recovers to the agent it reported).
 * With `deps.place`, also runs a fund-moving testnet place. Every check runs; `ok` is the AND of all.
 */
export async function runValidation(deps: ValidateDeps): Promise<ValidationReport> {
  const checks: Check[] = [];

  try {
    checks.push({ name: "health", ok: await deps.health(), detail: "GET /healthz" });
  } catch (e) {
    checks.push({ name: "health", ok: false, detail: msg(e) });
  }

  for (const v of buildValidationVectors()) {
    try {
      const action = actionFromKindParams(v.kind, v.params);
      if (!action) {
        checks.push({ name: `parity:${v.name}`, ok: false, detail: "unsupported kind" });
        continue;
      }
      const local = deps.localHash(action, VALIDATE_NONCE);
      const remote = await deps.digest({ kind: v.kind, params: v.params, nonce: VALIDATE_NONCE, isTestnet: deps.isTestnet });
      const ok = local.toLowerCase() === remote.actionHash.toLowerCase();
      checks.push({ name: `parity:${v.name}`, ok, detail: ok ? "hash match" : `local=${local} remote=${remote.actionHash}` });
    } catch (e) {
      checks.push({ name: `parity:${v.name}`, ok: false, detail: msg(e) });
    }
  }

  const keyId = "validate:" + Math.random().toString(16).slice(2);
  try {
    const { agentAddress } = await deps.signer.createKey({
      keyId,
      ownerAddress: deps.owner,
      allowedKinds: ["order", "cancel", "cancelByCloid", "scheduleCancel"],
      maxNotionalUsdc: 1000,
    });
    const cloid = "0x" + "0".repeat(31) + "2";
    const params = { asset: 0, isBuy: true, px: "50000", sz: "0.001", reduceOnly: false, tif: "Ioc", grouping: "na", cloid };
    const sig = await deps.signer.sign({ keyId, kind: "order", params, cloid, isTestnet: deps.isTestnet });
    const action = actionFromKindParams("order", params) as Record<string, unknown>;
    const digest = deps.agentDigest(action, sig.nonce, deps.isTestnet);
    const recovered = await deps.recover(digest, { r: sig.r, s: sig.s, v: sig.v });
    const ok = recovered.toLowerCase() === agentAddress.toLowerCase();
    checks.push({ name: "provision-sign-recover", ok, detail: ok ? `recovered ${recovered}` : `recovered ${recovered} != agent ${agentAddress}` });
  } catch (e) {
    checks.push({ name: "provision-sign-recover", ok: false, detail: msg(e) });
  } finally {
    try {
      await deps.signer.deleteKey(keyId);
    } catch {
      /* best-effort cleanup */
    }
  }

  if (deps.place) {
    try {
      const r = await deps.place();
      checks.push({ name: "place", ok: r.ok, detail: r.detail });
    } catch (e) {
      checks.push({ name: "place", ok: false, detail: msg(e) });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
```

- [ ] **Step 4: Run to pass + typecheck**

Run: `cd server && npx jest src/agent/validateDelegation.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/validateDelegation.ts server/src/agent/validateDelegation.test.ts
git commit -m "feat(cutover): delegation validation core (health/parity/sign-recover)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: CLI wrapper + npm script

**Files:** Create `server/src/scripts/validateDelegation.ts`; modify `server/package.json`

- [ ] **Step 1: Create the CLI**

Create `server/src/scripts/validateDelegation.ts`:

```ts
import { HttpTransport } from "@nktkas/hyperliquid";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { hashTypedData, recoverAddress, type Hex } from "viem";
import { SignerClient } from "../agent/signerClient";
import { actionFromKindParams } from "../agent/l1Action";
import { runValidation, VALIDATE_NONCE, type ValidateDeps } from "../agent/validateDelegation";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

/** Phantom-agent EIP-712 digest for an L1 action (domain Exchange / chainId 1337), matching the signer. */
function agentDigest(action: Record<string, unknown>, nonce: number, isTestnet: boolean): `0x${string}` {
  return hashTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: isTestnet ? "b" : "a", connectionId: createL1ActionHash({ action, nonce }) as Hex },
  });
}

async function main(): Promise<void> {
  const url = requireEnv("SIGNER_URL").replace(/\/$/, "");
  const isTestnet = process.env.HL_NETWORK !== "mainnet";
  const owner = (process.env.VALIDATE_OWNER ?? "0x1111111111111111111111111111111111111111") as `0x${string}`;
  const wantPlace = process.argv.includes("--place");

  const signer = new SignerClient(url);

  const deps: ValidateDeps = {
    isTestnet,
    owner,
    health: async () => (await fetch(`${url}/healthz`)).ok,
    digest: async (req) => {
      const res = await fetch(`${url}/v1/digest/l1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`digest ${res.status}`);
      return (await res.json()) as { actionHash: string };
    },
    localHash: (action, nonce) => createL1ActionHash({ action, nonce }),
    agentDigest,
    recover: (digest, sig) => recoverAddress({ hash: digest, signature: { r: sig.r as Hex, s: sig.s as Hex, v: BigInt(sig.v) } }),
    signer,
    place: wantPlace ? makePlace(signer, isTestnet) : undefined,
  };

  const report = await runValidation(deps);
  for (const c of report.checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  console.log(report.ok ? "\nVALIDATION PASSED" : "\nVALIDATION FAILED");
  process.exit(report.ok ? 0 : 1);
}

/** Optional fund-moving testnet place: sign a small IoC via the signer, submit to HL, reconcile. */
function makePlace(signer: SignerClient, isTestnet: boolean): () => Promise<{ ok: boolean; detail: string }> {
  return async () => {
    const keyId = requireEnv("VALIDATE_PLACE_KEYID");
    const asset = Number(process.env.VALIDATE_PLACE_ASSET ?? "0");
    const cloid = ("0x" + Date.now().toString(16).padStart(32, "0").slice(-32)) as string;
    const params = { asset, isBuy: true, px: "1", sz: "0.001", reduceOnly: false, tif: "Ioc", grouping: "na", cloid };
    const sig = await signer.sign({ keyId, kind: "order", params, cloid, isTestnet });
    const action = actionFromKindParams("order", params) as Record<string, unknown>;
    const transport = new HttpTransport({ isTestnet });
    const res = (await transport.request("exchange", { action, signature: { r: sig.r, s: sig.s, v: sig.v }, nonce: sig.nonce })) as {
      status?: string;
      response?: { data?: { statuses?: Array<{ error?: string }> } };
    };
    const err = res?.status && res.status !== "ok" ? res.status : res?.response?.data?.statuses?.find((s) => s.error)?.error;
    if (err) return { ok: false, detail: `HL rejected: ${err}` };
    await signer.reconcile(keyId, cloid, "submitted").catch(() => undefined);
    return { ok: true, detail: `submitted cloid ${cloid}` };
  };
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

> If `recoverAddress`'s `signature` type rejects `{ r, s, v }`, pass the concatenated hex instead: `signature: (sig.r + sig.s.slice(2) + sig.v.toString(16).padStart(2, "0")) as Hex`. Verified in this repo that the `{ r, s, v: bigint }` object form works with viem 2.53.

- [ ] **Step 2: Add the npm script (`package.json`)**

In `server/package.json` `scripts`, add:

```json
    "validate:delegation": "npm run build && node dist/scripts/validateDelegation.js"
```

- [ ] **Step 3: Typecheck + fail-fast smoke**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

Run (no SIGNER_URL → should exit non-zero with the missing-env message, proving the wiring loads):
`cd server && npx tsc --noEmit && node -e "require('ts-jest')" 2>/dev/null; SIGNER_URL= node --input-type=module -e "process.env.SIGNER_URL=''; import('./src/scripts/validateDelegation.ts').catch(()=>{})" 2>/dev/null || true`

> The real run is ops-side: `SIGNER_URL=https://<signer> npm run validate:delegation` (add `--place` with `VALIDATE_PLACE_KEYID` for the fund-moving step). A local dry-run without a signer will fail the health/parity checks (expected) — the point is the harness executes and reports.

- [ ] **Step 4: Full validation**

Run: `cd server && npm run typecheck && npm test`
Expected: tsc clean; all suites pass (the new core tests included; the CLI is typechecked).

- [ ] **Step 5: Commit**

```bash
git add server/src/scripts/validateDelegation.ts server/package.json
git commit -m "feat(cutover): validate:delegation CLI (live signer harness + optional --place)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Finish — reference the harness in the runbook, PR, review, merge

- [ ] **Step 1:** Add a one-line pointer in `docs/SIGNER-DELEGATION-ROLLOUT.md`'s Validation section: run `SIGNER_URL=… npm run validate:delegation` (and `--place` with an approved `VALIDATE_PLACE_KEYID`) as the automated pre-flip gate.
- [ ] **Step 2:** `cd server && npm run typecheck && npm test` (green).
- [ ] **Step 3:** `git commit` the doc line; `git push -u origin feat/validate-delegation-harness`.
- [ ] **Step 4:** Open the PR (`gh pr create`) — summarize: pre-flip validation harness (health + canonical-action parity incl. builder + provision/sign/ecrecover, optional `--place`), tested core + CLI, `npm run validate:delegation`.
- [ ] **Step 5:** Background `code-review` on the diff + `gh pr checks <n> --watch` in parallel.
- [ ] **Step 6:** Address high-confidence findings; on clean review + green CI, squash-merge `--delete-branch` and sync `main`.

---

## Self-review notes (coverage vs spec)

- **Health + parity (order ± cloid ± builder, cancelByCloid, scheduleCancel)** — Task 1 core + vectors. ✔
- **Provision → sign → ecrecover(agentDigest) == agentAddress, cleanup on failure** — Task 1. ✔
- **Optional `--place` fund-moving E2E behind a flag + keyId** — Task 2 `makePlace`. ✔
- **Tested core with injected deps; CLI is a thin env/IO shim** — Task 1 tests + Task 2 CLI. ✔
- **No production `SignerClient` change; zero new deps; runnable via `npm run validate:delegation`** — Task 2. ✔
- **Runbook pointer** — Task 3 Step 1. ✔
