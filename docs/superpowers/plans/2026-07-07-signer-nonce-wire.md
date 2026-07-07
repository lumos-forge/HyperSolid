# nonce 接入 `/v1/sign/l1` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/v1/sign/l1` 成为 nonce 单写者（模型 A）：请求去掉 `nonce`，签名端用 `nonce.Allocator.Next(keyId)` 生成、签名、并在响应返回 `nonce`。

**Architecture:** 注入 `*nonce.Allocator` 到 `newMux`/`handleSignL1`；nonce 在 policy 与 ActionFromKind 都通过后才 `Next`（被拒/坏参不消耗）。`main()` 用真实时钟；测试注入固定时钟保持 golden 逐字节可断言。digest 端点不变。

**Tech Stack:** Go（`backend/cmd/signer`，标准库 `net/http`；依赖 `internal/nonce`）。

---

## File Structure

- `backend/cmd/signer/main.go`（改）—— import nonce；`signL1Request` 删 Nonce；`signL1Response` 加 Nonce；`handleSignL1(ks, policies, nonces)` 生成 nonce；`newMux(ks, policies, nonces)`；`main()` 建 allocator。
- `backend/cmd/signer/main_test.go`（改）—— import nonce；所有 `newMux` 调用加第三参；`TestSignL1Endpoint` 改注入固定时钟 + 断言响应 nonce；新增单调 nonce 用例。

## 现有约定（供无上下文的实现者参考）

- `cmd/signer/main.go`（PR #24）：`signL1Request{KeyID, Kind string; Params json.RawMessage; Nonce uint64; IsTestnet bool}`；`signL1Response{R, S string; V int}`；`handleSignL1(ks *keystore.Keystore, policies *policy.Store)`（404 → 403 → `hl.ActionFromKind` 400 → `signer.SignL1Action(action, req.Nonce, req.IsTestnet)` 500 → 200 `{r,s,v}`）；`newMux(ks, policies)`；`main()` 建空 keystore+policy。import 含 encoding/hex, encoding/json, log, math, net/http, os, strconv, hl, keystore, policy。
- `internal/nonce`（PR #25，包 `nonce`）：`New(nowMs func() int64) *Allocator`（nil→真实时钟）；`(*Allocator).Next(keyID string) uint64`（每 key 严格递增 ms nonce）。
- `cmd/signer/main_test.go`（PR #24）：`goldenSig{R,S string; V int}`（json r/s/v）；`loadFirstGolden(t)` 第一条向量 `order-limit-gtc-mainnet`（`v.Nonce`=1700000000000、`v.Kind`="order"、`v.PrivKey`、`v.Sig`）。当前 `newMux(...)` 调用点（均两参）：TestHealthz、TestDigestL1Endpoint、TestDigestL1BadRequests、TestSignL1Endpoint、TestSignL1UnknownKey、TestSignL1BadKind、TestSignL1DeniedWithoutPolicy、TestSignL1OverNotionalCap、TestSignL1BadParamsAfterPolicy、TestSignL1ModifyOverNotionalCap、TestSignL1BatchModifyOverNotionalCap、TestSignL1BatchModifyNegativeLegMasking、TestSignL1OrderNegativePriceRejected。
- Go module `github.com/lumos-forge/hypersolid/backend`。验证 `go test ./...`、`go vet ./...`、`go build ./cmd/signer`、`go test -race ./cmd/signer/`。
- 提交 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: nonce 接入签名端点

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Update tests (fail first)**

在 `backend/cmd/signer/main_test.go` 中：

(a) 在 import 块加入 nonce 包（与 keystore/policy 同组）：
```go
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/nonce"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
```

(b) 给**除 `TestSignL1Endpoint` 外**的每一处 `newMux(...)` 调用追加第三参 `nonce.New(nil)`。即把每个 `newMux(A, B)` 改成 `newMux(A, B, nonce.New(nil))`。涉及：TestHealthz、TestDigestL1Endpoint、TestDigestL1BadRequests、TestSignL1UnknownKey、TestSignL1BadKind、TestSignL1DeniedWithoutPolicy、TestSignL1OverNotionalCap、TestSignL1BadParamsAfterPolicy、TestSignL1ModifyOverNotionalCap、TestSignL1BatchModifyOverNotionalCap、TestSignL1BatchModifyNegativeLegMasking、TestSignL1OrderNegativePriceRejected。（这些用例的请求体里可能仍含 `"nonce":1`，`signL1Request` 删除该字段后被 json 解码忽略，无害。）

(c) 把整个 `TestSignL1Endpoint` 函数替换为（注入固定时钟 allocator，请求去掉 nonce，断言响应 nonce）：
```go
func TestSignL1Endpoint(t *testing.T) {
	v := loadFirstGolden(t)
	key, err := hex.DecodeString(v.PrivKey[2:])
	if err != nil {
		t.Fatalf("decode key: %v", err)
	}
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", key); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{v.Kind: true}, MaxNotionalUsdc: 1e12})
	// Fixed clock = the golden nonce, so Next("k1") returns v.Nonce and the
	// produced signature matches the golden vector byte-for-byte.
	nonces := nonce.New(func() int64 { return int64(v.Nonce) })
	srv := httptest.NewServer(newMux(ks, policies, nonces))
	defer srv.Close()
	body, _ := json.Marshal(struct {
		KeyID     string          `json:"keyId"`
		Kind      string          `json:"kind"`
		Params    json.RawMessage `json:"params"`
		IsTestnet bool            `json:"isTestnet"`
	}{"k1", v.Kind, v.Params, v.IsTestnet})
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		R     string `json:"r"`
		S     string `json:"s"`
		V     int    `json:"v"`
		Nonce uint64 `json:"nonce"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.R != v.Sig.R || out.S != v.Sig.S || out.V != v.Sig.V {
		t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", out.R, out.S, out.V, v.Sig.R, v.Sig.S, v.Sig.V)
	}
	if out.Nonce != v.Nonce {
		t.Fatalf("nonce = %d, want %d (server-generated)", out.Nonce, v.Nonce)
	}
}
```

(d) 追加单调 nonce 用例：
```go
func TestSignL1GeneratesMonotonicNonce(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	nonces := nonce.New(func() int64 { return 1700000000000 })
	srv := httptest.NewServer(newMux(ks, policies, nonces))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	sign := func() uint64 {
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("status = %d, want 200", res.StatusCode)
		}
		var out struct {
			Nonce uint64 `json:"nonce"`
		}
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out.Nonce
	}
	n1 := sign()
	n2 := sign()
	if n1 != 1700000000000 {
		t.Fatalf("n1 = %d, want 1700000000000", n1)
	}
	if n2 != n1+1 {
		t.Fatalf("n2 = %d, want %d (strictly increasing, server single-writer)", n2, n1+1)
	}
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && go test ./cmd/signer/`
Expected: FAIL — `newMux` still takes two args (compile error from the three-arg calls); `signL1Response` has no `nonce`; `signL1Request` still has `Nonce`.

- [ ] **Step 3: Update main.go**

(a) Add the nonce import (with the other internal packages):
```go
	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/nonce"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
```

(b) Remove the `Nonce` field from `signL1Request`:
```go
type signL1Request struct {
	KeyID     string          `json:"keyId"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	IsTestnet bool            `json:"isTestnet"`
}
```

(c) Add a `Nonce` field to `signL1Response`:
```go
type signL1Response struct {
	R     string `json:"r"`
	S     string `json:"s"`
	V     int    `json:"v"`
	Nonce uint64 `json:"nonce"`
}
```

(d) Replace the ENTIRE `handleSignL1` function with (adds the `nonces` param; generates the nonce after ActionFromKind; returns it):
```go
// handleSignL1 signs an L1 action with the keystore signer named by keyId, after
// the reject-first policy passes. The server is the nonce single-writer: it
// allocates a strictly-increasing nonce per key and returns it. Fail-closed:
// an unknown keyId returns 404. Never logs key material.
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, nonces *nonce.Allocator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req signL1Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
			return
		}
		signer, ok := ks.Signer(req.KeyID)
		if !ok {
			writeErr(w, http.StatusNotFound, "unknown keyId")
			return
		}
		if d := policy.Evaluate(intentFor(req.Kind, req.Params), policies.Get(req.KeyID)); !d.Allow {
			writeErr(w, http.StatusForbidden, d.Reason)
			return
		}
		action, err := hl.ActionFromKind(req.Kind, req.Params)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		n := nonces.Next(req.KeyID)
		sig, err := signer.SignL1Action(action, n, req.IsTestnet)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "sign failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(signL1Response{
			R:     "0x" + hex.EncodeToString(sig.R[:]),
			S:     "0x" + hex.EncodeToString(sig.S[:]),
			V:     int(sig.V),
			Nonce: n,
		})
	}
}
```

(e) Replace the ENTIRE `newMux` function with (adds the `nonces` param):
```go
func newMux(ks *keystore.Keystore, policies *policy.Store, nonces *nonce.Allocator) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, nonces))
	return mux
}
```

(f) Replace the ENTIRE `main` function with (builds the allocator):
```go
func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	ks := keystore.New()
	policies := policy.NewStore()
	nonces := nonce.New(nil)
	log.Printf("signer service listening on %s (empty keystore + policy; fail-closed)", addr)
	if err := http.ListenAndServe(addr, newMux(ks, policies, nonces)); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 4: Run tests + build + vet + race**

Run: `cd backend && go test ./cmd/signer/`
Expected: PASS — all tests: TestSignL1Endpoint (200, {r,s,v}==golden, nonce==v.Nonce via the fixed clock), TestSignL1GeneratesMonotonicNonce (n1=1700000000000, n2=n1+1), plus the 404/403/400 tests (now three-arg newMux; they don't reach nonce generation).
Run: `cd backend && go build ./cmd/signer && rm -f signer && go vet ./cmd/signer/ && go test -race ./cmd/signer/`
Expected: build succeeds (binary removed); vet clean; race clean.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): /v1/sign/l1 generates the nonce (single-writer, §5.2)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（任务完成后）

- `cd backend && go test ./... && go vet ./...` 全绿；`go build ./cmd/signer` 成功（`rm -f signer`）；`go test -race ./cmd/signer/` 通过。
- `git diff --stat main...HEAD` —— 仅触及：`backend/cmd/signer/{main.go,main_test.go}` + 两份 docs。无其它改动（`internal/nonce` 不改）。
