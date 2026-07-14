import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { SqliteAgentStore } from "./sqliteAgentStore";
import { deriveKey } from "./secretBox";
import type { AgentRecord } from "./agentManager";

const KEY = deriveKey("server-enc-secret");
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return { owner: "0xOwner", agentAddress: "0xagent", privateKey: PK, approved: true, validUntil: 12345, ...over };
}

describe("SqliteAgentStore", () => {
  it("round-trips a record (incl. the decrypted key) and matches owner case-insensitively", () => {
    const store = SqliteAgentStore.open(":memory:", KEY);
    store.set(rec());
    const got = store.get("0xowner");
    expect(got).toEqual(rec({ owner: "0xowner" }));
  });

  it("stores the private key encrypted at rest (raw key not present in the column)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-agent-"));
    const file = join(dir, "agents.db");
    try {
      const store = SqliteAgentStore.open(file, KEY);
      store.set(rec());
      const raw = new Database(file).prepare("SELECT enc_private_key FROM agents").get() as { enc_private_key: string };
      expect(raw.enc_private_key).not.toContain(PK);
      expect(raw.enc_private_key.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists across a reopen and can decrypt with the same key (durable recovery)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-agent-"));
    const file = join(dir, "agents.db");
    try {
      SqliteAgentStore.open(file, KEY).set(rec());
      const reopened = SqliteAgentStore.open(file, KEY);
      expect(reopened.get("0xowner")!.privateKey).toBe(PK);
      expect(reopened.get("0xowner")!.validUntil).toBe(12345);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remove deletes the record (and forgets the key)", () => {
    const store = SqliteAgentStore.open(":memory:", KEY);
    store.set(rec());
    store.remove("0xOwner");
    expect(store.get("0xowner")).toBeUndefined();
  });

  it("set upserts (re-provision overwrites the prior agent for an owner)", () => {
    const store = SqliteAgentStore.open(":memory:", KEY);
    store.set(rec({ agentAddress: "0xold", approved: false }));
    store.set(rec({ agentAddress: "0xnew", approved: true }));
    expect(store.get("0xowner")!.agentAddress).toBe("0xnew");
    expect(store.get("0xowner")!.approved).toBe(true);
  });

  it("round-trips a signer-custody record (keyId, no private key stored)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-agent-"));
    const file = join(dir, "agents.db");
    try {
      const store = SqliteAgentStore.open(file, KEY);
      store.set({ owner: "0xOwner", agentAddress: "0xagent", keyId: "agent:0xowner", approved: true, validUntil: 12345 });
      const got = store.get("0xowner")!;
      expect(got.keyId).toBe("agent:0xowner");
      expect(got.privateKey).toBeUndefined();
      // enc_private_key is an empty sentinel, never a ciphertext, for delegated records.
      const raw = new Database(file).prepare("SELECT enc_private_key FROM agents").get() as { enc_private_key: string };
      expect(raw.enc_private_key).toBe("");
      // survives reopen
      expect(SqliteAgentStore.open(file, KEY).get("0xowner")!.keyId).toBe("agent:0xowner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
