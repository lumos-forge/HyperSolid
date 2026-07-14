# Cutover Phase 2a — Server SignerClient (TS)

Date: 2026-07-14
Status: Approved (per the cutover baseline)

## Context

Phases 1a/1b made the Go signer able to hold agent keys and expose provisioning + signing
over HTTP (`/v1/keys`, `/v1/sign/l1`, `/v1/reconcile`). This phase adds the **server-side
typed client** the later phases use to call the signer, with status-code → typed-error
mapping and a `retryable` signal so the placer can decide retry-vs-skip. No server behavior
changes yet — this is a standalone client + tests.

## Goal

A `SignerClient` (`server/src/agent/signerClient.ts`) with `createKey`/`deleteKey`/`sign`/
`reconcile`, a timeout (AbortController, mirroring `signerShadow`), an injectable `fetch` for
tests, and a `SignerError { status, code, retryable }` mapping the signer's status codes.

## Signer contract (from Phases 1a/1b)

- `POST /v1/keys` → `{ keyId, agentAddress }`; 400 (bad/empty keyId), 405, 500 (provision), 503 (not leader).
- `DELETE /v1/keys/{keyId}` → 204; 400, 500, 503.
- `POST /v1/sign/l1` `{keyId,kind,params,cloid,isTestnet}` → `{ r, s, v, nonce, duplicate }`;
  400, 403 (policy/cap), 404 (unknown key), 409 (fenced / cloid reuse mismatch), 429 (rate),
  503 (not leader), 500.
- `POST /v1/reconcile` `{keyId,cloid,status}` → `{ status }`; 400, 404, 409.
- Every error body is `{ "error": "<message>" }`.

## Design — `server/src/agent/signerClient.ts`

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

export class SignerClient {
  constructor(private baseUrl: string, private fetchImpl: FetchLike = fetch as unknown as FetchLike, private timeoutMs = 10_000) {}
  createKey(req: ProvisionKeyRequest): Promise<ProvisionKeyResult>;
  deleteKey(keyId: string): Promise<void>;
  sign(req: SignRequest): Promise<SignResult>;
  reconcile(keyId: string, cloid: string, status: ReconcileStatus): Promise<void>;
}
```

**Request mechanics (`private request`):**
- Build an `AbortController` with a `setTimeout(abort, timeoutMs)`; always `clearTimeout` in a
  `finally`.
- `POST` JSON with `Content-Type: application/json`; `DELETE` has no body.
- On a thrown fetch error (network/timeout/abort) → `SignerError(0, "network", <msg>)`.
- On `!res.ok` → read `{ error }` (best-effort; fall back to the status text) and map the
  status to a code via `codeFor(status, message)`; throw `SignerError(status, code, message)`.
- On ok: `deleteKey`/`reconcile` return void (ignore the body); `createKey`/`sign` parse the
  typed JSON body.

**Status → code (`codeFor`):**
```
400 → badRequest
403 → policy
404 → notFound
409 → message.includes("cloid") ? "cloidReuse" : "fenced"
429 → rateLimit
503 → notLeader
>= 500 → server
otherwise → badRequest
```

## Error handling / retry semantics

- `retryable` is true for `rateLimit | notLeader | server | network | fenced` (transient — the
  placer retries next tick) and false for `policy | notFound | badRequest | cloidReuse` (the
  placer skips + surfaces via existing alerts).
- `409 fenced` (leadership changed) is retryable; `409 cloidReuse` (a real cloid mismatch) is
  not — split by the error message substring `"cloid"`.
- The timeout is enforced client-side; a slow/hung signer yields a `network` error, not a hang.

## Testing — `server/src/agent/signerClient.test.ts`

With an injected `FetchLike` returning canned `{ ok, status, json }`:
- `createKey` posts to `/v1/keys` and returns `{keyId, agentAddress}`; a 503 → `SignerError`
  code `notLeader`, `retryable === true`.
- `deleteKey` issues a DELETE to `/v1/keys/{keyId}` and resolves on 204.
- `sign` posts to `/v1/sign/l1` and returns `{r,s,v,nonce,duplicate}`; maps 403→policy
  (`retryable false`), 404→notFound, 409 "cloid reuse mismatch"→cloidReuse (`retryable false`),
  409 "fenced"→fenced (`retryable true`), 429→rateLimit, 500→server.
- A thrown fetch (network/timeout) → `SignerError` code `network`, `retryable true`, and the
  abort timer is cleared (no dangling timer).
- `reconcile` posts to `/v1/reconcile` and resolves on 200.
- Validation: `cd server && npm run typecheck && npm test`.

## Out of scope (later phases)

- 2b: `/agent/provision` cutover to `SignerClient.createKey`; server stops storing private keys.
- 3a+: signer-backed placer (sign → assemble `/exchange` → submit → reconcile), dead-man
  delegation, cleanup.
- Signer base-URL config wiring (Phase 2b consumes the client with a configured base URL).
