import { runValidation, buildValidationVectors, VALIDATE_NONCE, type ValidateDeps } from "./validateDelegation";
import { actionFromKindParams } from "./l1Action";

const AGENT = ("0x" + "a".repeat(40)) as `0x${string}`;
const OWNER = ("0x" + "1".repeat(40)) as `0x${string}`;

// A stand-in hash keyed off the canonical action shape so a "faithful digest" == localHash by construction.
function fakeHash(kind: string, params: unknown, nonce: number): string {
  const action = actionFromKindParams(kind, params);
  return `${JSON.stringify(action)}:${nonce}`;
}

function baseDeps(over: Partial<ValidateDeps> = {}): { deps: ValidateDeps; deleted: string[] } {
  const deleted: string[] = [];
  const deps: ValidateDeps = {
    isTestnet: true,
    owner: OWNER,
    health: async () => true,
    digest: async ({ kind, params, nonce }) => ({ actionHash: fakeHash(kind, params, nonce) }),
    localHash: (action, nonce) => `${JSON.stringify(action)}:${nonce}`,
    agentDigest: () => ("0x" + "d".repeat(64)) as `0x${string}`,
    recover: async () => AGENT,
    signer: {
      createKey: async () => ({ keyId: "k", agentAddress: AGENT }),
      sign: async () => ({ r: "0xr", s: "0xs", v: 27, nonce: 1, duplicate: false }),
      deleteKey: async (id: string) => { deleted.push(id); },
    } as unknown as ValidateDeps["signer"],
    ...over,
  };
  return { deps, deleted };
}

describe("runValidation", () => {
  it("passes when health ok, parity matches, and the signature recovers to the agent", async () => {
    const { deps, deleted } = baseDeps();
    const report = await runValidation(deps);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "health")?.ok).toBe(true);
    expect(report.checks.filter((c) => c.name.startsWith("parity:")).every((c) => c.ok)).toBe(true);
    expect(report.checks.find((c) => c.name === "provision-sign-recover")?.ok).toBe(true);
    expect(deleted).toHaveLength(1); // cleanup happened
    expect(deleted[0]).toMatch(/^validate:/);
  });

  it("fails a parity check when the signer's actionHash differs", async () => {
    const { deps } = baseDeps({ digest: async () => ({ actionHash: "different" }) });
    const report = await runValidation(deps);
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => c.name.startsWith("parity:")).some((c) => !c.ok)).toBe(true);
  });

  it("fails provision-sign-recover when the signature recovers to a different address", async () => {
    const { deps } = baseDeps({ recover: async () => ("0x" + "b".repeat(40)) as `0x${string}` });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "provision-sign-recover")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("reports a health failure", async () => {
    const { deps } = baseDeps({ health: async () => false });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "health")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("still cleans up the key when signing throws", async () => {
    const { deps, deleted } = baseDeps({
      signer: {
        createKey: async () => ({ keyId: "k", agentAddress: AGENT }),
        sign: async () => { throw new Error("sign boom"); },
        deleteKey: async (id: string) => { deleted.push(id); },
      } as unknown as ValidateDeps["signer"],
    });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "provision-sign-recover")?.ok).toBe(false);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^validate:/);
  });

  it("includes a place check only when a place fn is provided", async () => {
    const { deps } = baseDeps({ place: async () => ({ ok: true, detail: "filled" }) });
    const report = await runValidation(deps);
    expect(report.checks.find((c) => c.name === "place")?.ok).toBe(true);
    const { deps: d2 } = baseDeps();
    expect((await runValidation(d2)).checks.find((c) => c.name === "place")).toBeUndefined();
  });

  it("builds parity vectors incl. order-builder", () => {
    const names = buildValidationVectors().map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(["order-gtc", "order-cloid", "order-builder", "cancelByCloid", "scheduleCancel"]));
    expect(VALIDATE_NONCE).toBeGreaterThan(0);
  });
});
