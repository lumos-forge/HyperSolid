import { HttpTransport } from "@nktkas/hyperliquid";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { hashTypedData, recoverAddress, type Hex } from "viem";
import { SignerClient } from "../agent/signerClient";
import { actionFromKindParams } from "../agent/l1Action";
import { runValidation, type ValidateDeps } from "../agent/validateDelegation";

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

/** Optional fund-moving testnet place: sign a small IoC via the signer, submit to HL, reconcile. */
function makePlace(signer: SignerClient, isTestnet: boolean): () => Promise<{ ok: boolean; detail: string }> {
  return async () => {
    const keyId = requireEnv("VALIDATE_PLACE_KEYID");
    const asset = Number(process.env.VALIDATE_PLACE_ASSET ?? "0");
    const cloid = "0x" + Date.now().toString(16).padStart(32, "0").slice(-32);
    const params = { asset, isBuy: true, px: "1", sz: "0.001", reduceOnly: false, tif: "Ioc", grouping: "na", cloid };
    const sig = await signer.sign({ keyId, kind: "order", params, cloid, isTestnet });
    const action = actionFromKindParams("order", params) as Record<string, unknown>;
    const transport = new HttpTransport({ isTestnet });
    const res = (await transport.request("exchange", {
      action,
      signature: { r: sig.r, s: sig.s, v: sig.v },
      nonce: sig.nonce,
    })) as { status?: string; response?: { data?: { statuses?: Array<{ error?: string }> } } };
    const err = res?.status && res.status !== "ok" ? res.status : res?.response?.data?.statuses?.find((s) => s.error)?.error;
    if (err) return { ok: false, detail: `HL rejected: ${err}` };
    await signer.reconcile(keyId, cloid, "submitted").catch(() => undefined);
    return { ok: true, detail: `submitted cloid ${cloid}` };
  };
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
    console.log(`${c.ok ? "\u2713" : "\u2717"} ${c.name} \u2014 ${c.detail}`);
  }
  console.log(report.ok ? "\nVALIDATION PASSED" : "\nVALIDATION FAILED");
  process.exit(report.ok ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
