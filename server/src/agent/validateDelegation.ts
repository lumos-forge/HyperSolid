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
