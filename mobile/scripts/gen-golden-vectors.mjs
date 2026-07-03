// Regenerate the cross-language golden vectors for the Go signing core.
// Run from the mobile/ directory:  node scripts/gen-golden-vectors.mjs
// Oracle: @nktkas/hyperliquid/signing (same scheme the app signs with) + viem.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createL1ActionHash, signL1Action } from "@nktkas/hyperliquid/signing";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PK = "0x1111111111111111111111111111111111111111111111111111111111111111";
const account = privateKeyToAccount(PK);
const NONCE = 1700000000000;
const ZERO = "0x0000000000000000000000000000000000000000";

// Build the exact action object HL signs, from semantic params (field order is byte-critical).
function buildAction(kind, p) {
  if (kind === "order") {
    const o = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    return { type: "order", orders: [o], grouping: p.grouping ?? "na" };
  }
  if (kind === "cancel") return { type: "cancel", cancels: p.cancels.map((c) => ({ a: c.asset, o: c.oid })) };
  if (kind === "twapOrder") return { type: "twapOrder", twap: { a: p.asset, b: p.isBuy, s: p.sz, r: p.reduceOnly, m: p.minutes, t: p.randomize } };
  if (kind === "twapCancel") return { type: "twapCancel", a: p.asset, t: p.twapId };
  throw new Error("unknown kind " + kind);
}

const cases = [
  { name: "order-limit-gtc-mainnet", kind: "order", isTestnet: false, params: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na" } },
  { name: "order-limit-ioc-testnet", kind: "order", isTestnet: true, params: { asset: 1, isBuy: false, px: "3000", sz: "0.5", reduceOnly: true, tif: "Ioc", grouping: "na" } },
  { name: "order-limit-cloid-mainnet", kind: "order", isTestnet: false, params: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na", cloid: "0x00000000000000000000000000000001" } },
  { name: "cancel-mainnet", kind: "cancel", isTestnet: false, params: { cancels: [{ asset: 0, oid: 123 }] } },
  { name: "twapOrder-mainnet", kind: "twapOrder", isTestnet: false, params: { asset: 0, isBuy: true, sz: "0.02", reduceOnly: false, minutes: 30, randomize: true } },
  { name: "twapCancel-testnet", kind: "twapCancel", isTestnet: true, params: { asset: 0, twapId: 7 } },
];

function normSig(sig) {
  if (typeof sig === "string") {
    const h = sig.slice(2);
    return { r: "0x" + h.slice(0, 64), s: "0x" + h.slice(64, 128), v: parseInt(h.slice(128, 130), 16) };
  }
  return { r: sig.r, s: sig.s, v: Number(sig.v) };
}

const out = [];
for (const c of cases) {
  const action = buildAction(c.kind, c.params);
  const actionHash = createL1ActionHash({ action, nonce: NONCE });
  const agentDigest = hashTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: c.isTestnet ? "b" : "a", connectionId: actionHash },
  });
  const sig = normSig(await signL1Action({ wallet: account, action, nonce: NONCE, isTestnet: c.isTestnet }));
  out.push({ name: c.name, kind: c.kind, params: c.params, nonce: NONCE, isTestnet: c.isTestnet, privKey: PK, actionHash, agentDigest, sig });
}

const dest = resolve(dirname(fileURLToPath(import.meta.url)), "../../backend/internal/hl/testdata/golden.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.length} vectors to ${dest}`);
