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
  builder?: { b: `0x${string}`; f: number };
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
      const params = {
        asset: o.a, isBuy: o.b, px: o.p, sz: o.s, reduceOnly: o.r, tif: o.t.limit.tif, grouping, cloid,
        ...(arg.builder ? { builder: arg.builder } : {}),
      };
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
