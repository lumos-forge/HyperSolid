# Builder-Fee Manual-Trading Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing builder-fee plumbing so manual perp trades (single / bracket / scale) actually carry the builder code and earn the 0.02% fee, gated by a one-time `approveBuilderFee` — all server-configured and fail-open.

**Architecture:** (1) server `/app-config` delivers `builder { address, perpFeeTenthBps }`; (2) `ExchangeService` attaches the builder to manual orders **only when approved**; (3) a lazy pre-first-order gate queries `maxBuilderFee`, prompts a one-time approval (main wallet), and flips a small approval store. Absent config or any failure → no builder attached, trade proceeds.

**Tech Stack:** TypeScript, React Native (Expo), zustand, `@nktkas/hyperliquid`, Jest.

**Spec:** `docs/superpowers/specs/2026-07-14-builder-fee-manual-closure-design.md`

---

## Background / invariants (read first)

- `buildOrder` / `buildBracketOrder` / `buildScaleOrder` already accept `builder?: { address: 0x; feeTenthBps: number }` and emit `params.builder = { b, f }`, cap-validated (`builderField` → `builderFeeRejected` when over the perp cap of 100 tenth-bps). TWAP (`buildTwap`/`twapOrder`) has **no** builder field — leave it untouched.
- `@nktkas`: `ExchangeClient.approveBuilderFee({ maxFeeRate: "0.1%", builder })` (main-wallet signed); `InfoClient.maxBuilderFee({ user, builder }) → number` (approved rate in **tenth-bps**).
- Fee rate = **20 tenth-bps (0.02%)**, server-delivered; approve at the perp **cap "0.1%"** so the rate can be tuned up to the cap later without re-approval.
- **Attachment is approval-gated:** the service attaches the builder ONLY when the approval store says approved, so an unapproved user never sends a builder HL would reject. Absent config / decline / query error → no builder, order proceeds.
- Config field is **zero-config safe** (absent/invalid → feature dark), mirroring `proxyPool`.
- Conventions: user-facing strings go in `src/i18n/messages.ts` (en + zh parity, enforced by `messages.test.ts`); no hardcoded hex (theme tokens / native `Alert` only); validate with `cd mobile && npx tsc --noEmit && npm test` (and `cd server && npm run typecheck && npm test` for the server config).

**Files:**
- Modify: `server/src/config/appConfig.ts` (+ `appConfig.test.ts`)
- Modify: `mobile/src/services/appConfig.ts`, `mobile/src/state/runtimeConfigStore.ts` (+ `appConfig.test.ts`)
- Modify: `mobile/src/services/exchange.ts` (+ `exchange.test.ts`)
- Create: `mobile/src/state/builderApprovalStore.ts`
- Create: `mobile/src/services/builderApproval.ts` (+ `builderApproval.test.ts`)
- Modify: `mobile/src/state/exchangeStore.ts`
- Modify: `mobile/src/screens/TradeScreen.tsx`
- Modify: `mobile/src/i18n/messages.ts`

---

## Task 1: Config plumbing (server + mobile)

### Server

**Files:** Modify `server/src/config/appConfig.ts`, `server/src/config/appConfig.test.ts`

- [ ] **Step 1: Add `builder` to the payload + env parser**

In `server/src/config/appConfig.ts`, extend the interface and the builder of the payload:

```ts
export interface AppConfigPayload {
  arbitrumRpc: { mainnet: string | null; testnet: string | null };
  withdrawFeeUsdc: { mainnet: number | null; testnet: number | null };
  strategyApiBaseUrl: string | null;
  /** Builder-code revenue config; omitted when unset (feature dark). perpFeeTenthBps in 1/10 bps. */
  builder?: { address: `0x${string}`; perpFeeTenthBps: number };
  /** Caller geo derived per-request from a proxy header (added by the /app-config handler). */
  geo?: { country?: string; region?: string };
}
```

Add a defensive parser and include it in `appConfigFromEnv`:

```ts
/** Parse the builder config from env; returns undefined unless the address is 0x+40hex AND the fee is
 *  an integer in [1, 100] (the perp cap). A misconfig disables the feature rather than risking rejects. */
function builderFromEnv(env: NodeJS.ProcessEnv): { address: `0x${string}`; perpFeeTenthBps: number } | undefined {
  const address = env.BUILDER_ADDRESS;
  const fee = Number(env.BUILDER_PERP_FEE_TENTH_BPS);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  if (!Number.isInteger(fee) || fee < 1 || fee > 100) return undefined;
  return { address: address as `0x${string}`, perpFeeTenthBps: fee };
}
```

In `appConfigFromEnv`'s returned object, add (after `strategyApiBaseUrl`):

```ts
    strategyApiBaseUrl: env.STRATEGY_API_BASE_URL ?? null,
    ...(builderFromEnv(env) ? { builder: builderFromEnv(env) } : {}),
```

- [ ] **Step 2: Server tests**

Append to `server/src/config/appConfig.test.ts` (match the file's existing style):

```ts
describe("appConfigFromEnv builder", () => {
  it("includes a valid builder config", () => {
    const cfg = appConfigFromEnv({ BUILDER_ADDRESS: "0x" + "a".repeat(40), BUILDER_PERP_FEE_TENTH_BPS: "20" } as NodeJS.ProcessEnv);
    expect(cfg.builder).toEqual({ address: "0x" + "a".repeat(40), perpFeeTenthBps: 20 });
  });
  it("omits builder when the address is invalid", () => {
    expect(appConfigFromEnv({ BUILDER_ADDRESS: "0xnope", BUILDER_PERP_FEE_TENTH_BPS: "20" } as NodeJS.ProcessEnv).builder).toBeUndefined();
  });
  it("omits builder when the fee is out of [1,100] or non-integer", () => {
    expect(appConfigFromEnv({ BUILDER_ADDRESS: "0x" + "a".repeat(40), BUILDER_PERP_FEE_TENTH_BPS: "0" } as NodeJS.ProcessEnv).builder).toBeUndefined();
    expect(appConfigFromEnv({ BUILDER_ADDRESS: "0x" + "a".repeat(40), BUILDER_PERP_FEE_TENTH_BPS: "101" } as NodeJS.ProcessEnv).builder).toBeUndefined();
    expect(appConfigFromEnv({ BUILDER_ADDRESS: "0x" + "a".repeat(40), BUILDER_PERP_FEE_TENTH_BPS: "1.5" } as NodeJS.ProcessEnv).builder).toBeUndefined();
  });
  it("omits builder when unset", () => {
    expect(appConfigFromEnv({} as NodeJS.ProcessEnv).builder).toBeUndefined();
  });
});
```

- [ ] **Step 3: Verify server**

Run: `cd server && npx jest src/config/appConfig.test.ts && npx tsc --noEmit`
Expected: PASS + clean. (The `/app-config` handler spreads `...appConfig`, so `builder` is served automatically.)

### Mobile

**Files:** Modify `mobile/src/state/runtimeConfigStore.ts`, `mobile/src/services/appConfig.ts`, `mobile/src/services/appConfig.test.ts`

- [ ] **Step 4: Add `builder` to the runtime config store**

In `mobile/src/state/runtimeConfigStore.ts`, add to `AppRuntimeConfig` (after `proxyPool`):

```ts
  /** Server-delivered builder-code config; null until delivered / when disabled. perpFeeTenthBps in 1/10 bps. */
  builder: { address: `0x${string}`; perpFeeTenthBps: number } | null;
```

Add `builder: null` to the store's initial state and to `setConfig`:

```ts
  proxyPool: [],
  builder: null,
  setConfig: (cfg) =>
    set({
      arbitrumRpc: cfg.arbitrumRpc,
      withdrawFeeUsdc: cfg.withdrawFeeUsdc,
      strategyApiBaseUrl: cfg.strategyApiBaseUrl,
      geo: cfg.geo,
      proxyPool: cfg.proxyPool,
      builder: cfg.builder,
    }),
```

Add a selector at the bottom:

```ts
/** The server-delivered builder config, or null when absent/disabled. */
export function builderConfig(): { address: `0x${string}`; perpFeeTenthBps: number } | null {
  return useRuntimeConfigStore.getState().builder;
}
```

- [ ] **Step 5: Parse `builder` in `loadAppConfig`**

In `mobile/src/services/appConfig.ts`, extend `RawAppConfig`:

```ts
  proxyPool?: string[];
  builder?: { address?: string; perpFeeTenthBps?: number } | null;
```

Add a defensive parser above `loadAppConfig`:

```ts
/** Accept a server builder config only when the address is 0x+40hex and the fee is an int in [1,100]. */
function parseBuilder(raw: RawAppConfig["builder"]): { address: `0x${string}`; perpFeeTenthBps: number } | null {
  const address = raw?.address;
  const fee = raw?.perpFeeTenthBps;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 1 || fee > 100) return null;
  return { address: address as `0x${string}`, perpFeeTenthBps: fee };
}
```

In the object returned by `loadAppConfig`, add (after `proxyPool`):

```ts
    proxyPool: (raw.proxyPool ?? []).map((u) => u.replace(/\/$/, "")),
    builder: parseBuilder(raw.builder),
```

- [ ] **Step 6: Mobile config tests**

Add to `mobile/src/services/appConfig.test.ts` (use its existing fetch-mock helper; if it builds a raw payload inline, mirror that):

```ts
it("parses a valid builder config", async () => {
  const cfg = await loadAppConfig("http://x", fakeFetch({ builder: { address: "0x" + "b".repeat(40), perpFeeTenthBps: 20 } }));
  expect(cfg.builder).toEqual({ address: "0x" + "b".repeat(40), perpFeeTenthBps: 20 });
});
it("drops an invalid builder config to null", async () => {
  expect((await loadAppConfig("http://x", fakeFetch({ builder: { address: "0xbad", perpFeeTenthBps: 20 } }))).builder).toBeNull();
  expect((await loadAppConfig("http://x", fakeFetch({ builder: { address: "0x" + "b".repeat(40), perpFeeTenthBps: 200 } }))).builder).toBeNull();
  expect((await loadAppConfig("http://x", fakeFetch({}))).builder).toBeNull();
});
```

> If `appConfig.test.ts` does not already expose a `fakeFetch(rawOverrides)` helper, add a minimal one at the top of the file:
> ```ts
> function fakeFetch(raw: Record<string, unknown>): typeof fetch {
>   return (async () => ({ ok: true, json: async () => raw })) as unknown as typeof fetch;
> }
> ```
> (Adapt names to match the file's existing mock if present — do not duplicate.)

- [ ] **Step 7: Verify mobile config**

Run: `cd mobile && npx jest src/services/appConfig.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/config/appConfig.ts server/src/config/appConfig.test.ts mobile/src/state/runtimeConfigStore.ts mobile/src/services/appConfig.ts mobile/src/services/appConfig.test.ts
git commit -m "feat(builder-fee): server-delivered builder config plumbing

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Attach the builder in `ExchangeService` (approval-gated)

**Files:** Modify `mobile/src/services/exchange.ts`, `mobile/src/services/exchange.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `mobile/src/services/exchange.test.ts` (reuse the file's existing fake client + index helpers; the sketch below shows intent — adapt to the file's harness):

```ts
describe("ExchangeService builder attachment", () => {
  const builderAddr = ("0x" + "c".repeat(40)) as `0x${string}`;
  const attach = (approved: boolean) => ({ address: builderAddr, feeTenthBps: 20, isApproved: () => approved });

  it("attaches the builder to placeOrder when approved", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, fakeIndex(), new IntentLedger(), attach(true));
    await svc.placeOrder({ coin: "BTC", side: "buy", size: 1, price: 100 });
    expect(client.lastOrder.builder).toEqual({ b: builderAddr, f: 20 });
  });

  it("does NOT attach the builder when not approved", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, fakeIndex(), new IntentLedger(), attach(false));
    await svc.placeOrder({ coin: "BTC", side: "buy", size: 1, price: 100 });
    expect(client.lastOrder.builder).toBeUndefined();
  });

  it("does NOT attach when no builder config is set (unchanged behavior)", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, fakeIndex());
    await svc.placeOrder({ coin: "BTC", side: "buy", size: 1, price: 100 });
    expect(client.lastOrder.builder).toBeUndefined();
  });

  it("attaches to placeScale and placeBracket when approved", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, fakeIndex(), new IntentLedger(), attach(true));
    await svc.placeBracket({ entry: { coin: "BTC", side: "buy", size: 1, price: 100 } });
    expect(client.lastOrder.builder).toEqual({ b: builderAddr, f: 20 });
  });

  it("approveBuilderFee forwards maxFeeRate + builder and returns ok", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, fakeIndex());
    const res = await svc.approveBuilderFee("0.1%", builderAddr);
    expect(res.ok).toBe(true);
    expect(client.lastApproveBuilderFee).toEqual({ maxFeeRate: "0.1%", builder: builderAddr });
  });
});
```

> Ensure the file's `fakeClient()` records `lastOrder` (the params passed to `client.order`) and `lastApproveBuilderFee`, and implements `approveBuilderFee`. Extend the existing fake rather than adding a parallel one.

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest src/services/exchange.test.ts`
Expected: FAIL (ctor arity / `approveBuilderFee` missing / builder not attached).

- [ ] **Step 3: Implement in `exchange.ts`**

Add the attach type + `approveBuilderFee` to `ExchangeLike`:

```ts
/** Server-delivered builder config plus a live approval predicate; the service attaches the builder
 *  only while approved (an unapproved user must not send a builder HL would reject). */
export interface BuilderAttach {
  address: `0x${string}`;
  feeTenthBps: number;
  isApproved: () => boolean;
}

export type ApproveBuilderFeeResult =
  | { ok: true; response?: unknown }
  | { ok: false; error: string; uncertain?: boolean };
```

Add to the `ExchangeLike` interface:

```ts
  approveBuilderFee(params: { maxFeeRate: `${string}%`; builder: `0x${string}` }): Promise<unknown>;
```

Change the constructor to take the optional builder attach:

```ts
  constructor(
    private client: ExchangeLike,
    private index: AssetIndex,
    private ledger: IntentLedger = new IntentLedger(),
    private builder?: BuilderAttach,
  ) {}

  /** The builder to attach right now, or undefined when unset/unapproved. */
  private builderAttach(): { address: `0x${string}`; feeTenthBps: number } | undefined {
    return this.builder && this.builder.isApproved()
      ? { address: this.builder.address, feeTenthBps: this.builder.feeTenthBps }
      : undefined;
  }
```

Attach in the three manual builder-bearing paths (an explicit `req.builder` is preserved via `??`):

```ts
  async placeOrder(req: OrderRequest): Promise<SubmitResult> {
    const built = buildOrder({ ...req, builder: req.builder ?? this.builderAttach() }, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    return this.submitBuilt(built.params, built.cloid, {
      coin: req.coin, side: req.side, size: req.size, price: req.price,
    });
  }
```

```ts
  async placeBracket(req: BracketRequest): Promise<SubmitResult> {
    const entry = { ...req.entry, builder: req.entry.builder ?? this.builderAttach() };
    const built = buildBracketOrder({ ...req, entry }, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    return this.submitBuilt(built.params, built.cloid, {
      coin: entry.coin, side: entry.side, size: entry.size, price: entry.price,
    });
  }
```

```ts
  async placeScale(req: ScaleRequest): Promise<SubmitResult> {
    const built = buildScaleOrder({ ...req, builder: req.builder ?? this.builderAttach() }, this.index);
    if (!built.ok) return { ok: false, error: rejectionMessage(built.rejection) };
    return this.submitBuilt(built.params, built.cloid, {
      coin: req.coin, side: req.side, size: req.totalSize, price: req.startPx,
    });
  }
```

Add the approve wrapper near `approveAgent` (same uncertain-receipt honesty):

```ts
  /**
   * Approve a builder to charge up to `maxFeeRate` (main-wallet signed). Idempotent (re-approving is
   * safe). A thrown receipt is uncertain — never assumed ok — mirroring approveAgent/order honesty.
   */
  async approveBuilderFee(maxFeeRate: `${string}%`, builder: `0x${string}`): Promise<ApproveBuilderFeeResult> {
    try {
      const response = await this.client.approveBuilderFee({ maxFeeRate, builder });
      return { ok: true, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
    }
  }
```

(Leave `placeTwap` unchanged — HL `twapOrder` carries no builder.)

- [ ] **Step 4: Run to verify pass**

Run: `cd mobile && npx jest src/services/exchange.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/exchange.ts mobile/src/services/exchange.test.ts
git commit -m "feat(builder-fee): attach builder to manual orders when approved

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Approval gate (store + service + TradeScreen + i18n)

**Files:** Create `mobile/src/state/builderApprovalStore.ts`, `mobile/src/services/builderApproval.ts`, `mobile/src/services/builderApproval.test.ts`; modify `mobile/src/state/exchangeStore.ts`, `mobile/src/screens/TradeScreen.tsx`, `mobile/src/i18n/messages.ts`.

- [ ] **Step 1: Approval store**

Create `mobile/src/state/builderApprovalStore.ts`:

```ts
import { create } from "zustand";

/** Session approval state for the builder fee. `approved` gates attachment; `suppressed` stops the
 *  one-time prompt from re-appearing after a decline / failure. Reset on wallet/network change. */
interface BuilderApprovalState {
  approved: boolean;
  suppressed: boolean;
  setApproved: (v: boolean) => void;
  suppress: () => void;
  reset: () => void;
}

export const useBuilderApprovalStore = create<BuilderApprovalState>((set) => ({
  approved: false,
  suppressed: false,
  setApproved: (v) => set({ approved: v }),
  suppress: () => set({ suppressed: true }),
  reset: () => set({ approved: false, suppressed: false }),
}));
```

- [ ] **Step 2: Approval query service + test**

Create `mobile/src/services/builderApproval.ts`:

```ts
/** Narrow info surface: the approved builder fee rate (tenth-bps) for a user+builder. */
export interface BuilderInfoLike {
  maxBuilderFee(params: { user: `0x${string}`; builder: `0x${string}` }): Promise<number>;
}

export type BuilderApprovalStatus = "approved" | "unapproved" | "unknown";

/** Whether `user` has approved `builder` for at least `perpFeeTenthBps` (HL maxBuilderFee is tenth-bps).
 *  A thrown query → "unknown" so the caller places without a builder and does not nag. */
export async function queryBuilderApproval(
  info: BuilderInfoLike,
  user: `0x${string}`,
  builder: `0x${string}`,
  perpFeeTenthBps: number,
): Promise<BuilderApprovalStatus> {
  try {
    const approved = await info.maxBuilderFee({ user, builder });
    return approved >= perpFeeTenthBps ? "approved" : "unapproved";
  } catch {
    return "unknown";
  }
}
```

Create `mobile/src/services/builderApproval.test.ts`:

```ts
import { queryBuilderApproval, type BuilderInfoLike } from "./builderApproval";

const U = ("0x" + "1".repeat(40)) as `0x${string}`;
const B = ("0x" + "2".repeat(40)) as `0x${string}`;
const info = (fn: BuilderInfoLike["maxBuilderFee"]): BuilderInfoLike => ({ maxBuilderFee: fn });

describe("queryBuilderApproval", () => {
  it("approved when the on-chain rate covers the needed fee", async () => {
    expect(await queryBuilderApproval(info(async () => 100), U, B, 20)).toBe("approved");
    expect(await queryBuilderApproval(info(async () => 20), U, B, 20)).toBe("approved");
  });
  it("unapproved when the on-chain rate is below the needed fee", async () => {
    expect(await queryBuilderApproval(info(async () => 0), U, B, 20)).toBe("unapproved");
    expect(await queryBuilderApproval(info(async () => 10), U, B, 20)).toBe("unapproved");
  });
  it("unknown when the query throws", async () => {
    expect(await queryBuilderApproval(info(async () => { throw new Error("net"); }), U, B, 20)).toBe("unknown");
  });
});
```

- [ ] **Step 3: Run the service test**

Run: `cd mobile && npx jest src/services/builderApproval.test.ts`
Expected: PASS.

- [ ] **Step 4: Thread the builder attach through `exchangeStore.init`**

In `mobile/src/state/exchangeStore.ts`, update `init` to accept + forward the optional builder attach. Change its type and body:

```ts
import { ExchangeService, type ExchangeLike, type BuilderAttach } from "../services/exchange";
// ... in the store interface:
  init: (client: ExchangeLike, index: AssetIndex, ledger?: IntentLedger, builder?: BuilderAttach) => void;
// ... in the implementation:
  init: (client, index, ledger, builder) => set({ service: new ExchangeService(client, index, ledger, builder) }),
```

(Match the file's existing imports/types; only add the 4th param + `BuilderAttach` import.)

- [ ] **Step 5: i18n strings**

In `mobile/src/i18n/messages.ts`, add to BOTH the `en` and `zh` maps (keep key parity — `messages.test.ts` enforces it):

en:
```ts
    "builderFee.approveTitle": "Enable low-fee trading",
    "builderFee.approveBody": "Approve once so this app can apply its 0.02% builder fee on your trades. This signature only authorizes the fee — it can never move or withdraw your funds.",
    "builderFee.approve": "Approve",
    "builderFee.notNow": "Not now",
    "builderFee.approved": "Builder fee approved",
    "builderFee.approveFailed": "Approval didn't go through — continuing without it",
```

zh:
```ts
    "builderFee.approveTitle": "启用低费率交易",
    "builderFee.approveBody": "一次性授权，App 即可对你的成交收取 0.02% builder 费。此签名仅授权费用，永远无法动用或提取你的资金。",
    "builderFee.approve": "授权",
    "builderFee.notNow": "暂不",
    "builderFee.approved": "已授权 builder 费",
    "builderFee.approveFailed": "授权未成功——本次继续下单（不收费）",
```

- [ ] **Step 6: Wire the gate into TradeScreen**

In `mobile/src/screens/TradeScreen.tsx`:

(a) Add imports:
```ts
import { builderConfig } from "../state/runtimeConfigStore";
import { useBuilderApprovalStore } from "../state/builderApprovalStore";
import { queryBuilderApproval } from "../services/builderApproval";
import { createInfoClient } from "../lib/hyperliquid/client";
```

(b) In the `init` effect, pass the builder attach when config is present:
```ts
    const bc = builderConfig();
    useExchangeStore.getState().init(
      client,
      index,
      ledger ?? undefined,
      bc ? { address: bc.address, feeTenthBps: bc.perpFeeTenthBps, isApproved: () => useBuilderApprovalStore.getState().approved } : undefined,
    );
```
Keep the effect deps as they are (config is read at init time; a mid-session config change is out of scope).

(c) Reset approval state when the wallet/network changes (near where the client is rebuilt), so a new user re-gates:
```ts
  useEffect(() => {
    useBuilderApprovalStore.getState().reset();
  }, [walletAddress, network]);
```

(d) Add the lazy gate helper inside the component:
```ts
  /** One-time, pre-first-order builder-fee approval. Fail-open: any decline/error places without a
   *  builder (the service only attaches when the store says approved) and does not re-nag this session. */
  async function ensureBuilderApproval(): Promise<void> {
    const bc = builderConfig();
    if (!bc || !walletAddress) return;
    const store = useBuilderApprovalStore.getState();
    if (store.approved || store.suppressed) return;

    const user = walletAddress as `0x${string}`;
    const status = await queryBuilderApproval(createInfoClient(network), user, bc.address, bc.perpFeeTenthBps);
    if (status === "approved") { store.setApproved(true); return; }
    if (status === "unknown") return; // place without a builder this time; retry next order

    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(t("builderFee.approveTitle"), t("builderFee.approveBody"), [
        { text: t("builderFee.notNow"), style: "cancel", onPress: () => resolve(false) },
        { text: t("builderFee.approve"), onPress: () => resolve(true) },
      ]);
    });
    if (!confirmed) { store.suppress(); return; }

    const svc = useExchangeStore.getState().service;
    const res = svc ? await svc.approveBuilderFee("0.1%", bc.address) : { ok: false as const };
    if (res.ok) {
      store.setApproved(true);
      useToastStore.getState().show(t("builderFee.approved"), "success");
    } else {
      store.suppress();
      useToastStore.getState().show(t("builderFee.approveFailed"), "info");
    }
  }
```

(e) Call the gate once in `onSubmit`, right AFTER the `if (isTwap) { … return; }` block and BEFORE the scale / single-order logic (so it covers scale + single + bracket, not TWAP):
```ts
    // Builder-fee: ensure a one-time approval before the first fee-bearing order (fail-open).
    await ensureBuilderApproval();
```

> `createInfoClient` returns an `InfoLike`; if its type does not yet include `maxBuilderFee`, either (i) add `maxBuilderFee(params: { user: 0x; builder: 0x }): Promise<number>` to the `InfoLike` interface in `client.ts` (it wraps the real `InfoClient`, which has it), or (ii) cast at the call site: `createInfoClient(network) as unknown as BuilderInfoLike`. Prefer (i) — extend `InfoLike` — and import `type BuilderInfoLike` is unnecessary then.

- [ ] **Step 7: Verify the toast API + Alert usage**

Confirm `useToastStore.getState().show(msg, "info")` supports an `"info"` variant (the file already uses `"success"`). If only `"success"`/`"error"` exist, use the nearest existing variant for the fail-open notice (do not invent one).

- [ ] **Step 8: Full validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (new `builderApproval` + `exchange` builder cases; `messages.test.ts` parity green; existing suites unaffected).

- [ ] **Step 9: Commit**

```bash
git add mobile/src/state/builderApprovalStore.ts mobile/src/services/builderApproval.ts mobile/src/services/builderApproval.test.ts mobile/src/state/exchangeStore.ts mobile/src/screens/TradeScreen.tsx mobile/src/i18n/messages.ts mobile/src/lib/hyperliquid/client.ts
git commit -m "feat(builder-fee): one-time approval gate wired into manual trade flow

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Finish — PR, review, merge

- [ ] **Step 1: Full validation (both packages)**

Run: `cd mobile && npx tsc --noEmit && npm test` and `cd server && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/builder-fee-manual
```

- [ ] **Step 3: Open the PR** (`gh pr create`) summarizing: server-delivered builder config; builder attached to manual perp orders (single/bracket/scale) only when approved; lazy one-time `approveBuilderFee` gate; fail-open; TWAP/engine excluded; zero-config safe.

- [ ] **Step 4:** Dispatch a background `code-review` agent on the branch diff AND `gh pr checks <n> --watch` in parallel.

- [ ] **Step 5:** Address any high-confidence findings; on clean review + green CI, squash-merge with `--delete-branch` and sync `main`.

---

## Self-review notes (coverage vs spec)

- **Config plumbing (server + mobile, zero-config safe, validated)** — Task 1. ✔
- **Builder attached to single/bracket/scale, approval-gated, TWAP excluded, explicit builder preserved** — Task 2. ✔
- **`approveBuilderFee` wrapper (uncertain-receipt honest), approve at cap "0.1%"** — Task 2 + Task 3. ✔
- **Lazy pre-first-order gate via `maxBuilderFee`, one-time prompt, cached** — Task 3. ✔
- **Fail-open: decline/error/unknown → place without builder, no re-nag (suppressed)** — Task 3 gate helper. ✔
- **i18n en+zh parity, no hardcoded colors (native Alert / toast)** — Task 3 Step 5. ✔
- **Fee 20 tenth-bps; cap validation fail-safe in buildOrder** — Tasks 1–2. ✔
- **Reset approval on wallet/network change** — Task 3 Step 6(c). ✔
