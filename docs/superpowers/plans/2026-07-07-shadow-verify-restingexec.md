# 影子校验扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TS 影子校验扩到 restingExecutor 实际签的 action（ALO `order` + `cancelByCloid`），新增 `cancelByCloid` 映射，并给影子 fetch 加 AbortController 超时（默认 2000ms）。

**Architecture:** 纯增量，延续 PR #20 的零风险姿态（fire-and-forget、吞异常、默认关）。`signerShadow.ts` 加超时 + cancelByCloid 映射；`restingExecutor.ts` 加可选 `shadowVerify?` 依赖并在两处调用点旁路触发；`index.ts` 把已有 `shadowVerify` 传入 restingExecutor。永不阻塞、永不改变真实下单/撤单结果。

**Tech Stack:** TS（`server/`，`@nktkas/hyperliquid/signing`，jest）；仅改 3 个源文件 + 2 个测试文件。

---

## File Structure

- `server/src/agent/signerShadow.ts`（改）—— fetch 超时（AbortController）+ `cancelByCloid` 映射。
- `server/src/agent/signerShadow.test.ts`（改）—— 超时 + cancelByCloid 匹配用例。
- `server/src/agent/restingExecutor.ts`（改）—— 可选 `shadowVerify?` + placeLimit/cancelCloid 调用点。
- `server/src/agent/restingExecutor.test.ts`（改）—— shadowVerify spy 用例。
- `server/src/index.ts`（改）—— 把 `shadowVerify` 传入 `makeRestingExecutor`。

## 现有约定（供无上下文的实现者参考）

- `signerShadow.ts`（现状，PR #20 后）：`SHADOW_NONCE=1`；`FetchLike = (url, init?: {method?,headers?,body?}) => Promise<{ok,status,json()}>`；`ShadowOpts{url,isTestnet?,nonce?,fetchImpl?,logger?}`；`actionFromKindParams(kind, params)` 目前仅映射 `order`（`{type:"order",orders:[{a,b,p,s,r,t:{limit:{tif}}(,c)}],grouping}`），未知 kind 返回 `undefined`；`makeShadowVerifier(opts)` 返回 `(kind, params) => void`，内部 `void (async () => { try { … } catch { warn } })()`。
- `restingExecutor.ts`：`RestingClientLike{order,cancelByCloid}`；`RestingExecutorDeps{clientFor, resolveAsset}`；`placeLimit` 构造 `order = {a:assetIndex, b:req.side==="buy", p:formatPrice(...), s:size.toString(), r:req.reduceOnly, t:{limit:{tif:"Alo"}}, c:req.cloid}` 后 `await client.order({orders:[order], grouping:"na"})`；`cancelCloid` 解 `const {assetIndex}=await deps.resolveAsset(req.coin)` 后 `await client.cancelByCloid({cancels:[{asset:assetIndex, cloid:req.cloid}]})`。
- `restingExecutor.test.ts`：`function deps(client) { return { clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }) }; }`；`restingRes = {response:{data:{statuses:[{resting:{oid:999}}]}}}`。
- `index.ts`：`shadowVerify`（PR #20，从 `SIGNER_SHADOW_URL` 构造，未配则 `undefined`）已存在；`const restingExec = makeRestingExecutor({ clientFor, resolveAsset: resolvers.resolveAsset });`。
- 验证：`cd server && npx tsc --noEmit && npx jest`。基线 220 tests / 27 suites。
- 提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。Go 侧不改。

---

### Task 1: `signerShadow.ts` — fetch 超时 + cancelByCloid 映射

**Files:**
- Modify: `server/src/agent/signerShadow.ts`
- Test: `server/src/agent/signerShadow.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `server/src/agent/signerShadow.test.ts` 顶部（既有 `orderParams` 附近）加入 cancelByCloid 的固定参数与期望 hash 助手，并在 `describe` 内追加两个用例。具体：在文件顶部已有 helper 之后加：

```ts
const cancelParams = { cancels: [{ asset: 0, cloid: "0x00000000000000000000000000000001" }] };

function expectedCancelHash(): string {
  return createL1ActionHash({
    action: { type: "cancelByCloid", cancels: [{ asset: 0, cloid: "0x00000000000000000000000000000001" }] },
    nonce: SHADOW_NONCE,
  });
}
```

在 `describe("makeShadowVerifier", …)` 内追加：

```ts
  it("no warn for a matching cancelByCloid (real @nktkas hash)", async () => {
    const warn = jest.fn();
    const f = fetchReturning(expectedCancelHash());
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    verify("cancelByCloid", cancelParams);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("aborts and swallows a hung fetch after the timeout", async () => {
    const warn = jest.fn();
    const f = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, timeoutMs: 20, logger: { warn, debug: jest.fn() } });
    verify("order", orderParams);
    await new Promise((r) => setTimeout(r, 60));
    expect(warn).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest signerShadow`
Expected: FAIL — the cancelByCloid case gets a mismatch/undefined-action warn (mapping missing), and the timeout case never aborts (no timeout wired) so `warn` isn't called → assertions fail. (Also `timeoutMs` isn't yet a valid option; tsc may flag it — see Step 3.)

- [ ] **Step 3: Add signal to FetchLike, timeoutMs to ShadowOpts, cancelByCloid mapping, and the timeout wrap**

In `server/src/agent/signerShadow.ts`:

(a) Add `signal?: AbortSignal` to the `FetchLike` init type:
```ts
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
```

(b) Add `timeoutMs?: number` to `ShadowOpts`:
```ts
export interface ShadowOpts {
  url: string;
  isTestnet?: boolean;
  nonce?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  logger?: ShadowLogger;
}
```

(c) Add a `cancelByCloid` branch to `actionFromKindParams`, right before `return undefined;`:
```ts
  if (kind === "cancelByCloid") {
    const p = params as { cancels: { asset: number; cloid: string }[] };
    return { type: "cancelByCloid", cancels: p.cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })) };
  }
```

(d) In `makeShadowVerifier`, add a `timeoutMs` local next to the existing `nonce`/`f`/`log` (just after `const nonce = opts.nonce ?? SHADOW_NONCE;`):
```ts
  const timeoutMs = opts.timeoutMs ?? 2000;
```

(e) Replace the returned verifier function body so the fetch is wrapped in an AbortController timeout. Replace the entire `return (kind: string, params: unknown): void => { … };` block with:
```ts
  return (kind: string, params: unknown): void => {
    void (async () => {
      try {
        const action = actionFromKindParams(kind, params);
        if (!action) return;
        const localHash = createL1ActionHash({ action, nonce });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await f(`${opts.url}/v1/digest/l1`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, params, nonce, isTestnet: opts.isTestnet ?? false }),
            signal: controller.signal,
          });
          if (!res.ok) {
            log.warn({ kind, status: res.status }, "signer shadow http error");
            return;
          }
          const body = (await res.json()) as { actionHash?: string };
          const remoteHash = body.actionHash;
          if (!remoteHash) {
            log.warn({ kind }, "signer shadow missing actionHash");
            return;
          }
          if (remoteHash.toLowerCase() !== localHash.toLowerCase()) {
            log.warn({ kind, localHash, remoteHash }, "signer shadow mismatch");
          } else {
            log.debug({ kind }, "signer shadow match");
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        log.warn({ kind, err: String(e) }, "signer shadow error");
      }
    })();
  };
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `cd server && npx jest signerShadow`
Expected: PASS — existing 4 tests + `no warn for a matching cancelByCloid` + `aborts and swallows a hung fetch after the timeout`.
Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/signerShadow.ts server/src/agent/signerShadow.test.ts
git commit --no-verify -m "feat(server): signerShadow fetch timeout + cancelByCloid mapping

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `restingExecutor` 接线 + `index.ts` 装配

**Files:**
- Modify: `server/src/agent/restingExecutor.ts`
- Modify: `server/src/agent/restingExecutor.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write the failing tests**

在 `server/src/agent/restingExecutor.test.ts` 中，把 `deps` 工厂改为可选接受 `shadowVerify`（保持既有调用 `deps(client)` 兼容）：
```ts
function deps(client: RestingClientLike | undefined, shadowVerify?: (kind: string, params: unknown) => void) {
  return { clientFor: () => client, resolveAsset: async () => ({ assetIndex: 3, szDecimals: 2 }), shadowVerify };
}
```
然后追加一个新 `describe`（放在文件末尾）：
```ts
describe("makeRestingExecutor shadow verify", () => {
  it("shadow-verifies the ALO order, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => restingRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    const r = await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.357, side: "buy", reduceOnly: false, cloid: "0xc" });
    expect(r).toEqual({ ok: true, oid: 999 });
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("order");
    expect(params).toMatchObject({ asset: 3, isBuy: true, tif: "Alo", grouping: "na", cloid: "0xc" });
  });

  it("shadow-verifies cancelByCloid, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: RestingClientLike = { order: async () => ({}), cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    const ok = await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" });
    expect(ok).toBe(true);
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("cancelByCloid");
    expect(params).toEqual({ cancels: [{ asset: 3, cloid: "0xc" }] });
  });

  it("a throwing shadowVerify does not affect placeLimit/cancelCloid", async () => {
    const shadow = jest.fn(() => {
      throw new Error("boom");
    });
    const client: RestingClientLike = { order: async () => restingRes, cancelByCloid: async () => ({}) };
    const exec = makeRestingExecutor(deps(client, shadow));
    expect(await exec.placeLimit({ owner: "0xo", coin: "BTC", price: 140, sizeCoin: 0.5, side: "buy", reduceOnly: false, cloid: "0xc" })).toEqual({ ok: true, oid: 999 });
    expect(await exec.cancelCloid({ owner: "0xo", coin: "BTC", cloid: "0xc" })).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest restingExecutor`
Expected: FAIL — `shadowVerify` not on `RestingExecutorDeps` (type error) / never called.

- [ ] **Step 3: Add optional shadowVerify + call sites in restingExecutor.ts**

In `server/src/agent/restingExecutor.ts`, in the `RestingExecutorDeps` interface, after `resolveAsset(coin: string): Promise<{ assetIndex: number; szDecimals: number }>;`, add:
```ts
  /** Optional fire-and-forget shadow verifier (compares Go signer digest); never affects execution. */
  shadowVerify?: (kind: string, params: unknown) => void;
```

In `placeLimit`, AFTER `const order = { … };` and BEFORE `const res = await client.order({ orders: [order], grouping: "na" });`, insert:
```ts
        try {
          deps.shadowVerify?.("order", {
            asset: assetIndex,
            isBuy: req.side === "buy",
            px: order.p,
            sz: order.s,
            reduceOnly: order.r,
            tif: "Alo",
            grouping: "na",
            cloid: order.c,
          });
        } catch {
          /* shadow must never affect placement */
        }
```

In `cancelCloid`, AFTER `const { assetIndex } = await deps.resolveAsset(req.coin);` and BEFORE `await client.cancelByCloid({ cancels: [{ asset: assetIndex, cloid: req.cloid }] });`, insert:
```ts
        try {
          deps.shadowVerify?.("cancelByCloid", { cancels: [{ asset: assetIndex, cloid: req.cloid }] });
        } catch {
          /* shadow must never affect cancellation */
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest restingExecutor`
Expected: PASS (existing restingExecutor tests + 3 new shadow tests).

- [ ] **Step 5: Wire index.ts**

In `server/src/index.ts`, change:
```ts
  const restingExec = makeRestingExecutor({ clientFor, resolveAsset: resolvers.resolveAsset });
```
to:
```ts
  const restingExec = makeRestingExecutor({ clientFor, resolveAsset: resolvers.resolveAsset, shadowVerify });
```
(`shadowVerify` is already declared earlier in `index.ts` from `SIGNER_SHADOW_URL`; when unset it is `undefined` → no-op.)

- [ ] **Step 6: Full server gates + commit**

Run: `cd server && npx tsc --noEmit && npx jest 2>&1 | tail -6`
Expected: tsc clean; full suite green (≥ 220 baseline; should be ~225 after the 5 new tests across both test files).
```bash
git add server/src/agent/restingExecutor.ts server/src/agent/restingExecutor.test.ts server/src/index.ts
git commit --no-verify -m "feat(server): wire shadow verify into restingExecutor (ALO order + cancelByCloid)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd server && npx tsc --noEmit && npx jest` 全绿（≥ 既有基线）。
- `git diff --stat main...HEAD` —— 仅触及：`server/src/agent/{signerShadow.ts,signerShadow.test.ts,restingExecutor.ts,restingExecutor.test.ts}`、`server/src/index.ts`、以及两份 docs。无 Go/mobile 改动。
