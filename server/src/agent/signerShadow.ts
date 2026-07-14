import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { actionFromKindParams } from "./l1Action";

/** Fixed nonce for shadow comparison — the hash is nonce-dependent but nonce-arbitrary for encoding checks. */
export const SHADOW_NONCE = 1;

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ShadowLogger {
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface ShadowOpts {
  url: string;
  isTestnet?: boolean;
  nonce?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  logger?: ShadowLogger;
}

/**
 * Build a fire-and-forget shadow verifier: for each supported action it compares the local
 * @nktkas L1 actionHash (fixed nonce) against the Go signer's, logging a warning on mismatch.
 * Every error (unsupported kind, network, non-200, bad body) is swallowed — it never throws
 * into the caller and never affects order placement.
 */
export function makeShadowVerifier(opts: ShadowOpts): (kind: string, params: unknown) => void {
  const nonce = opts.nonce ?? SHADOW_NONCE;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const f: FetchLike = opts.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const log: ShadowLogger = opts.logger ?? {
    warn: (o, m) => console.warn(m ?? "signer shadow", o),
    debug: () => undefined,
  };
  return (kind: string, params: unknown): void => {
    void (async () => {
      try {
        const action = actionFromKindParams(kind, params);
        if (!action) return;
        const localHash = createL1ActionHash({ action, nonce });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await f(`${opts.url}/v1/digest/l1`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, params, nonce, isTestnet: opts.isTestnet ?? false }),
            signal: controller.signal,
          });
          if (!res.ok) {
            log.warn({ kind, status: res.status }, "signer shadow http error");
            return;
          }
          const body = (await res.json()) as { actionHash?: string };
          const remoteHash = body.actionHash;
          if (!remoteHash) {
            log.warn({ kind }, "signer shadow missing actionHash");
            return;
          }
          if (remoteHash.toLowerCase() !== localHash.toLowerCase()) {
            log.warn({ kind, localHash, remoteHash }, "signer shadow mismatch");
          } else {
            log.debug({ kind }, "signer shadow match");
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        log.warn({ kind, err: String(e) }, "signer shadow error");
      }
    })();
  };
}
