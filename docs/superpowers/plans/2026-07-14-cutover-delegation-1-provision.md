# Cutover Delegation PR ① — Dual-Custody Data Model + Provisioning Delegation — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make agent records dual-custody (local `privateKey` OR signer `keyId`) and route `/agent/provision` through `SignerClient.createKey` when `SIGNER_DELEGATION` is on. Signing is unchanged (PR ②); the flag stays off by default → zero behavior change.

**Architecture:** `AgentRecord` gains optional `keyId`; `provision` becomes async and delegates to the signer under a flag; `SqliteAgentStore` stores signer-custody records (empty key sentinel + `key_id` column).

**Tech Stack:** TypeScript, better-sqlite3, jest.

Spec: `docs/superpowers/specs/2026-07-14-cutover-signing-delegation-design.md`
Branch: `feat/cutover-delegation-1-provision`
Validation: `cd server && npm run typecheck && npm test`.

---

### Task 1: Dual-custody `AgentRecord` + async signer-delegated `provision` (TDD)

**Files:** Modify `server/src/agent/agentManager.ts`, `server/src/agent/agentManager.test.ts`

- [ ] **Step 1: Update the existing tests to `await` provision + add a delegation test**

In `agentManager.test.ts`, make each test that calls `mgr.provision(...)` `async` and `await` it
(e.g. `const { agentAddress } = await mgr.provision("0xowner");`, `const addr = (await mgr.provision("0xowner")).agentAddress;`).
Add a delegation test:
```ts
import type { SignerClient } from "./signerClient";

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
  expect(createKey).toHaveBeenCalledWith(expect.objectContaining({ keyId: "agent:0xowner", ownerAddress: "0xowner", allowedKinds: ["order", "scheduleCancel"], maxNotionalUsdc: 1000 }));
  const rec = store.get("0xowner")!;
  expect(rec.keyId).toBe("agent:0xowner");
  expect(rec.privateKey).toBeUndefined();
  expect(mgr.keyIdFor("0xowner")).toBe("agent:0xowner");
  expect(mgr.privateKeyFor("0xowner")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/agent/agentManager.test.ts`
Expected: FAIL (provision not async / 3rd ctor arg + keyId unsupported).

- [ ] **Step 3: Implement**

In `agentManager.ts`:
- Import the client type: `import type { SignerClient, ProvisionKeyRequest } from "./signerClient";`
- `AgentRecord`: make `privateKey` optional and add `keyId`:
  ```ts
  export interface AgentRecord {
    owner: string;
    agentAddress: string;
    privateKey?: `0x${string}`;
    keyId?: string;
    approved: boolean;
    validUntil?: number;
  }
  ```
- Add the delegation config type + optional ctor arg:
  ```ts
  export type ProvisionCaps = Pick<
    ProvisionKeyRequest,
    "allowedKinds" | "maxNotionalUsdc" | "perCoinMaxUsdc" | "dailyMaxNotionalUsdc"
  >;
  export interface DelegationDeps { signer: SignerClient; caps: ProvisionCaps; }
  ```
  ```ts
  constructor(
    private store: AgentStore,
    private genKey: () => `0x${string}`,
    private delegation?: DelegationDeps,
  ) {}
  ```
- Make `provision` async + branch on delegation:
  ```ts
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
  ```
- Add the keyId helpers + a `deriveKeyId`:
  ```ts
  keyIdFor(owner: string): string | undefined {
    return this.store.get(owner)?.keyId;
  }
  ```
  (top-level, above the class:)
  ```ts
  function deriveKeyId(owner: string): string {
    return "agent:" + owner.toLowerCase();
  }
  ```
- Leave `privateKeyFor` as-is (returns undefined when `privateKey` is absent).

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx jest src/agent/agentManager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/agentManager.ts server/src/agent/agentManager.test.ts
git commit -m "feat(cutover): dual-custody AgentRecord + async signer-delegated provision"
```

---

### Task 2: `SqliteAgentStore` dual-custody persistence (TDD)

**Files:** Modify `server/src/agent/sqliteAgentStore.ts`; Test `server/src/agent/sqliteAgentStore.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/extend `sqliteAgentStore.test.ts`:
```ts
import { SqliteAgentStore } from "./sqliteAgentStore";

const encKey = Buffer.alloc(32, 7);

describe("SqliteAgentStore dual custody", () => {
  it("round-trips a local-custody record (privateKey, no keyId)", () => {
    const s = SqliteAgentStore.open(":memory:", encKey);
    s.set({ owner: "0xA", agentAddress: "0xagentA", privateKey: ("0x" + "1".repeat(64)) as `0x${string}`, approved: true, validUntil: 123 });
    const r = s.get("0xa")!;
    expect(r.privateKey).toBe("0x" + "1".repeat(64));
    expect(r.keyId).toBeUndefined();
    expect(r.approved).toBe(true);
    s.close();
  });

  it("round-trips a signer-custody record (keyId, no privateKey)", () => {
    const s = SqliteAgentStore.open(":memory:", encKey);
    s.set({ owner: "0xB", agentAddress: "0xagentB", keyId: "agent:0xb", approved: false });
    const r = s.get("0xb")!;
    expect(r.keyId).toBe("agent:0xb");
    expect(r.privateKey).toBeUndefined();
    expect(r.approved).toBe(false);
    s.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/agent/sqliteAgentStore.test.ts`
Expected: FAIL (keyId not persisted; signer-custody set throws on the NOT NULL key).

- [ ] **Step 3: Implement**

In `sqliteAgentStore.ts`:
- `Row` gains `key_id: string | null`.
- In `open`, after the `CREATE TABLE`, add a guarded `key_id` column migration:
  ```ts
  const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "key_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN key_id TEXT");
  }
  ```
- `get`: derive both fields (empty key → undefined):
  ```ts
  return {
    owner: row.owner,
    agentAddress: row.agent_address,
    privateKey: row.enc_private_key ? (open(row.enc_private_key, this.encKey) as `0x${string}`) : undefined,
    keyId: row.key_id ?? undefined,
    approved: row.approved === 1,
    validUntil: row.valid_until ?? undefined,
  };
  ```
- `set`: sentinel empty string for the key when signer-custody; persist `key_id`:
  ```ts
  .run({
    owner: rec.owner.toLowerCase(),
    agentAddress: rec.agentAddress,
    enc: rec.privateKey ? seal(rec.privateKey, this.encKey) : "",
    keyId: rec.keyId ?? null,
    approved: rec.approved ? 1 : 0,
    validUntil: rec.validUntil ?? null,
  });
  ```
  and extend the SQL to include `key_id`:
  ```sql
  INSERT INTO agents (owner, agent_address, enc_private_key, key_id, approved, valid_until)
  VALUES (@owner, @agentAddress, @enc, @keyId, @approved, @validUntil)
  ON CONFLICT(owner) DO UPDATE SET
    agent_address = excluded.agent_address,
    enc_private_key = excluded.enc_private_key,
    key_id = excluded.key_id,
    approved = excluded.approved,
    valid_until = excluded.valid_until
  ```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx jest src/agent/sqliteAgentStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/sqliteAgentStore.ts server/src/agent/sqliteAgentStore.test.ts
git commit -m "feat(cutover): SqliteAgentStore persists signer-custody agent records"
```

---

### Task 3: Wire the flag + config in `index.ts`

**Files:** Modify `server/src/index.ts`

- [ ] **Step 1: Construct a SignerClient + delegation deps when the flag is on**

Near the agent setup (after `agentEncKey`), add:
```ts
import { SignerClient } from "./agent/signerClient";
```
and, replacing the `agents` construction:
```ts
  const delegation =
    process.env.SIGNER_DELEGATION === "1"
      ? {
          signer: new SignerClient(requireEnv("SIGNER_URL")),
          caps: {
            allowedKinds: ["order", "cancel", "cancelByCloid", "scheduleCancel"],
            maxNotionalUsdc,
            perCoinMaxUsdc: perCoinMaxNotionalUsdc,
            dailyMaxNotionalUsdc,
          },
        }
      : undefined;
  const agents = new AgentManager(SqliteAgentStore.open(dbPath, agentEncKey), generatePrivateKey, delegation);
```
(`maxNotionalUsdc`, `perCoinMaxNotionalUsdc`, `dailyMaxNotionalUsdc` are already computed above; `requireEnv("SIGNER_URL")` fails fast when delegation is on but the URL is missing.)

- [ ] **Step 2: Typecheck + full suite**

Run: `cd server && npm run typecheck && npm test`
Expected: tsc clean; all suites pass (the flag is off in tests → no behavior change).

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(cutover): wire SIGNER_DELEGATION + SIGNER_URL for provisioning"
```

---

### Task 4: Finish the branch

- [ ] **Step 1: Final validation** — `cd server && npm run typecheck && npm test` green.
- [ ] **Step 2: Push + PR** — `gh pr create --title "feat(cutover): dual-custody agent records + provisioning delegation (flag off)" --body-file <body>`. Body: AgentRecord dual-custody, async provision via SignerClient.createKey (flag-gated), SqliteAgentStore signer-custody persistence, `SIGNER_DELEGATION`/`SIGNER_URL` wiring; **flag off by default → zero behavior change; signing is PR ②**.
- [ ] **Step 3: Code review + CI** — dispatch code-review (background; emphasize: flag-off is a pure no-op, no privateKey stored for signer-custody, provision idempotent, caps mirrored) + `gh pr checks <n> --watch`.
- [ ] **Step 4: Merge** — clean review + green CI → `gh pr merge --squash --delete-branch`; sync main.

---

## Self-review

- **Spec coverage:** dual-custody model + store migration (T1/T2), async signer-delegated provision + keyIdFor (T1), flag/config wiring + caps (T3). Signing delegation is PR ② (out of scope, noted).
- **Placeholder scan:** none — full code + commands.
- **Type consistency:** `AgentRecord.keyId?`, `privateKey?`, `DelegationDeps{signer,caps}`, `ProvisionCaps`, `keyIdFor`, `deriveKeyId`, and the `SqliteAgentStore` `key_id` handling are used consistently; `SignerClient.createKey` request shape matches `ProvisionKeyRequest` from Phase 2a.
- **Safety:** flag off → local path unchanged (all existing tests still pass after the async-await update); signer-custody stores no private key (empty sentinel); `requireEnv("SIGNER_URL")` fails fast when delegation is on.
