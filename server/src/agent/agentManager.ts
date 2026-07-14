import { privateKeyToAccount } from "viem/accounts";
import type { SignerClient, ProvisionKeyRequest } from "./signerClient";

/** A provisioned agent: either a locally-held trade-only keypair (`privateKey`) OR a signer-held
 *  key referenced by `keyId` (custody in the Go signer). Exactly one custody form is set. */
export interface AgentRecord {
  owner: string;
  agentAddress: string;
  privateKey?: `0x${string}`;
  keyId?: string;
  approved: boolean;
  validUntil?: number;
}

/** Persistence boundary for agent records. Swap MemoryAgentStore for an encrypted/SQLite impl. */
export interface AgentStore {
  get(owner: string): AgentRecord | undefined;
  set(rec: AgentRecord): void;
  remove(owner: string): void;
}

/** In-memory agent store for tests/dev. Production must encrypt the private key at rest. */
export class MemoryAgentStore implements AgentStore {
  private byOwner = new Map<string, AgentRecord>();
  get(owner: string): AgentRecord | undefined {
    return this.byOwner.get(owner.toLowerCase());
  }
  set(rec: AgentRecord): void {
    this.byOwner.set(rec.owner.toLowerCase(), rec);
  }
  remove(owner: string): void {
    this.byOwner.delete(owner.toLowerCase());
  }
}

export interface AgentStatus {
  approved: boolean;
  agentAddress?: string;
  validUntil?: number;
}

/** Caps bound to the signer's reject-first policy at provision time (mirrors the engine guardrails). */
export type ProvisionCaps = Pick<
  ProvisionKeyRequest,
  "allowedKinds" | "maxNotionalUsdc" | "perCoinMaxUsdc" | "dailyMaxNotionalUsdc"
>;

/** When present, provisioning delegates key custody to the Go signer instead of generating locally. */
export interface DelegationDeps {
  signer: SignerClient;
  caps: ProvisionCaps;
}

/** The signer keyId for an owner's agent (stable per owner). */
function deriveKeyId(owner: string): string {
  return "agent:" + owner.toLowerCase();
}

/**
 * Custodies each owner's trade-only HL agent keypair. The app only ever learns the agent ADDRESS and
 * signs `approveAgent` on-device with its main key; the private key the server generates can trade but
 * (by HL's guarantee) never withdraw, and is never returned or logged. `genKey` is injectable so tests
 * are deterministic. Approval carries a `validUntil` (~now+90d); an expired agent is reported
 * not-approved so the scheduler refuses it and the app re-approves.
 */
export class AgentManager {
  constructor(
    private store: AgentStore,
    private genKey: () => `0x${string}`,
    private delegation?: DelegationDeps,
  ) {}

  async provision(owner: string): Promise<{ agentAddress: string }> {
    const existing = this.store.get(owner);
    if (existing && !existing.approved) return { agentAddress: existing.agentAddress };
    if (this.delegation) {
      const keyId = deriveKeyId(owner);
      const { agentAddress } = await this.delegation.signer.createKey({
        keyId,
        ownerAddress: owner,
        ...this.delegation.caps,
      });
      this.store.set({ owner, agentAddress, keyId, approved: false });
      return { agentAddress };
    }
    const privateKey = this.genKey();
    const agentAddress = privateKeyToAccount(privateKey).address;
    this.store.set({ owner, agentAddress, privateKey, approved: false });
    return { agentAddress };
  }

  confirm(owner: string, agentAddress: string, validUntil: number): void {
    const rec = this.store.get(owner);
    if (!rec) throw new Error("no agent provisioned for owner");
    if (rec.agentAddress.toLowerCase() !== agentAddress.toLowerCase()) {
      throw new Error("agent address mismatch");
    }
    this.store.set({ ...rec, approved: true, validUntil });
  }

  status(owner: string, now: number): AgentStatus {
    const rec = this.store.get(owner);
    if (!rec) return { approved: false };
    const expired = rec.validUntil !== undefined && rec.validUntil <= now;
    return { approved: rec.approved && !expired, agentAddress: rec.agentAddress, validUntil: rec.validUntil };
  }

  revoke(owner: string): void {
    this.store.remove(owner);
  }

  /** The agent private key for signing orders — server-internal only, never exposed over HTTP. */
  privateKeyFor(owner: string): `0x${string}` | undefined {
    return this.store.get(owner)?.privateKey;
  }

  /** The signer keyId when custody is delegated to the Go signer; undefined for local-key records. */
  keyIdFor(owner: string): string | undefined {
    return this.store.get(owner)?.keyId;
  }
}
