import { privateKeyToAccount } from "viem/accounts";
import { AgentManager, MemoryAgentStore } from "./agentManager";
import type { SignerClient } from "./signerClient";

const PK_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PK_B = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

describe("AgentManager", () => {
  it("provisions a fresh agent keypair and returns its address (never the key)", async () => {
    const mgr = new AgentManager(new MemoryAgentStore(), () => PK_A);
    const { agentAddress } = await mgr.provision("0xowner");
    expect(agentAddress).toBe(privateKeyToAccount(PK_A).address);
    expect(mgr.status("0xowner", 0).approved).toBe(false);
  });

  it("reuses the pending agent on re-provision (idempotent before approval)", async () => {
    let calls = 0;
    const keys = [PK_A, PK_B];
    const mgr = new AgentManager(new MemoryAgentStore(), () => keys[calls++]);
    const first = (await mgr.provision("0xowner")).agentAddress;
    const second = (await mgr.provision("0xowner")).agentAddress;
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("confirm marks approved with a validUntil; status reports it approved before expiry", async () => {
    const mgr = new AgentManager(new MemoryAgentStore(), () => PK_A);
    const addr = (await mgr.provision("0xowner")).agentAddress;
    mgr.confirm("0xowner", addr, 10_000);
    const st = mgr.status("0xowner", 5_000);
    expect(st).toEqual({ approved: true, agentAddress: addr, validUntil: 10_000 });
  });

  it("status reports NOT approved once the agent has expired", async () => {
    const mgr = new AgentManager(new MemoryAgentStore(), () => PK_A);
    const addr = (await mgr.provision("0xowner")).agentAddress;
    mgr.confirm("0xowner", addr, 10_000);
    expect(mgr.status("0xowner", 10_000).approved).toBe(false);
    expect(mgr.status("0xowner", 99_999).approved).toBe(false);
  });

  it("confirm rejects an address that does not match the provisioned agent", async () => {
    const mgr = new AgentManager(new MemoryAgentStore(), () => PK_A);
    await mgr.provision("0xowner");
    expect(() => mgr.confirm("0xowner", "0xdeadbeef", 1)).toThrow(/mismatch/i);
  });

  it("revoke clears the agent and forgets the key", async () => {
    const mgr = new AgentManager(new MemoryAgentStore(), () => PK_A);
    const addr = (await mgr.provision("0xowner")).agentAddress;
    mgr.confirm("0xowner", addr, 10_000);
    mgr.revoke("0xowner");
    expect(mgr.status("0xowner", 0)).toEqual({ approved: false });
    expect(mgr.privateKeyFor("0xowner")).toBeUndefined();
  });

  it("delegates provisioning to the signer when configured (stores keyId, no privateKey)", async () => {
    const createKey = jest.fn(async () => ({ keyId: "agent:0xowner", agentAddress: "0xAGENT" }));
    const signer = { createKey } as unknown as SignerClient;
    const store = new MemoryAgentStore();
    const mgr = new AgentManager(store, () => PK_A, {
      signer,
      caps: { allowedKinds: ["order", "scheduleCancel"], maxNotionalUsdc: 1000 },
    });
    const { agentAddress } = await mgr.provision("0xowner");
    expect(agentAddress).toBe("0xAGENT");
    expect(createKey).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: "agent:0xowner", ownerAddress: "0xowner", allowedKinds: ["order", "scheduleCancel"], maxNotionalUsdc: 1000 }),
    );
    const rec = store.get("0xowner")!;
    expect(rec.keyId).toBe("agent:0xowner");
    expect(rec.privateKey).toBeUndefined();
    expect(mgr.keyIdFor("0xowner")).toBe("agent:0xowner");
    expect(mgr.privateKeyFor("0xowner")).toBeUndefined();
  });
});
