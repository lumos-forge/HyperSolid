import type { HttpTransport } from "@nktkas/hyperliquid";
import { AgentManager, MemoryAgentStore } from "./agentManager";
import { makeClientFor } from "./hlRuntime";
import type { SignerLike } from "./signerExchangeClient";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const FUTURE = 9_999_999_999_999;

function approvedStore(rec: { owner: string; agentAddress: string; privateKey?: `0x${string}`; keyId?: string }): MemoryAgentStore {
  const store = new MemoryAgentStore();
  store.set({ ...rec, approved: true, validUntil: FUTURE });
  return store;
}

describe("makeClientFor delegation routing", () => {
  const now = () => 0;

  it("routes a keyId record to a signer-backed client (order calls the signer)", async () => {
    const signCalls: unknown[] = [];
    const signer = {
      sign: async (req: unknown) => { signCalls.push(req); return { r: "0xr", s: "0xs", v: 27, nonce: 1, duplicate: false }; },
      reconcile: async () => undefined,
    } as unknown as SignerLike;
    const submitted: unknown[] = [];
    const transport = { request: async (_e: string, p: unknown) => { submitted.push(p); return {}; } } as unknown as HttpTransport;

    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo" }), () => PK);
    const clientFor = makeClientFor(agents, transport, now, { signer, isTestnet: true });

    const client = clientFor("0xo") as unknown as { order(a: unknown): Promise<unknown> };
    expect(client).toBeDefined();
    await client.order({ orders: [{ a: 0, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: "0xc" }], grouping: "na" });
    expect(signCalls).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it("returns a (local) client for a privateKey record and never touches the signer", () => {
    const signer = { sign: async () => { throw new Error("should not sign"); }, reconcile: async () => undefined } as unknown as SignerLike;
    const transport = {} as unknown as HttpTransport;
    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", privateKey: PK }), () => PK);
    const clientFor = makeClientFor(agents, transport, now, { signer, isTestnet: true });
    expect(clientFor("0xo")).toBeDefined();
  });

  it("returns undefined for an unapproved owner", () => {
    const signer = { sign: async () => ({}), reconcile: async () => undefined } as unknown as SignerLike;
    const store = new MemoryAgentStore();
    store.set({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo", approved: false });
    const agents = new AgentManager(store, () => PK);
    const clientFor = makeClientFor(agents, {} as unknown as HttpTransport, now, { signer, isTestnet: true });
    expect(clientFor("0xo")).toBeUndefined();
  });

  it("without delegation, a keyId-only record yields undefined (no local key to sign with)", () => {
    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo" }), () => PK);
    const clientFor = makeClientFor(agents, {} as unknown as HttpTransport, now);
    expect(clientFor("0xo")).toBeUndefined();
  });
});
