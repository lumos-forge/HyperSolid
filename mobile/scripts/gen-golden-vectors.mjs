// Regenerate the cross-language golden vectors for the Go signing core.
// Run from the mobile/ directory:  node scripts/gen-golden-vectors.mjs
// Oracle: @nktkas/hyperliquid/signing (same scheme the app signs with) + viem.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createL1ActionHash, signL1Action, signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { ApproveAgentTypes, Withdraw3Types, UsdSendTypes, ApproveBuilderFeeTypes } from "@nktkas/hyperliquid/api/exchange";
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
  if (kind === "cancelByCloid") return { type: "cancelByCloid", cancels: p.cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })) };
  if (kind === "modify") {
    const o = { a: p.order.asset, b: p.order.isBuy, p: p.order.px, s: p.order.sz, r: p.order.reduceOnly, t: { limit: { tif: p.order.tif } } };
    if (p.order.cloid) o.c = p.order.cloid;
    const oid = p.oidCloid ?? p.oidNum;
    return { type: "modify", oid, order: o };
  }
  if (kind === "updateLeverage") return { type: "updateLeverage", asset: p.asset, isCross: p.isCross, leverage: p.leverage };
  if (kind === "batchModify") {
    return { type: "batchModify", modifies: p.modifies.map((m) => {
      const o = { a: m.order.asset, b: m.order.isBuy, p: m.order.px, s: m.order.sz, r: m.order.reduceOnly, t: { limit: { tif: m.order.tif } } };
      if (m.order.cloid) o.c = m.order.cloid;
      return { oid: m.oidCloid ?? m.oidNum, order: o };
    }) };
  }
  if (kind === "updateIsolatedMargin") return { type: "updateIsolatedMargin", asset: p.asset, isBuy: p.isBuy, ntli: p.ntli };
  if (kind === "scheduleCancel") {
    const a = { type: "scheduleCancel" };
    if (p.time !== undefined) a.time = p.time;
    return a;
  }
  throw new Error("unknown kind " + kind);
}

const cases = [
  { name: "order-limit-gtc-mainnet", kind: "order", isTestnet: false, params: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na" } },
  { name: "order-limit-ioc-testnet", kind: "order", isTestnet: true, params: { asset: 1, isBuy: false, px: "3000", sz: "0.5", reduceOnly: true, tif: "Ioc", grouping: "na" } },
  { name: "order-limit-cloid-mainnet", kind: "order", isTestnet: false, params: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na", cloid: "0x00000000000000000000000000000001" } },
  { name: "cancel-mainnet", kind: "cancel", isTestnet: false, params: { cancels: [{ asset: 0, oid: 123 }] } },
  { name: "twapOrder-mainnet", kind: "twapOrder", isTestnet: false, params: { asset: 0, isBuy: true, sz: "0.02", reduceOnly: false, minutes: 30, randomize: true } },
  { name: "twapCancel-testnet", kind: "twapCancel", isTestnet: true, params: { asset: 0, twapId: 7 } },
  { name: "cancelByCloid-mainnet", kind: "cancelByCloid", isTestnet: false, params: { cancels: [{ asset: 2, cloid: "0x00000000000000000000000000000001" }, { asset: 5, cloid: "0x00000000000000000000000000000003" }] } },
  { name: "modify-oid-mainnet", kind: "modify", isTestnet: false, params: { oidNum: 123, order: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc" } } },
  { name: "modify-cloid-testnet", kind: "modify", isTestnet: true, params: { oidCloid: "0x00000000000000000000000000000002", order: { asset: 1, isBuy: false, px: "3000", sz: "0.5", reduceOnly: true, tif: "Ioc" } } },
  { name: "modify-oid-large-order-cloid-mainnet", kind: "modify", isTestnet: false, params: { oidNum: 4294967297, order: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Alo", cloid: "0x00000000000000000000000000000009" } } },
  { name: "updateLeverage-cross-mainnet", kind: "updateLeverage", isTestnet: false, params: { asset: 0, isCross: true, leverage: 5 } },
  { name: "updateLeverage-isolated-testnet", kind: "updateLeverage", isTestnet: true, params: { asset: 1, isCross: false, leverage: 3 } },
  { name: "batchModify-mainnet", kind: "batchModify", isTestnet: false, params: { modifies: [
    { oidNum: 123, order: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc" } },
    { oidCloid: "0x00000000000000000000000000000002", order: { asset: 1, isBuy: false, px: "3000", sz: "0.5", reduceOnly: true, tif: "Alo", cloid: "0x00000000000000000000000000000009" } },
  ] } },
  { name: "updateIsolatedMargin-add-mainnet", kind: "updateIsolatedMargin", isTestnet: false, params: { asset: 0, isBuy: true, ntli: 1000000 } },
  { name: "updateIsolatedMargin-remove-testnet", kind: "updateIsolatedMargin", isTestnet: true, params: { asset: 1, isBuy: false, ntli: -500000 } },
  { name: "scheduleCancel-set-mainnet", kind: "scheduleCancel", isTestnet: false, params: { time: 1700000000000 } },
  { name: "scheduleCancel-clear-testnet", kind: "scheduleCancel", isTestnet: true, params: {} },
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

// --- User-signed (approveAgent) vectors: HyperliquidSignTransaction domain ---
const userCases = [
  { name: "approve-mainnet-named", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", agentAddress: "0x000000000000000000000000000000000000dEaD", agentName: "myAgent", nonce: NONCE },
  { name: "approve-testnet-empty", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", agentAddress: "0x00000000000000000000000000000000cafe0001", agentName: "", nonce: NONCE },
  { name: "approve-mainnet-named-2", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", agentAddress: "0x1111111111111111111111111111111111111111", agentName: "second", nonce: NONCE + 1 },
];

const userOut = [];
for (const c of userCases) {
  const chainId = parseInt(c.signatureChainId);
  const digest = hashTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId, verifyingContract: ZERO },
    types: ApproveAgentTypes,
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: { hyperliquidChain: c.hyperliquidChain, agentAddress: c.agentAddress, agentName: c.agentName, nonce: BigInt(c.nonce) },
  });
  const action = { type: "approveAgent", signatureChainId: c.signatureChainId, hyperliquidChain: c.hyperliquidChain, agentAddress: c.agentAddress, agentName: c.agentName, nonce: c.nonce };
  const sig = normSig(await signUserSignedAction({ wallet: account, action, types: ApproveAgentTypes }));
  userOut.push({ name: c.name, signatureChainId: c.signatureChainId, hyperliquidChain: c.hyperliquidChain, agentAddress: c.agentAddress, agentName: c.agentName, nonce: c.nonce, privKey: PK, digest, sig });
}
const userDest = resolve(dirname(fileURLToPath(import.meta.url)), "../../backend/internal/hl/testdata/golden_usersigned.json");
writeFileSync(userDest, JSON.stringify(userOut, null, 2) + "\n");
console.log(`wrote ${userOut.length} user-signed vectors to ${userDest}`);

// --- More user-signed actions: withdraw3 / usdSend / approveBuilderFee ---
const moreCases = [
  { name: "withdraw3-mainnet", action: "withdraw3", types: Withdraw3Types, primaryType: "HyperliquidTransaction:Withdraw", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", fields: { destination: "0x000000000000000000000000000000000000dEaD", amount: "100.5", time: NONCE } },
  { name: "usdSend-testnet", action: "usdSend", types: UsdSendTypes, primaryType: "HyperliquidTransaction:UsdSend", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", fields: { destination: "0x00000000000000000000000000000000cafe0001", amount: "25", time: NONCE } },
  { name: "approveBuilderFee-mainnet", action: "approveBuilderFee", types: ApproveBuilderFeeTypes, primaryType: "HyperliquidTransaction:ApproveBuilderFee", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", fields: { maxFeeRate: "0.001%", builder: "0x1111111111111111111111111111111111111111", nonce: NONCE } },
];

const moreOut = [];
for (const c of moreCases) {
  const chainId = parseInt(c.signatureChainId);
  const message = { hyperliquidChain: c.hyperliquidChain };
  for (const [k, v] of Object.entries(c.fields)) {
    message[k] = (k === "time" || k === "nonce") ? BigInt(v) : v;
  }
  const digest = hashTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId, verifyingContract: ZERO },
    types: c.types,
    primaryType: c.primaryType,
    message,
  });
  const action = { type: c.action, signatureChainId: c.signatureChainId, hyperliquidChain: c.hyperliquidChain, ...c.fields };
  const sig = normSig(await signUserSignedAction({ wallet: account, action, types: c.types }));
  moreOut.push({ name: c.name, action: c.action, signatureChainId: c.signatureChainId, hyperliquidChain: c.hyperliquidChain, ...c.fields, privKey: PK, digest, sig });
}
const moreDest = resolve(dirname(fileURLToPath(import.meta.url)), "../../backend/internal/hl/testdata/golden_usersigned_more.json");
writeFileSync(moreDest, JSON.stringify(moreOut, null, 2) + "\n");
console.log(`wrote ${moreOut.length} more user-signed vectors to ${moreDest}`);
