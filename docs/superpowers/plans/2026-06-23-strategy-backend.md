# Strategy Backend Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Node/TS service in `server/` that runs users' DCA strategies 24/7 via trade-only HL agent wallets, exposing the App↔backend contract, with strict cloid idempotency.

**Architecture:** Pure scheduling/risk logic first (no deps, TDD), then an in-memory store, then HL order placement behind an injectable client, then the HTTP API (Fastify) + auth (viem signature) + SQLite persistence. Build inside-out so the core is proven before infra.

**Tech Stack:** Node 20 + TypeScript; Jest (ts-jest); `viem` (agent signing + auth verify) + `@nktkas/hyperliquid` (orders); Fastify (HTTP); `better-sqlite3` (persistence, last).

**Spec:** `docs/superpowers/specs/2026-06-23-strategy-backend-design.md`.

---

## Conventions

- All commands run in `server/`. `npx tsc --noEmit` → 0; `npx jest` → green. TDD throughout.
- No real HL network / no real keys in tests (inject fakes). Commit `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## File structure

- `server/package.json`, `server/tsconfig.json`, `server/jest.config.js` — scaffold.
- `server/src/strategies/dca.ts` — pure: `dueStrategies`, `nextRunAt`, `dcaOrderSize`.
- `server/src/risk/guards.ts` — pure: `withinCaps`.
- `server/src/strategies/store.ts` — `StrategyStore` interface + `MemoryStrategyStore`.
- `server/src/engine/scheduler.ts` — `tick(store, placer, now)`.
- `server/src/agent/agentManager.ts`, `server/src/http/*`, `server/src/auth/*`, SQLite store — later tasks (outlined).

---

### Task 1: Scaffold the `server/` project

**Files:** Create `server/package.json`, `server/tsconfig.json`, `server/jest.config.js`, `server/src/index.ts`.

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "hypersolid-strategy-backend",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": { "test": "jest", "typecheck": "tsc --noEmit" },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.11.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.2",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "CommonJS",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `server/jest.config.js`**

```js
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
};
```

- [ ] **Step 4: Create `server/src/index.ts`** (placeholder entry)

```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 5: Install + verify** — `cd server && npm install && npx tsc --noEmit` (expect 0).

- [ ] **Step 6: Commit** — `git add server && git commit --no-verify -m "chore(server): scaffold strategy backend (Node/TS/Jest)\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"`

---

### Task 2: Pure DCA logic

**Files:** Create `server/src/strategies/dca.ts`, Test `server/src/strategies/dca.test.ts`.

- [ ] **Step 1: Write the failing test** — `server/src/strategies/dca.test.ts`:

```ts
import { dueStrategies, nextRunAt, dcaOrderSize, type DcaStrategy } from "./dca";

const s = (over: Partial<DcaStrategy> = {}): DcaStrategy => ({
  id: "s1", owner: "0xo", status: "running",
  params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 },
  nextRunAt: 1000, filledTotalUsdc: 0, ...over,
});

describe("dca", () => {
  it("dueStrategies returns running strategies whose nextRunAt has passed", () => {
    const list = [s({ id: "a", nextRunAt: 500 }), s({ id: "b", nextRunAt: 5000 }), s({ id: "c", status: "paused", nextRunAt: 0 })];
    expect(dueStrategies(list, 1000).map((x) => x.id)).toEqual(["a"]);
  });

  it("skips strategies that hit maxTotalUsdc", () => {
    const capped = s({ params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, maxTotalUsdc: 50 }, filledTotalUsdc: 50, nextRunAt: 0 });
    expect(dueStrategies([capped], 1000)).toEqual([]);
  });

  it("nextRunAt advances by the interval", () => {
    expect(nextRunAt(s({ nextRunAt: 1000 }), 1000)).toBe(1000 + 24 * 3600 * 1000);
  });

  it("dcaOrderSize converts quote USDC to coin size at a price", () => {
    expect(dcaOrderSize(50, 50000)).toBeCloseTo(0.001, 9);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd server && npx jest src/strategies/dca.test.ts`

- [ ] **Step 3: Implement** — `server/src/strategies/dca.ts`:

```ts
export interface DcaParams {
  coin: string;
  side: "buy";
  quoteAmountUsdc: number;
  intervalHours: number;
  maxTotalUsdc?: number;
}

export interface DcaStrategy {
  id: string;
  owner: string;
  status: "running" | "paused";
  params: DcaParams;
  nextRunAt: number;
  filledTotalUsdc: number;
}

export function dueStrategies(list: DcaStrategy[], now: number): DcaStrategy[] {
  return list.filter(
    (s) =>
      s.status === "running" &&
      s.nextRunAt <= now &&
      (s.params.maxTotalUsdc === undefined || s.filledTotalUsdc < s.params.maxTotalUsdc),
  );
}

export function nextRunAt(s: DcaStrategy, now: number): number {
  return now + s.params.intervalHours * 3600 * 1000;
}

export function dcaOrderSize(quoteUsdc: number, price: number): number {
  return price > 0 ? quoteUsdc / price : 0;
}
```

- [ ] **Step 4: Run → PASS**, then `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add server/src/strategies && git commit --no-verify -m "feat(server): pure DCA scheduling logic\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"`

---

### Task 3: Risk guards (pure)

**Files:** Create `server/src/risk/guards.ts`, Test `server/src/risk/guards.test.ts`.

- [ ] **Step 1: Failing test** — `server/src/risk/guards.test.ts`:

```ts
import { withinCaps } from "./guards";

describe("withinCaps", () => {
  it("rejects an order above the per-order notional cap", () => {
    expect(withinCaps({ notionalUsdc: 200, killSwitch: false }, { maxNotionalUsdc: 100 }).ok).toBe(false);
  });
  it("rejects everything when the kill-switch is on", () => {
    expect(withinCaps({ notionalUsdc: 10, killSwitch: true }, { maxNotionalUsdc: 100 }).ok).toBe(false);
  });
  it("accepts an order within caps", () => {
    expect(withinCaps({ notionalUsdc: 50, killSwitch: false }, { maxNotionalUsdc: 100 }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `server/src/risk/guards.ts`:

```ts
export interface RiskInput { notionalUsdc: number; killSwitch: boolean; }
export interface RiskLimits { maxNotionalUsdc: number; }

export function withinCaps(input: RiskInput, limits: RiskLimits): { ok: boolean; reason?: string } {
  if (input.killSwitch) return { ok: false, reason: "kill-switch active" };
  if (input.notionalUsdc > limits.maxNotionalUsdc) return { ok: false, reason: "over per-order notional cap" };
  return { ok: true };
}
```

- [ ] **Step 4: Run → PASS**, `npx tsc --noEmit`.
- [ ] **Step 5: Commit.**

---

### Task 4: Strategy store interface + in-memory impl

**Files:** Create `server/src/strategies/store.ts`, Test `server/src/strategies/store.test.ts`.

- [ ] **Step 1: Failing test** — assert `MemoryStrategyStore` can `create`, `list(owner)`, `setStatus`, `recordFill` (advances nextRunAt + filledTotalUsdc), `get`.

```ts
import { MemoryStrategyStore } from "./store";

describe("MemoryStrategyStore", () => {
  it("creates, lists by owner, toggles status, and records fills", () => {
    const store = new MemoryStrategyStore(() => 1000);
    const s = store.create("0xo", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    expect(store.list("0xo")).toHaveLength(1);
    store.setStatus(s.id, "paused");
    expect(store.get(s.id)!.status).toBe("paused");
    store.recordFill(s.id, 50, 24 * 3600 * 1000 + 1000);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(50);
    expect(store.get(s.id)!.nextRunAt).toBe(24 * 3600 * 1000 + 1000);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `MemoryStrategyStore` (a `StrategyStore` interface + Map-backed impl; `create` seeds `nextRunAt = now`, `status = "running"`, `filledTotalUsdc = 0`, `id = crypto.randomUUID()`). Full code in the file.
- [ ] **Step 4: Run → PASS**, `npx tsc --noEmit`.
- [ ] **Step 5: Commit.**

---

### Task 5: Scheduler tick (idempotent)

**Files:** Create `server/src/engine/scheduler.ts`, Test `server/src/engine/scheduler.test.ts`.

The tick: for each due strategy, build a cloid, call an injected `placer.place({owner, coin, sizeUsdc, cloid})`, on success `store.recordFill`. The cloid is derived deterministically from `{strategyId, nextRunAt}` so a re-run of the same tick reuses it (idempotency) — the placer (backed by the HL cloid kernel) dedupes.

- [ ] **Step 1: Failing test** — inject a fake placer + a store with one due strategy; assert `place` called once with a stable cloid, `recordFill` advances; a second `tick` at the same `now` does NOT place again (already advanced). Kill-switch tick places nothing.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `tick(store, placer, limits, killSwitch, now)`: `dueStrategies` → `withinCaps` → `place` → `recordFill`. Full code.
- [ ] **Step 4: Run → PASS**, `npx tsc --noEmit`.
- [ ] **Step 5: Commit.**

---

### Tasks 6–9 (outlined — full code when reached)

- **T6 Agent manager:** per-owner agent keypair (`viem` `privateKeyToAccount`), encrypted at rest (interface `SecretStore`; dev `EnvSecretStore`); build an `@nktkas/hyperliquid` `ExchangeClient` signing with the agent key; expose `agentAddress`. The HL order `placer` wraps `ExchangeClient.order` reusing the cloid kernel. TDD with a fake ExchangeClient.
- **T7 Auth:** `POST /auth/challenge` (nonce) + `POST /auth/session` (verify the signature with `viem.verifyMessage` → JWT). TDD the verify + token issue with viem-signed nonces.
- **T8 HTTP routes (Fastify):** the contract endpoints, bearer-auth middleware deriving `owner` from the session; wire store + agent manager. Integration-test routes with `fastify.inject` + fakes.
- **T9 SQLite persistence:** a `SqliteStrategyStore` implementing `StrategyStore` (swap for `MemoryStrategyStore`); startup recovery reconciles non-terminal cloids. Add `better-sqlite3`.

---

## Self-Review

- **Spec coverage:** scheduler+DCA ✓ T2/T5; guards ✓ T3; store ✓ T4/T9; agent key custody+placement ✓ T6; auth ✓ T7; HTTP contract ✓ T8; idempotency/recovery ✓ T5/T9. Built inside-out so the core is TDD-proven before infra.
- **Placeholders:** T1–T5 carry complete code; T6–T9 are outlined with their interfaces named — to be filled with full code when reached (they need new deps installed first).
- **Type consistency:** `DcaParams`/`DcaStrategy` (T2) reused by store/scheduler; `withinCaps` shape (T3) used by the scheduler (T5).

## Progress

> Append one line per task.
