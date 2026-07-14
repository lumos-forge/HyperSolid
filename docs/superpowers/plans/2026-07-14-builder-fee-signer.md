# Delegated-Path Builder Fee (Sub-Unit B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread the builder fee through the delegated/signer order path: the Go signer and the TS engine both build `{ type:"order", orders, grouping, builder:{b,f} }` for approved owners, proven byte-identical by a golden vector. Omit-safe (no builder → today's action) and behind `SIGNER_DELEGATION`.

**Architecture:** Add an optional action-level `builder` to the Go `BuildOrderAction`/`ActionFromKind` and the TS `l1Action.actionFromKindParams`; `signerExchangeClient.order` carries `arg.builder` into the sign params (both sides build from it); `makeClientFor` wraps the delegated branch with sub-unit A's `BuilderInjector`. A regenerated golden vector locks cross-language parity.

**Tech Stack:** Go (`backend/`), TypeScript (`server/`), `@nktkas/hyperliquid` signing oracle, Jest, Go test.

**Spec:** `docs/superpowers/specs/2026-07-14-builder-fee-signer-design.md`

---

## Background / invariants (read first)

- HL `order` action field order: `{ type, orders, grouping, builder }`; `builder = { b: address, f: feeTenthBps }` appended **after** `grouping`, **omitted when absent** (@nktkas schema; `f` is 0.1bps, perp cap 100). msgpack preserves insertion order — both languages must append `builder` last, with inner key order `{b, f}`.
- `BuildOrderAction` is called only at `digest.go:26` (via `ActionFromKind`) + `action_test.go` (2 calls). Adding a 3rd param `builder *BuilderInput` requires updating those 3 sites.
- `modify`/`batchModify` build via `orderTuple` (no action-level builder in HL) → untouched.
- The sign request `params` is the single source: the Go signer builds the signed action from it; the TS engine builds the submitted action from the same `params` via `l1Action`. Both must emit `builder` identically.
- Parity is guarded by the golden vectors: Go `golden_test.go` rebuilds via `ActionFromKind`; TS `l1Action.golden.test.ts` (PR #109) rebuilds via `actionFromKindParams` and iterates every order/cancelByCloid/scheduleCancel vector — a new `order-builder` vector is covered by both automatically.
- Validate: `cd backend && gofmt -w ./... && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`; `cd server && npm run typecheck && npm test`; regenerate golden via `cd mobile && node scripts/gen-golden-vectors.mjs`.

**Files:**
- Modify: `backend/internal/hl/action.go` (+ `action_test.go`), `backend/internal/hl/digest.go`
- Modify: `mobile/scripts/gen-golden-vectors.mjs`; regenerate `backend/internal/hl/testdata/golden.json`
- Modify: `server/src/agent/l1Action.ts` (+ `l1Action.test.ts`), `server/src/agent/signerExchangeClient.ts` (+ `signerExchangeClient.test.ts`), `server/src/agent/hlRuntime.ts` (+ `hlRuntime.test.ts`)

---

## Task 1: Go signer — optional action-level builder

**Files:** Modify `backend/internal/hl/action.go`, `backend/internal/hl/action_test.go`, `backend/internal/hl/digest.go`

- [ ] **Step 1: Update `BuildOrderAction` + add `BuilderInput` (`action.go`)**

Replace:

```go
// BuildOrderAction builds the ordered msgpack Map for an `order` action (fields in HL byte order).
func BuildOrderAction(orders []OrderInput, grouping string) Map {
	arr := make([]any, len(orders))
	for i, o := range orders {
		arr[i] = orderTuple(o)
	}
	return Map{{"type", "order"}, {"orders", arr}, {"grouping", grouping}}
}
```

with:

```go
// BuilderInput is the optional action-level builder fee: an address paid a fee of FeeTenthBps (1/10 bps).
type BuilderInput struct {
	Address     string
	FeeTenthBps int64
}

// BuildOrderAction builds the ordered msgpack Map for an `order` action (fields in HL byte order).
// The optional builder fee is appended last (`{b,f}`) and omitted entirely when nil (HL omit rule).
func BuildOrderAction(orders []OrderInput, grouping string, builder *BuilderInput) Map {
	arr := make([]any, len(orders))
	for i, o := range orders {
		arr[i] = orderTuple(o)
	}
	m := Map{{"type", "order"}, {"orders", arr}, {"grouping", grouping}}
	if builder != nil {
		m = append(m, KV{"builder", Map{{"b", builder.Address}, {"f", builder.FeeTenthBps}}})
	}
	return m
}
```

- [ ] **Step 2: Thread the builder through `ActionFromKind` "order" (`digest.go`)**

In the `case "order":` block, add `Builder` to the params struct and pass it. Replace:

```go
	case "order":
		var p struct {
			Asset      int64  `json:"asset"`
			IsBuy      bool   `json:"isBuy"`
			Px         string `json:"px"`
			Sz         string `json:"sz"`
			ReduceOnly bool   `json:"reduceOnly"`
			Tif        string `json:"tif"`
			Grouping   string `json:"grouping"`
			Cloid      string `json:"cloid"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildOrderAction([]OrderInput{{Asset: p.Asset, IsBuy: p.IsBuy, Px: p.Px, Sz: p.Sz, ReduceOnly: p.ReduceOnly, Tif: p.Tif, Cloid: p.Cloid}}, p.Grouping), nil
```

with:

```go
	case "order":
		var p struct {
			Asset      int64  `json:"asset"`
			IsBuy      bool   `json:"isBuy"`
			Px         string `json:"px"`
			Sz         string `json:"sz"`
			ReduceOnly bool   `json:"reduceOnly"`
			Tif        string `json:"tif"`
			Grouping   string `json:"grouping"`
			Cloid      string `json:"cloid"`
			Builder    *struct {
				B string `json:"b"`
				F int64  `json:"f"`
			} `json:"builder"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		var builder *BuilderInput
		if p.Builder != nil {
			builder = &BuilderInput{Address: p.Builder.B, FeeTenthBps: p.Builder.F}
		}
		return BuildOrderAction([]OrderInput{{Asset: p.Asset, IsBuy: p.IsBuy, Px: p.Px, Sz: p.Sz, ReduceOnly: p.ReduceOnly, Tif: p.Tif, Cloid: p.Cloid}}, p.Grouping, builder), nil
```

- [ ] **Step 3: Update the two existing `action_test.go` calls + add a with-builder test**

In `action_test.go`, change the two `BuildOrderAction(..., "na")` calls to pass `nil`:
- `TestBuildOrderAction`: `BuildOrderAction([]OrderInput{{...}}, "na")` → `BuildOrderAction([]OrderInput{{...}}, "na", nil)`
- `TestBuildOrderActionWithCloid`: `BuildOrderAction([]OrderInput{{...}}, "na")` → `BuildOrderAction([]OrderInput{{...}}, "na", nil)`

Add a new test after `TestBuildOrderActionWithCloid`:

```go
func TestBuildOrderActionWithBuilder(t *testing.T) {
	got := BuildOrderAction(
		[]OrderInput{{Asset: 0, IsBuy: true, Px: "50000", Sz: "0.01", Tif: "Gtc"}},
		"na",
		&BuilderInput{Address: "0x1111111111111111111111111111111111111111", FeeTenthBps: 20},
	)
	last := got[len(got)-1]
	if last.K != "builder" {
		t.Fatalf("expected trailing builder field, got %#v", got)
	}
	b := last.V.(Map)
	if b[0].K != "b" || b[0].V.(string) != "0x1111111111111111111111111111111111111111" || b[1].K != "f" || b[1].V.(int64) != 20 {
		t.Fatalf("builder field mismatch: %#v", b)
	}
}

func TestBuildOrderActionOmitsBuilderWhenNil(t *testing.T) {
	got := BuildOrderAction([]OrderInput{{Asset: 0, IsBuy: true, Px: "1", Sz: "1", Tif: "Gtc"}}, "na", nil)
	if got[len(got)-1].K != "grouping" {
		t.Fatalf("expected no builder field when nil, got %#v", got)
	}
}
```

- [ ] **Step 4: Verify Go (before golden regen — the golden_test still uses old vectors here)**

Run: `cd backend && gofmt -w ./internal/hl/ && go test ./internal/hl/ 2>&1 | tail -15`
Expected: PASS (the existing golden vectors have no builder, so `ActionFromKind` builds them unchanged; the new action_test cases pass).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/hl/action.go backend/internal/hl/action_test.go backend/internal/hl/digest.go
git commit -m "feat(builder-fee): optional action-level builder in the Go signer order action

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Golden vector for order-with-builder

**Files:** Modify `mobile/scripts/gen-golden-vectors.mjs`; regenerate `backend/internal/hl/testdata/golden.json`

- [ ] **Step 1: Extend `buildAction("order")` (`gen-golden-vectors.mjs`)**

Replace:

```js
  if (kind === "order") {
    const o = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    return { type: "order", orders: [o], grouping: p.grouping ?? "na" };
  }
```

with:

```js
  if (kind === "order") {
    const o = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    const action = { type: "order", orders: [o], grouping: p.grouping ?? "na" };
    if (p.builder) action.builder = { b: p.builder.b, f: p.builder.f };
    return action;
  }
```

- [ ] **Step 2: Add the vector**

In the `cases` array, add after `order-limit-cloid-mainnet`:

```js
  { name: "order-builder-mainnet", kind: "order", isTestnet: false, params: { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na", builder: { b: "0x1111111111111111111111111111111111111111", f: 20 } } },
```

- [ ] **Step 3: Regenerate the golden file**

Run: `cd mobile && node scripts/gen-golden-vectors.mjs`
Expected: `wrote N vectors to …/golden.json` (N = previous + 1). Confirm `git diff --stat backend/internal/hl/testdata/golden.json` shows only the added vector.

- [ ] **Step 4: Verify Go golden parity with the new vector**

Run: `cd backend && go test ./internal/hl/ 2>&1 | tail -15`
Expected: PASS — `golden_test.go` rebuilds the `order-builder-mainnet` action via `ActionFromKind` (now with builder) and its hash equals the oracle-generated `actionHash`.

- [ ] **Step 5: Commit**

```bash
git add mobile/scripts/gen-golden-vectors.mjs backend/internal/hl/testdata/golden.json
git commit -m "test(builder-fee): golden vector for order-with-builder (cross-language parity)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: TS engine — builder through l1Action, signerExchangeClient, makeClientFor

**Files:** Modify `server/src/agent/l1Action.ts` (+ `l1Action.test.ts`), `server/src/agent/signerExchangeClient.ts` (+ `signerExchangeClient.test.ts`), `server/src/agent/hlRuntime.ts` (+ `hlRuntime.test.ts`)

- [ ] **Step 1: `l1Action.ts` — build the order action with an optional builder**

In `OrderParams`, add the builder field:

```ts
export interface OrderParams {
  asset: number;
  isBuy: boolean;
  px: string;
  sz: string;
  reduceOnly: boolean;
  tif: string; // "Gtc" | "Ioc" | "Alo"
  grouping?: string; // default "na"
  cloid?: string;
  builder?: { b: `0x${string}`; f: number };
}
```

In `actionFromKindParams`, replace the `order` branch:

```ts
  if (kind === "order") {
    const p = params as OrderParams;
    const o: Record<string, unknown> = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    return { type: "order", orders: [o], grouping: p.grouping ?? "na" };
  }
```

with:

```ts
  if (kind === "order") {
    const p = params as OrderParams;
    const o: Record<string, unknown> = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    const action: Record<string, unknown> = { type: "order", orders: [o], grouping: p.grouping ?? "na" };
    if (p.builder) action.builder = { b: p.builder.b, f: p.builder.f };
    return action;
  }
```

- [ ] **Step 2: `l1Action.test.ts` — assert the builder shape (append order)**

Add to the `actionFromKindParams` describe:

```ts
  it("appends the builder after grouping when present", () => {
    const a = actionFromKindParams("order", {
      asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na",
      builder: { b: "0x1111111111111111111111111111111111111111", f: 20 },
    }) as Record<string, unknown>;
    expect(a).toEqual({
      type: "order",
      orders: [{ a: 0, b: true, p: "50000", s: "0.01", r: false, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
      builder: { b: "0x1111111111111111111111111111111111111111", f: 20 },
    });
    expect(Object.keys(a)).toEqual(["type", "orders", "grouping", "builder"]);
  });

  it("omits the builder when absent (unchanged action)", () => {
    const a = actionFromKindParams("order", { asset: 0, isBuy: true, px: "1", sz: "1", reduceOnly: false, tif: "Ioc" }) as Record<string, unknown>;
    expect("builder" in a).toBe(false);
  });
```

- [ ] **Step 3: `signerExchangeClient.ts` — carry `arg.builder` into the sign params**

Add `builder` to the `OrderArg` type:

```ts
interface OrderArg {
  orders: OrderTuple[];
  grouping?: string;
  builder?: { b: `0x${string}`; f: number };
}
```

In `order`, include the builder in the params (build the action from the SAME params via `signAndSubmit` → `actionFromKindParams`, so submit + signed actions match). Replace:

```ts
    async order(arg: OrderArg): Promise<unknown> {
      const o = arg.orders[0];
      const grouping = arg.grouping ?? "na";
      const cloid = o.c ?? deriveCloid(`order:${o.a}:${o.b}:${o.p}:${o.s}:${o.r}:${o.t.limit.tif}:${grouping}`);
      const params = { asset: o.a, isBuy: o.b, px: o.p, sz: o.s, reduceOnly: o.r, tif: o.t.limit.tif, grouping, cloid };
      const res = await signAndSubmit("order", params, cloid);
      void signer.reconcile(keyId, cloid, reconcileStatusFromRes(res)).catch(() => undefined);
      return res;
    },
```

with:

```ts
    async order(arg: OrderArg): Promise<unknown> {
      const o = arg.orders[0];
      const grouping = arg.grouping ?? "na";
      const cloid = o.c ?? deriveCloid(`order:${o.a}:${o.b}:${o.p}:${o.s}:${o.r}:${o.t.limit.tif}:${grouping}`);
      const params = {
        asset: o.a, isBuy: o.b, px: o.p, sz: o.s, reduceOnly: o.r, tif: o.t.limit.tif, grouping, cloid,
        ...(arg.builder ? { builder: arg.builder } : {}),
      };
      const res = await signAndSubmit("order", params, cloid);
      void signer.reconcile(keyId, cloid, reconcileStatusFromRes(res)).catch(() => undefined);
      return res;
    },
```

- [ ] **Step 4: `signerExchangeClient.test.ts` — assert builder in the sign params + submitted action**

Add a case to the `makeSignerBackedExchangeClient.order` describe (reuse the file's `fakeSigner`/`fakeTransport`):

```ts
  it("threads a builder into the sign params and the submitted action", async () => {
    const { signer, signCalls } = fakeSigner();
    const { transport, calls } = fakeTransport({ response: { data: { statuses: [{ resting: { oid: 1 } }] } } });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: true });
    const builder = { b: "0x1111111111111111111111111111111111111111" as `0x${string}`, f: 20 };
    await client.order({ ...ORDER_ARG, builder });
    expect((signCalls[0] as { params: { builder?: unknown } }).params.builder).toEqual(builder);
    expect((calls[0].payload as { action: { builder?: unknown } }).action.builder).toEqual(builder);
  });

  it("omits the builder from the action when arg has none", async () => {
    const { signer } = fakeSigner();
    const { transport, calls } = fakeTransport({ response: { data: { statuses: [{ resting: { oid: 1 } }] } } });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: true });
    await client.order(ORDER_ARG);
    expect("builder" in (calls[0].payload as { action: object }).action).toBe(false);
  });
```

- [ ] **Step 5: `hlRuntime.ts` — wrap the delegated branch with the builder injector**

In `makeClientFor`, replace the delegated-branch client construction:

```ts
      if (keyId) {
        const client = makeSignerBackedExchangeClient({
          keyId,
          signer: delegation.signer,
          transport: transport as unknown as ExchangeTransport,
          isTestnet: delegation.isTestnet,
        }) as unknown as RestingClientLike;
        cache.set(owner, client);
        return client;
      }
```

with:

```ts
      if (keyId) {
        const signerClient = makeSignerBackedExchangeClient({
          keyId,
          signer: delegation.signer,
          transport: transport as unknown as ExchangeTransport,
          isTestnet: delegation.isTestnet,
        }) as unknown as RestingClientLike;
        const client = builderInjector ? wrapClientWithBuilder(signerClient, owner, builderInjector) : signerClient;
        cache.set(owner, client);
        return client;
      }
```

- [ ] **Step 6: `hlRuntime.test.ts` — the delegated branch now consults the injector**

Update the existing `"does NOT apply the builder wrapper on the delegated (signer) path"` test — it is now the opposite. Replace that test with:

```ts
  it("applies the builder wrapper on the delegated (signer) path (injector consulted, builder signed)", async () => {
    const BUILDER_ADDR = ("0x" + "d".repeat(40)) as `0x${string}`;
    const builderFor = jest.fn(async () => ({ b: BUILDER_ADDR, f: 20 }));
    const signCalls: Array<{ params: { builder?: unknown } }> = [];
    const signer = {
      sign: async (r: { params: { builder?: unknown } }) => { signCalls.push(r); return { r: "0xr", s: "0xs", v: 27, nonce: 1, duplicate: false }; },
      reconcile: async () => undefined,
    } as unknown as SignerLike;
    const transport = { request: async () => ({}) } as unknown as HttpTransport;
    const agents = new AgentManager(approvedStore({ owner: "0xo", agentAddress: "0xa", keyId: "agent:0xo" }), () => PK);
    const clientFor = makeClientFor(agents, transport, now, { signer, isTestnet: true }, { builderFor });
    const client = clientFor("0xo") as unknown as { order(p: unknown): Promise<unknown> };
    await client.order({ orders: [{ a: 0, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: "0xc" }], grouping: "na" });
    expect(builderFor).toHaveBeenCalledWith("0xo");
    expect(signCalls[0].params.builder).toEqual({ b: BUILDER_ADDR, f: 20 });
  });
```

- [ ] **Step 7: Full validation**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass — including `l1Action.golden.test.ts` (the new `order-builder-mainnet` vector's built action hashes to the golden `actionHash`).

- [ ] **Step 8: Commit**

```bash
git add server/src/agent/l1Action.ts server/src/agent/l1Action.test.ts server/src/agent/signerExchangeClient.ts server/src/agent/signerExchangeClient.test.ts server/src/agent/hlRuntime.ts server/src/agent/hlRuntime.test.ts
git commit -m "feat(builder-fee): carry builder through the delegated signer order path

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Finish — validate, PR, review, merge

- [ ] **Step 1: Full cross-package validation**

Run: `cd backend && gofmt -l ./internal/hl/ && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Then: `cd server && npm run typecheck && npm test`
Expected: all green; `gofmt -l` prints nothing.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/builder-fee-signer
```

- [ ] **Step 3: Open the PR** (`gh pr create`) summarizing: optional action-level builder in the Go
  signer + TS engine order action (byte-identical, golden-verified); `signerExchangeClient` + delegated
  `makeClientFor` wrapping carry it for approved owners; omit-safe; only effective once
  `SIGNER_DELEGATION` is on.

- [ ] **Step 4:** Dispatch a background `code-review` agent on the branch diff AND `gh pr checks <n> --watch` in parallel.

- [ ] **Step 5:** Address any high-confidence findings; on clean review + green CI, squash-merge with `--delete-branch` and sync `main`.

---

## Self-review notes (coverage vs spec)

- **Go action-level builder (append after grouping, omit when nil), `ActionFromKind` params** — Task 1. ✔
- **Golden vector + regenerate; Go + TS parity auto-covered** — Task 2. ✔
- **TS `l1Action` builder (same field order), `signerExchangeClient` params, delegated `makeClientFor` wrapping** — Task 3. ✔
- **Omit-safe (no builder → byte-identical action)** — Task 1/Task 3 omit branches + tests. ✔
- **Approval-gating + fail-open reused via `BuilderInjector`** — Task 3 Step 5 (delegated wrapper). ✔
- **Only `order` carries a builder; modify/cancel/scheduleCancel untouched** — Task 1 (BuildOrderAction only) + Task 3 (order only). ✔
