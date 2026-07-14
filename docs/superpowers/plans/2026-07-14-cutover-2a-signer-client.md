# Cutover Phase 2a — Server SignerClient — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A typed `SignerClient` (TS) for the signer's `/v1/keys`, `/v1/sign/l1`, `/v1/reconcile`, with a timeout, injectable fetch, and a `SignerError{status,code,retryable}` status-code mapping.

**Architecture:** One file `server/src/agent/signerClient.ts` (+ test), mirroring the `FetchLike` + AbortController pattern from `signerShadow.ts`. Standalone — no wiring yet.

**Tech Stack:** TypeScript, jest (ts-jest), server module.

Spec: `docs/superpowers/specs/2026-07-14-cutover-2a-signer-client-design.md`
Branch: `feat/cutover-2a-signer-client`
Validation: `cd server && npm run typecheck && npm test`.

---

### Task 1: `SignerClient` (TDD)

**Files:**
- Create: `server/src/agent/signerClient.ts`
- Test: `server/src/agent/signerClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { SignerClient, SignerError } from "./signerClient";

type Init = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
function fakeFetch(handler: (url: string, init?: Init) => { ok: boolean; status: number; body?: unknown } | Promise<never>) {
  const calls: { url: string; init?: Init }[] = [];
  const f = async (url: string, init?: Init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Promise) return r; // lets a handler throw for the network case
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} };
  };
  return { f: f as never, calls };
}

describe("SignerClient", () => {
  it("createKey posts to /v1/keys and returns the address", async () => {
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 200, body: { keyId: "k1", agentAddress: "0xabc" } }));
    const c = new SignerClient("http://signer", f);
    await expect(c.createKey({ keyId: "k1", ownerAddress: "0xowner", allowedKinds: ["order"] })).resolves.toEqual({ keyId: "k1", agentAddress: "0xabc" });
    expect(calls[0].url).toBe("http://signer/v1/keys");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("maps 503 to a retryable notLeader error", async () => {
    const { f } = fakeFetch(() => ({ ok: false, status: 503, body: { error: "not leader" } }));
    const c = new SignerClient("http://signer", f);
    await expect(c.createKey({ keyId: "k1" })).rejects.toMatchObject({ code: "notLeader", retryable: true, status: 503 });
  });

  it("deleteKey issues a DELETE and resolves on 204", async () => {
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 204 }));
    const c = new SignerClient("http://signer", f);
    await expect(c.deleteKey("k1")).resolves.toBeUndefined();
    expect(calls[0].url).toBe("http://signer/v1/keys/k1");
    expect(calls[0].init?.method).toBe("DELETE");
  });

  it("sign returns the signature and maps error statuses", async () => {
    const okFetch = fakeFetch(() => ({ ok: true, status: 200, body: { r: "0x1", s: "0x2", v: 27, nonce: 5, duplicate: false } }));
    const c = new SignerClient("http://signer", okFetch.f);
    await expect(c.sign({ keyId: "k1", kind: "order", params: {}, cloid: "0x" + "1".repeat(32), isTestnet: true }))
      .resolves.toEqual({ r: "0x1", s: "0x2", v: 27, nonce: 5, duplicate: false });
    expect(okFetch.calls[0].url).toBe("http://signer/v1/sign/l1");

    const cases: Array<[number, string, string, boolean]> = [
      [403, "denied", "policy", false],
      [404, "unknown keyId", "notFound", false],
      [409, "cloid reuse mismatch", "cloidReuse", false],
      [409, "fenced", "fenced", true],
      [429, "rate limit exceeded", "rateLimit", true],
      [500, "sign failed", "server", true],
    ];
    for (const [status, msg, code, retryable] of cases) {
      const { f } = fakeFetch(() => ({ ok: false, status, body: { error: msg } }));
      const cc = new SignerClient("http://signer", f);
      await expect(cc.sign({ keyId: "k1", kind: "order", params: {}, cloid: "0x1", isTestnet: false }))
        .rejects.toMatchObject({ code, retryable, status });
    }
  });

  it("maps a thrown fetch (network/timeout) to a retryable network error", async () => {
    const f = (async () => { throw new Error("boom"); }) as never;
    const c = new SignerClient("http://signer", f);
    await expect(c.sign({ keyId: "k1", kind: "order", params: {}, cloid: "0x1", isTestnet: false }))
      .rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("reconcile posts to /v1/reconcile and resolves on 200", async () => {
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 200, body: { status: "submitted" } }));
    const c = new SignerClient("http://signer", f);
    await expect(c.reconcile("k1", "0xcloid", "submitted")).resolves.toBeUndefined();
    expect(calls[0].url).toBe("http://signer/v1/reconcile");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/agent/signerClient.test.ts`
Expected: FAIL (Cannot find module './signerClient').

- [ ] **Step 3: Implement**

```ts
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type SignerErrorCode =
  | "badRequest" | "policy" | "notFound" | "cloidReuse" | "fenced"
  | "rateLimit" | "notLeader" | "server" | "network";

export class SignerError extends Error {
  constructor(readonly status: number, readonly code: SignerErrorCode, message: string) {
    super(message);
    this.name = "SignerError";
  }
  /** Transient failures the caller may retry on a later tick. */
  get retryable(): boolean {
    return (
      this.code === "rateLimit" || this.code === "notLeader" ||
      this.code === "server" || this.code === "network" || this.code === "fenced"
    );
  }
}

export interface ProvisionKeyRequest {
  keyId: string;
  ownerAddress?: string;
  allowedKinds?: string[];
  maxNotionalUsdc?: number;
  perCoinMaxUsdc?: Record<string, number>;
  dailyMaxNotionalUsdc?: number;
  ratePerSec?: number;
  rateBurst?: number;
  ipRatePerSec?: number;
  ipRateBurst?: number;
  addressDailyMaxNotionalUsdc?: number;
}
export interface ProvisionKeyResult { keyId: string; agentAddress: string; }
export interface SignRequest { keyId: string; kind: string; params: unknown; cloid: string; isTestnet: boolean; }
export interface SignResult { r: string; s: string; v: number; nonce: number; duplicate: boolean; }
export type ReconcileStatus = "signed" | "submitted" | "open" | "filled" | "rejected" | "canceled";

function codeFor(status: number, message: string): SignerErrorCode {
  switch (status) {
    case 400: return "badRequest";
    case 403: return "policy";
    case 404: return "notFound";
    case 409: return message.includes("cloid") ? "cloidReuse" : "fenced";
    case 429: return "rateLimit";
    case 503: return "notLeader";
    default: return status >= 500 ? "server" : "badRequest";
  }
}

/** Typed client for the Go signer (holds no keys; the signer does). Sign-then-submit: the
 *  caller assembles + submits the HL /exchange payload from the returned signature. */
export class SignerClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private timeoutMs = 10_000,
  ) {}

  createKey(req: ProvisionKeyRequest): Promise<ProvisionKeyResult> {
    return this.request<ProvisionKeyResult>("/v1/keys", "POST", req);
  }
  async deleteKey(keyId: string): Promise<void> {
    await this.request<unknown>(`/v1/keys/${encodeURIComponent(keyId)}`, "DELETE");
  }
  sign(req: SignRequest): Promise<SignResult> {
    return this.request<SignResult>("/v1/sign/l1", "POST", req);
  }
  async reconcile(keyId: string, cloid: string, status: ReconcileStatus): Promise<void> {
    await this.request<unknown>("/v1/reconcile", "POST", { keyId, cloid, status });
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new SignerError(0, "network", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let message = `signer ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j && typeof j.error === "string") message = j.error;
      } catch {
        /* keep the status-based message */
      }
      throw new SignerError(res.status, codeFor(res.status, message), message);
    }
    return (await res.json()) as T;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx jest src/agent/signerClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck + suite**

Run: `cd server && npm run typecheck && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/signerClient.ts server/src/agent/signerClient.test.ts
git commit -m "feat(cutover-2a): server SignerClient (typed signer client + error mapping)"
```

---

### Task 2: Finish the branch

- [ ] **Step 1: Final validation** — `cd server && npm run typecheck && npm test` green.
- [ ] **Step 2: Push + PR** — `gh pr create --title "feat(cutover-2a): server SignerClient" --body-file <body>`. Body: typed client for `/v1/keys`, `/v1/sign/l1`, `/v1/reconcile`; timeout + injectable fetch; `SignerError{status,code,retryable}` mapping; standalone (no wiring). Next: 2b provisioning cutover.
- [ ] **Step 3: Code review + CI** — dispatch code-review (background) + `gh pr checks <n> --watch`.
- [ ] **Step 4: Merge** — clean review + green CI → `gh pr merge --squash --delete-branch`; sync main.

---

## Self-review

- **Spec coverage:** all four methods, timeout/AbortController, injectable fetch, `SignerError` + `codeFor` mapping, retryable classification, and every test case in the spec §Testing.
- **Placeholder scan:** none — full code + commands.
- **Type consistency:** `ProvisionKeyRequest/Result`, `SignRequest/SignResult`, `ReconcileStatus`, `SignerError`, `SignerErrorCode`, and `codeFor` used identically in impl + test; `FetchLike` matches `signerShadow`'s shape.
- **Semantics:** 409 split by `"cloid"` substring (cloidReuse vs fenced); network/timeout → `network`; `retryable` = rateLimit|notLeader|server|network|fenced.
