# M5 签名器落地第一步：cmd/signer digest 服务 + TS 影子校验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 站起一个不持钥的 Go `cmd/signer` digest HTTP 服务（复用 `internal/hl`），并在 TS `server/` 下单旁路加一个默认关闭、fire-and-forget、吞异常的影子校验，用固定 nonce 逐字节比对 Go 与 `@nktkas` 的 L1 actionHash。

**Architecture:** 纯增量、零风险。Go 侧把 golden 测试的 action 重建 switch 抽成生产函数 `ActionFromKind` + 纯函数 `DigestL1`，包一层 `net/http` 服务；TS 侧新增 `signerShadow` 模块，经 placer 的**可选注入依赖** `shadowVerify?`（默认 undefined）接入，仅当 `SIGNER_SHADOW_URL` 配置时启用。永不阻塞、永不改变真实下单。

**Tech Stack:** Go（`backend/internal/hl` + `backend/cmd/signer`，标准库 `net/http`）；TS（`server/`，`@nktkas/hyperliquid/signing` `createL1ActionHash`，jest）。

---

## File Structure

- `backend/internal/hl/digest.go`（新）—— `ActionFromKind(kind, params) (Map, error)` + `DigestL1(kind, params, nonce, isTestnet) (actionHash, agentDigest [32]byte, error)`。
- `backend/internal/hl/digest_test.go`（新）—— ActionFromKind/DigestL1 单测（复用 golden.json）。
- `backend/internal/hl/golden_test.go`（改）—— `actionForVector` 改调 `ActionFromKind`。
- `backend/cmd/signer/main.go`（新）—— HTTP 服务：`newMux()` + `main()`。
- `backend/cmd/signer/main_test.go`（新）—— httptest 断言 handler。
- `server/src/agent/signerShadow.ts`（新）—— `makeShadowVerifier(opts)`。
- `server/src/agent/signerShadow.test.ts`（新）—— mock fetch 三态。
- `server/src/agent/placer.ts`（改）—— `PlacerDeps.shadowVerify?` + 调用点。
- `server/src/agent/placer.test.ts`（改）—— 注入 spy 断言。
- `server/src/index.ts`（改）—— `SIGNER_SHADOW_URL` env 装配。

## 现有约定（供无上下文的实现者参考）

- Go：`Map` 是有序 `[]KV`。`L1ActionHash(action Map, nonce uint64, vaultAddress []byte, expiresAfter *uint64) ([32]byte, error)`；`AgentDigest(conn [32]byte, isTestnet bool) [32]byte`。既有 `Build*Action` 见 `action.go`。`golden_test.go` 的 `actionForVector(t, v)` 目前内联一个 10-kind switch，从 `v.Params`（json.RawMessage）重建 action，用 `mustJSON(t, raw, dst)`。`goldenVector{Kind, Params, Nonce uint64, IsTestnet bool, ActionHash, AgentDigest string, ...}`，`loadGolden(t) []goldenVector` 读 `testdata/golden.json`。
- Go module：`github.com/lumos-forge/hypersolid/backend`，go 1.26。`go test ./...`、`go vet ./...`、`go build ./cmd/signer`。
- TS server：日志用 `console.*`（无 pino）。`@nktkas/hyperliquid/signing` 导出 `createL1ActionHash({ action, nonce }) => "0x…"`（hex 字符串）。`placer.ts` 的 `makeHlPlacer(deps: PlacerDeps)` 构造 order tuple `{a,b,p,s,r,t:{limit:{tif:"Ioc"}},c}` 后 `await client.order({orders:[order], grouping:"na"})`。`index.ts` 在 `makeHlPlacer({ clientFor, ...resolvers, slippageBps })`（约 line 72）装配。`placer.test.ts` 用 `deps(orderSpy, price, fill, over)` 工厂。
- 验证：Go `cd backend && go test ./... && go vet ./...`；Server `cd server && npm run typecheck && npm test`。
- 提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: Go — 抽出 `ActionFromKind` + `DigestL1`

**Files:**
- Create: `backend/internal/hl/digest.go`
- Create: `backend/internal/hl/digest_test.go`
- Modify: `backend/internal/hl/golden_test.go`

- [ ] **Step 1: Write the failing tests**

创建 `backend/internal/hl/digest_test.go`：

```go
package hl

import (
	"encoding/hex"
	"testing"
)

func TestActionFromKindUnknown(t *testing.T) {
	if _, err := ActionFromKind("nope", []byte(`{}`)); err == nil {
		t.Fatal("expected error for unknown kind")
	}
	if _, err := ActionFromKind("order", []byte(`{not json`)); err == nil {
		t.Fatal("expected error for bad JSON")
	}
}

func TestDigestL1MatchesGolden(t *testing.T) {
	for _, v := range loadGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			ah, ad, err := DigestL1(v.Kind, v.Params, v.Nonce, v.IsTestnet)
			if err != nil {
				t.Fatalf("DigestL1: %v", err)
			}
			if "0x"+hex.EncodeToString(ah[:]) != v.ActionHash {
				t.Fatalf("actionHash = 0x%s, want %s", hex.EncodeToString(ah[:]), v.ActionHash)
			}
			if "0x"+hex.EncodeToString(ad[:]) != v.AgentDigest {
				t.Fatalf("agentDigest = 0x%s, want %s", hex.EncodeToString(ad[:]), v.AgentDigest)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/hl/ -run 'TestActionFromKind|TestDigestL1'`
Expected: FAIL — `undefined: ActionFromKind` / `undefined: DigestL1`（编译错误）。

- [ ] **Step 3: Create digest.go with the extracted switch + DigestL1**

创建 `backend/internal/hl/digest.go`（把 `actionForVector` 的 10-kind switch 平移为生产函数，`mustJSON` 换成返回 error 的 `json.Unmarshal`）：

```go
package hl

import (
	"encoding/json"
	"fmt"
)

// ActionFromKind rebuilds the ordered msgpack action Map from a semantic kind + JSON params.
// It is the single source of truth shared by the golden tests and the signer service.
func ActionFromKind(kind string, params json.RawMessage) (Map, error) {
	switch kind {
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
	case "cancel":
		var p struct {
			Cancels []struct {
				Asset int64 `json:"asset"`
				Oid   int64 `json:"oid"`
			} `json:"cancels"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		ins := make([]CancelInput, len(p.Cancels))
		for i, c := range p.Cancels {
			ins[i] = CancelInput{Asset: c.Asset, Oid: c.Oid}
		}
		return BuildCancelAction(ins), nil
	case "twapOrder":
		var p struct {
			Asset      int64  `json:"asset"`
			IsBuy      bool   `json:"isBuy"`
			Sz         string `json:"sz"`
			ReduceOnly bool   `json:"reduceOnly"`
			Minutes    int64  `json:"minutes"`
			Randomize  bool   `json:"randomize"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildTwapOrderAction(p.Asset, p.IsBuy, p.Sz, p.ReduceOnly, p.Minutes, p.Randomize), nil
	case "twapCancel":
		var p struct {
			Asset  int64 `json:"asset"`
			TwapID int64 `json:"twapId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildTwapCancelAction(p.Asset, p.TwapID), nil
	case "cancelByCloid":
		var p struct {
			Cancels []struct {
				Asset int64  `json:"asset"`
				Cloid string `json:"cloid"`
			} `json:"cancels"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		ins := make([]CancelByCloidInput, len(p.Cancels))
		for i, c := range p.Cancels {
			ins[i] = CancelByCloidInput{Asset: c.Asset, Cloid: c.Cloid}
		}
		return BuildCancelByCloidAction(ins), nil
	case "modify":
		var p struct {
			OidNum   int64  `json:"oidNum"`
			OidCloid string `json:"oidCloid"`
			Order    struct {
				Asset      int64  `json:"asset"`
				IsBuy      bool   `json:"isBuy"`
				Px         string `json:"px"`
				Sz         string `json:"sz"`
				ReduceOnly bool   `json:"reduceOnly"`
				Tif        string `json:"tif"`
				Cloid      string `json:"cloid"`
			} `json:"order"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildModifyAction(ModifyInput{
			Oid:   p.OidNum,
			Cloid: p.OidCloid,
			Order: OrderInput{Asset: p.Order.Asset, IsBuy: p.Order.IsBuy, Px: p.Order.Px, Sz: p.Order.Sz, ReduceOnly: p.Order.ReduceOnly, Tif: p.Order.Tif, Cloid: p.Order.Cloid},
		}), nil
	case "updateLeverage":
		var p struct {
			Asset    int64 `json:"asset"`
			IsCross  bool  `json:"isCross"`
			Leverage int64 `json:"leverage"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildUpdateLeverageAction(p.Asset, p.IsCross, p.Leverage), nil
	case "batchModify":
		var p struct {
			Modifies []struct {
				OidNum   int64  `json:"oidNum"`
				OidCloid string `json:"oidCloid"`
				Order    struct {
					Asset      int64  `json:"asset"`
					IsBuy      bool   `json:"isBuy"`
					Px         string `json:"px"`
					Sz         string `json:"sz"`
					ReduceOnly bool   `json:"reduceOnly"`
					Tif        string `json:"tif"`
					Cloid      string `json:"cloid"`
				} `json:"order"`
			} `json:"modifies"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		mods := make([]ModifyInput, len(p.Modifies))
		for i, m := range p.Modifies {
			mods[i] = ModifyInput{
				Oid:   m.OidNum,
				Cloid: m.OidCloid,
				Order: OrderInput{Asset: m.Order.Asset, IsBuy: m.Order.IsBuy, Px: m.Order.Px, Sz: m.Order.Sz, ReduceOnly: m.Order.ReduceOnly, Tif: m.Order.Tif, Cloid: m.Order.Cloid},
			}
		}
		return BuildBatchModifyAction(mods), nil
	case "updateIsolatedMargin":
		var p struct {
			Asset int64 `json:"asset"`
			IsBuy bool  `json:"isBuy"`
			Ntli  int64 `json:"ntli"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildUpdateIsolatedMarginAction(p.Asset, p.IsBuy, p.Ntli), nil
	case "scheduleCancel":
		var p struct {
			Time *int64 `json:"time"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildScheduleCancelAction(p.Time), nil
	}
	return nil, fmt.Errorf("unknown kind %q", kind)
}

// DigestL1 rebuilds the action and returns the L1 action hash + phantom-agent EIP-712 digest.
func DigestL1(kind string, params json.RawMessage, nonce uint64, isTestnet bool) (actionHash, agentDigest [32]byte, err error) {
	action, err := ActionFromKind(kind, params)
	if err != nil {
		return [32]byte{}, [32]byte{}, err
	}
	ah, err := L1ActionHash(action, nonce, nil, nil)
	if err != nil {
		return [32]byte{}, [32]byte{}, err
	}
	return ah, AgentDigest(ah, isTestnet), nil
}
```

- [ ] **Step 4: Refactor golden_test.go to reuse ActionFromKind**

在 `backend/internal/hl/golden_test.go` 中，把整个 `actionForVector` 函数体（从 `switch v.Kind {` 到结尾 `t.Fatalf("unknown kind %q", v.Kind); return nil`）替换为：

```go
func actionForVector(t *testing.T, v goldenVector) Map {
	t.Helper()
	a, err := ActionFromKind(v.Kind, v.Params)
	if err != nil {
		t.Fatalf("actionForVector(%q): %v", v.Kind, err)
	}
	return a
}
```

若 `mustJSON` 在删除后变为未使用（其它测试仍用它则保留）：先运行 Step 5，若报 `mustJSON declared and not used` 再删除 `mustJSON` 定义。（注：`golden_usersigned_test.go` 等仍可能用到，通常保留。）

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/hl/`
Expected: PASS —— 既有全部 golden 测试（现经 `ActionFromKind`）+ 新 `TestActionFromKindUnknown` + `TestDigestL1MatchesGolden`（对每条 golden 向量逐字节相等）。
若报 `mustJSON` 未使用，按 Step 4 说明处理后重跑。

- [ ] **Step 6: Commit**

```bash
git add backend/internal/hl/digest.go backend/internal/hl/digest_test.go backend/internal/hl/golden_test.go
git commit --no-verify -m "feat(backend): ActionFromKind + DigestL1 (shared by golden tests + signer)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Go — `cmd/signer` HTTP digest 服务

**Files:**
- Create: `backend/cmd/signer/main.go`
- Create: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Write the failing test**

创建 `backend/cmd/signer/main_test.go`：

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(newMux())
	defer srv.Close()
	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
}

func TestDigestL1Endpoint(t *testing.T) {
	srv := httptest.NewServer(newMux())
	defer srv.Close()
	body := `{"kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1700000000000,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/digest/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		ActionHash  string `json:"actionHash"`
		AgentDigest string `json:"agentDigest"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.HasPrefix(out.ActionHash, "0x") || len(out.ActionHash) != 66 {
		t.Fatalf("bad actionHash %q", out.ActionHash)
	}
	if !strings.HasPrefix(out.AgentDigest, "0x") || len(out.AgentDigest) != 66 {
		t.Fatalf("bad agentDigest %q", out.AgentDigest)
	}
}

func TestDigestL1BadRequests(t *testing.T) {
	srv := httptest.NewServer(newMux())
	defer srv.Close()
	// unknown kind
	r1, _ := http.Post(srv.URL+"/v1/digest/l1", "application/json", strings.NewReader(`{"kind":"nope","params":{},"nonce":1,"isTestnet":false}`))
	defer r1.Body.Close()
	if r1.StatusCode != 400 {
		t.Fatalf("unknown kind status = %d, want 400", r1.StatusCode)
	}
	// malformed JSON
	r2, _ := http.Post(srv.URL+"/v1/digest/l1", "application/json", strings.NewReader(`{not json`))
	defer r2.Body.Close()
	if r2.StatusCode != 400 {
		t.Fatalf("bad json status = %d, want 400", r2.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./cmd/signer/`
Expected: FAIL — `undefined: newMux`（编译错误）。

- [ ] **Step 3: Create cmd/signer/main.go**

创建 `backend/cmd/signer/main.go`：

```go
// Command signer is the M5 signing service (phase 1: keyless digest endpoints).
// It does NOT hold keys, sign, or persist anything; it only reproduces HL action
// hashes/digests for cross-language shadow verification.
package main

import (
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
)

type digestL1Request struct {
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Nonce     uint64          `json:"nonce"`
	IsTestnet bool            `json:"isTestnet"`
}

type digestL1Response struct {
	ActionHash  string `json:"actionHash"`
	AgentDigest string `json:"agentDigest"`
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func handleDigestL1(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req digestL1Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	ah, ad, err := hl.DigestL1(req.Kind, req.Params, req.Nonce, req.IsTestnet)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(digestL1Response{
		ActionHash:  "0x" + hex.EncodeToString(ah[:]),
		AgentDigest: "0x" + hex.EncodeToString(ad[:]),
	})
}

// newMux builds the service router (no side effects; testable).
func newMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	return mux
}

func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	log.Printf("signer digest service listening on %s", addr)
	if err := http.ListenAndServe(addr, newMux()); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 4: Run tests + build to verify pass**

Run: `cd backend && go test ./cmd/signer/ && go build ./cmd/signer`
Expected: PASS（三个测试通过）；`go build` 成功（生成二进制，随后可 `rm -f signer`）。

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): cmd/signer keyless L1 digest HTTP service

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: TS — `signerShadow` 模块

**Files:**
- Create: `server/src/agent/signerShadow.ts`
- Test: `server/src/agent/signerShadow.test.ts`

- [ ] **Step 1: Write the failing test**

创建 `server/src/agent/signerShadow.test.ts`：

```ts
import { makeShadowVerifier, SHADOW_NONCE } from "./signerShadow";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";

const orderParams = { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0x00000000000000000000000000000001" };

function expectedLocalHash(): string {
  const o: Record<string, unknown> = { a: 0, b: true, p: "50000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: "0x00000000000000000000000000000001" };
  return createL1ActionHash({ action: { type: "order", orders: [o], grouping: "na" }, nonce: SHADOW_NONCE });
}

const flush = () => new Promise((r) => setImmediate(r));

function fetchReturning(hash: string, ok = true, status = 200) {
  return jest.fn(async () => ({ ok, status, json: async () => ({ actionHash: hash }) }));
}

describe("makeShadowVerifier", () => {
  it("no warn when hashes match", async () => {
    const warn = jest.fn();
    const f = fetchReturning(expectedLocalHash());
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    verify("order", orderParams);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on mismatch", async () => {
    const warn = jest.fn();
    const f = fetchReturning("0xdeadbeef");
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    verify("order", orderParams);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("swallows fetch rejection", async () => {
    const warn = jest.fn();
    const f = jest.fn(async () => { throw new Error("network"); });
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    expect(() => verify("order", orderParams)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no-op for unsupported kind (no fetch)", async () => {
    const f = fetchReturning("0x00");
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never });
    verify("updateLeverage", { asset: 0, isCross: true, leverage: 5 });
    await flush();
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest signerShadow`
Expected: FAIL — cannot find module `./signerShadow`.

- [ ] **Step 3: Implement signerShadow.ts**

创建 `server/src/agent/signerShadow.ts`：

```ts
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";

/** Fixed nonce for shadow comparison — the hash is nonce-dependent but nonce-arbitrary for encoding checks. */
export const SHADOW_NONCE = 1;

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ShadowLogger {
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface ShadowOpts {
  url: string;
  isTestnet?: boolean;
  nonce?: number;
  fetchImpl?: FetchLike;
  logger?: ShadowLogger;
}

/** Build the raw HL action object from a semantic kind + params (only `order` is mapped for now). */
function actionFromKindParams(kind: string, params: unknown): Record<string, unknown> | undefined {
  if (kind === "order") {
    const p = params as {
      asset: number; isBuy: boolean; px: string; sz: string; reduceOnly: boolean; tif: string; grouping?: string; cloid?: string;
    };
    const o: Record<string, unknown> = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly, t: { limit: { tif: p.tif } } };
    if (p.cloid) o.c = p.cloid;
    return { type: "order", orders: [o], grouping: p.grouping ?? "na" };
  }
  return undefined;
}

/**
 * Build a fire-and-forget shadow verifier: for each supported action it compares the local
 * @nktkas L1 actionHash (fixed nonce) against the Go signer's, logging a warning on mismatch.
 * Every error (unsupported kind, network, non-200, bad body) is swallowed — it never throws
 * into the caller and never affects order placement.
 */
export function makeShadowVerifier(opts: ShadowOpts): (kind: string, params: unknown) => void {
  const nonce = opts.nonce ?? SHADOW_NONCE;
  const f: FetchLike = opts.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const log: ShadowLogger = opts.logger ?? {
    warn: (o, m) => console.warn(m ?? "signer shadow", o),
    debug: () => undefined,
  };
  return (kind: string, params: unknown): void => {
    void (async () => {
      try {
        const action = actionFromKindParams(kind, params);
        if (!action) return;
        const localHash = createL1ActionHash({ action, nonce });
        const res = await f(`${opts.url}/v1/digest/l1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, params, nonce, isTestnet: opts.isTestnet ?? false }),
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
      } catch (e) {
        log.warn({ kind, err: String(e) }, "signer shadow error");
      }
    })();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest signerShadow`
Expected: PASS（4 个测试）。
再跑类型检查：`cd server && npx tsc --noEmit` → 无错误。

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/signerShadow.ts server/src/agent/signerShadow.test.ts
git commit --no-verify -m "feat(server): signerShadow fire-and-forget L1 digest verifier

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: TS — placer 接线 + index 装配

**Files:**
- Modify: `server/src/agent/placer.ts`
- Modify: `server/src/agent/placer.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write the failing test**

在 `server/src/agent/placer.test.ts` 末尾（`describe` 内）追加：

```ts
  it("calls shadowVerify with the order params, fire-and-forget", async () => {
    const shadow = jest.fn();
    const placer = makeHlPlacer(deps(() => undefined, 100, filled, { shadowVerify: shadow }));
    const res = await placer.place({ owner: "0xo", coin: "BTC", cloid: "0xc", side: "buy", reduceOnly: false, sizeUsdc: 200 });
    expect(res.ok).toBe(true);
    expect(shadow).toHaveBeenCalledTimes(1);
    const [kind, params] = shadow.mock.calls[0];
    expect(kind).toBe("order");
    expect(params).toMatchObject({ asset: 3, isBuy: true, reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0xc" });
  });

  it("a throwing shadowVerify does not affect placement", async () => {
    const shadow = jest.fn(() => { throw new Error("boom"); });
    const placer = makeHlPlacer(deps(() => undefined, 100, filled, { shadowVerify: shadow }));
    const res = await placer.place({ owner: "0xo", coin: "BTC", cloid: "0xc", side: "buy", reduceOnly: false, sizeUsdc: 200 });
    expect(res.ok).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest placer`
Expected: FAIL —— `shadowVerify` 不在 `PlacerDeps` 上（类型错误）/ 未被调用。

- [ ] **Step 3: Add optional shadowVerify to PlacerDeps + call site**

在 `server/src/agent/placer.ts` 的 `PlacerDeps` 接口中，`slippageBps: number;` 之后追加：

```ts
  /** Optional fire-and-forget shadow verifier (compares Go signer digest); never affects placement. */
  shadowVerify?: (kind: string, params: unknown) => void;
```

在 `place` 方法内，构造完 `order` 之后、`const res = await client.order(...)` 之前，插入（用 try/catch 包裹，确保即便 shadowVerify 同步抛错也不影响下单）：

```ts
        try {
          deps.shadowVerify?.("order", {
            asset: assetIndex,
            isBuy: buy,
            px: order.p,
            sz: order.s,
            reduceOnly: order.r,
            tif: "Ioc",
            grouping: "na",
            cloid: order.c,
          });
        } catch {
          /* shadow must never affect placement */
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest placer`
Expected: PASS（既有 placer 测试 + 两个新测试）。

- [ ] **Step 5: Wire index.ts**

在 `server/src/index.ts` 顶部 import 区，加：

```ts
import { makeShadowVerifier } from "./agent/signerShadow";
```

在 `const placer = makeHlPlacer({` 之前，插入：

```ts
  const signerShadowUrl = process.env.SIGNER_SHADOW_URL;
  const shadowVerify = signerShadowUrl
    ? makeShadowVerifier({ url: signerShadowUrl, isTestnet })
    : undefined;
```

把 `makeHlPlacer({ clientFor, ...resolvers, slippageBps })` 改为：

```ts
  const placer = makeHlPlacer({
    clientFor,
    ...resolvers,
    slippageBps,
    shadowVerify,
  });
```

- [ ] **Step 6: Full server gates + commit**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: PASS（typecheck 干净；全部测试 ≥ 既有基线）。

```bash
git add server/src/agent/placer.ts server/src/agent/placer.test.ts server/src/index.ts
git commit --no-verify -m "feat(server): wire optional signer shadow verify into placer (SIGNER_SHADOW_URL)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- Go：`cd backend && go test ./... && go vet ./...` 全绿；`go build ./cmd/signer` 成功（构建后 `rm -f signer` 清理二进制）。
- Server：`cd server && npm run typecheck && npm test` 全绿（≥ 既有基线）。
- 端到端 smoke（可选人工）：`SIGNER_ADDR=127.0.0.1:8087 go run ./cmd/signer &` → `curl -s localhost:8087/healthz` 返回 `{"status":"ok"}` → `curl -s -XPOST localhost:8087/v1/digest/l1 -d '{"kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1700000000000,"isTestnet":false}'` 返回 actionHash/agentDigest；用完 `kill` 掉进程。
- `git diff --stat main...HEAD` —— 仅触及：`backend/internal/hl/{digest.go,digest_test.go,golden_test.go}`、`backend/cmd/signer/{main.go,main_test.go}`、`server/src/agent/{signerShadow.ts,signerShadow.test.ts,placer.ts,placer.test.ts}`、`server/src/index.ts`、以及两份 docs。
