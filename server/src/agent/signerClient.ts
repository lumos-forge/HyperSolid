type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type SignerErrorCode =
  | "badRequest"
  | "policy"
  | "notFound"
  | "cloidReuse"
  | "invalidTransition"
  | "fenced"
  | "rateLimit"
  | "notLeader"
  | "server"
  | "network";

export class SignerError extends Error {
  constructor(readonly status: number, readonly code: SignerErrorCode, message: string) {
    super(message);
    this.name = "SignerError";
  }
  /** Transient failures the caller may retry on a later tick. */
  get retryable(): boolean {
    return (
      this.code === "rateLimit" ||
      this.code === "notLeader" ||
      this.code === "server" ||
      this.code === "network" ||
      this.code === "fenced"
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
export interface ProvisionKeyResult {
  keyId: string;
  agentAddress: string;
}
export interface SignRequest {
  keyId: string;
  kind: string;
  params: unknown;
  cloid: string;
  isTestnet: boolean;
}
export interface SignResult {
  r: string;
  s: string;
  v: number;
  nonce: number;
  duplicate: boolean;
}
export type ReconcileStatus = "signed" | "submitted" | "open" | "filled" | "rejected" | "canceled";

function codeFor(status: number, message: string): SignerErrorCode {
  switch (status) {
    case 400:
      return "badRequest";
    case 403:
      return "policy";
    case 404:
      return "notFound";
    case 409:
      // handleSignL1: "cloid reuse mismatch" (permanent) / "fenced" (leadership change, retryable).
      // handleReconcile: "invalid transition" (permanent). Split by message so retry semantics differ.
      if (message.includes("cloid")) return "cloidReuse";
      if (message.includes("transition")) return "invalidTransition";
      return "fenced";
    case 429:
      return "rateLimit";
    case 503:
      return "notLeader";
    default:
      return status >= 500 ? "server" : "badRequest";
  }
}

/**
 * Typed client for the Go signer (which holds the agent keys; the server does not). Sign-then-submit:
 * the caller assembles + submits the HL /exchange payload from the returned signature. Maps the
 * signer's status codes to a `SignerError` with a `retryable` signal for the placer.
 */
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
    await this.request<void>(`/v1/keys/${encodeURIComponent(keyId)}`, "DELETE", undefined, false);
  }

  sign(req: SignRequest): Promise<SignResult> {
    return this.request<SignResult>("/v1/sign/l1", "POST", req);
  }

  async reconcile(keyId: string, cloid: string, status: ReconcileStatus): Promise<void> {
    await this.request<void>("/v1/reconcile", "POST", { keyId, cloid, status }, false);
  }

  private async request<T>(path: string, method: string, body?: unknown, parseJson = true): Promise<T> {
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
    // Void endpoints (DELETE → 204 empty body; reconcile's body is ignored) must not parse JSON:
    // calling res.json() on an empty body throws. Only typed responses parse.
    if (!parseJson) return undefined as T;
    return (await res.json()) as T;
  }
}
