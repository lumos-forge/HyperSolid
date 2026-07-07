# policy 门控 `/v1/sign/l1` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `internal/policy` 接进 `cmd/signer` `/v1/sign/l1`：签名前先对每 key 的 policy 做 reject-first 评估（缺失即拒），deny → 403，越界意图不产生签名（§5.1a 落地）。

**Architecture:** 新增独立的 `policy.Store`（keyId → Config，缺失=零值 Config=default-deny），注入 `newMux(ks, policies)`；`handleSignL1` 在签名器查找后、`ActionFromKind`/签名前插入 `policy.Evaluate`；`intentFor` 从 order 的 px×sz 算名义额（坏值→NaN 触发 policy fail-closed）。keystore 保持纯。

**Tech Stack:** Go（`backend/internal/policy` + `backend/cmd/signer`，标准库 `net/http`）。

---

## File Structure

- `backend/internal/policy/store.go`（新）—— `Store`：NewStore/Set/Get（缺失=零 Config）。
- `backend/internal/policy/store_test.go`（新）—— Store 行为 + 并发。
- `backend/cmd/signer/main.go`（改）—— `newMux(ks, policies)` + `intentFor` + policy 门控 + `main()` 建空 policy store。
- `backend/cmd/signer/main_test.go`（改）—— 更新 `newMux` 签名 + policy 门控用例。

## 现有约定（供无上下文的实现者参考）

- `internal/policy`（PR #23）：`Intent{Kind, Coin string; NotionalUsdc float64}`；`Config{AllowedKinds map[string]bool; KillSwitch bool; MaxNotionalUsdc float64; PerCoinMaxUsdc map[string]float64}`；`Decision{Allow bool; Reason string}`；`Evaluate(intent, cfg) Decision`（零 Config 拒 `"kind not allowed"`；负/NaN notional 拒 `"invalid notional"`；超封顶拒 `"over notional cap"`）。
- `cmd/signer/main.go`（PR #21）：`signL1Request{KeyID,Kind,Params(json.RawMessage),Nonce,IsTestnet}`；`writeErr(w, code, msg)`；`handleSignL1(ks *keystore.Keystore) http.HandlerFunc`（method 405 / json 400 / `ks.Signer` 404 / `hl.ActionFromKind` 400 / `SignL1Action` 500 / 200 `{r,s,v}`）；`newMux(ks *keystore.Keystore)`；`main()` 建空 keystore。import 已含 encoding/hex, encoding/json, log, net/http, os, hl, keystore。
- `cmd/signer/main_test.go`（PR #21）：`TestHealthz`/`TestDigestL1Endpoint`/`TestDigestL1BadRequests` 调 `newMux(keystore.New())`；`TestSignL1Endpoint`（`loadFirstGolden` 取第一条向量 `goldenVec{Name,Kind,Params,Nonce,IsTestnet,PrivKey,Sig{R,S,V}}`，`ks.Add("k1", key)`，POST，断言 `{r,s,v}`==向量 sig）；`TestSignL1UnknownKey`（`newMux(keystore.New())`，404）；`TestSignL1BadKind`（`ks.Add("k1", bytes.Repeat([]byte{0x11},32))`，POST `kind:"nope"`，断言 400）。import 含 bytes, encoding/hex, encoding/json, net/http, net/http/httptest, os, strings, testing, keystore。第一条 golden 向量 `order-limit-gtc-mainnet`：kind "order"，px "50000"，sz "0.01"（名义额 500），isTestnet false。
- Go module `github.com/lumos-forge/hypersolid/backend`。验证 `go test ./...`、`go vet ./...`、`go build ./cmd/signer`。
- 提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: `internal/policy` Store

**Files:**
- Create: `backend/internal/policy/store.go`
- Create: `backend/internal/policy/store_test.go`

- [ ] **Step 1: Write the failing tests**

创建 `backend/internal/policy/store_test.go`：

```go
package policy

import (
	"sync"
	"testing"
)

func TestStoreSetGet(t *testing.T) {
	s := NewStore()
	cfg := Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1000}
	s.Set("k1", cfg)
	got := s.Get("k1")
	if !got.AllowedKinds["order"] || got.MaxNotionalUsdc != 1000 {
		t.Fatalf("Get returned %+v, want %+v", got, cfg)
	}
}

func TestStoreGetAbsentIsDefaultDeny(t *testing.T) {
	s := NewStore()
	got := s.Get("unknown")
	d := Evaluate(Intent{Kind: "order", NotionalUsdc: 1}, got)
	if d.Allow {
		t.Fatal("absent keyId must yield a default-deny config")
	}
	if d.Reason != "kind not allowed" {
		t.Fatalf("reason = %q, want %q", d.Reason, "kind not allowed")
	}
}

func TestStoreConcurrent(t *testing.T) {
	s := NewStore()
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			s.Set("k", Config{MaxNotionalUsdc: float64(n)})
			_ = s.Get("k")
		}(i)
	}
	wg.Wait()
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/policy/`
Expected: FAIL — `NewStore`/`Store.Set`/`Store.Get` undefined (compile error).

- [ ] **Step 3: Create store.go**

创建 `backend/internal/policy/store.go`：

```go
package policy

import "sync"

// Store is a concurrency-safe registry of per-key policy Config bound at the
// signing boundary. A keyID with no Config returns the zero-value Config, which
// Evaluate denies (default-deny / fail-closed).
type Store struct {
	mu    sync.RWMutex
	byKey map[string]Config
}

// NewStore returns an empty policy store.
func NewStore() *Store {
	return &Store{byKey: make(map[string]Config)}
}

// Set binds (or replaces) the policy Config for keyID.
func (s *Store) Set(keyID string, cfg Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byKey[keyID] = cfg
}

// Get returns the Config for keyID, or the zero-value Config (default-deny) if unset.
func (s *Store) Get(keyID string) Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byKey[keyID]
}
```

- [ ] **Step 4: Run tests + race + vet**

Run: `cd backend && go test -race ./internal/policy/ && go vet ./internal/policy/`
Expected: PASS (3 new tests + existing `TestEvaluate`); race clean; vet clean.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/policy/store.go backend/internal/policy/store_test.go
git commit --no-verify -m "feat(backend): policy.Store (per-key config, absent = default-deny)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: policy 门控 `handleSignL1`

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Update main_test.go (fail first)**

在 `backend/cmd/signer/main_test.go` 中：

(a) 把 import 块替换为（新增 policy 包；测试文件用 `1e12`/`100` 数字字面量，**不需要** `math`）：
```go
import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
)
```

(b) 把三处 `httptest.NewServer(newMux(keystore.New()))`（`TestHealthz`/`TestDigestL1Endpoint`/`TestDigestL1BadRequests`）改为 `httptest.NewServer(newMux(keystore.New(), policy.NewStore()))`。

(c) 把 `TestSignL1Endpoint` 里 `srv := httptest.NewServer(newMux(ks))` 改为：在 `ks.Add("k1", key)` 之后新增一行绑定宽松 policy，再用两参 `newMux`：
```go
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{v.Kind: true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(newMux(ks, policies))
```

(d) 把 `TestSignL1UnknownKey` 里 `newMux(keystore.New())` 改为 `newMux(keystore.New(), policy.NewStore())`。

(e) 把 `TestSignL1BadKind` 改为断言 403（policy 门控在 ActionFromKind 之前，`"nope"` 不在白名单被 policy 先拒）。整个函数替换为：
```go
func TestSignL1BadKind(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(newMux(ks, policies))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"nope","params":{},"nonce":1,"isTestnet":false}`
	res, _ := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (policy rejects unknown kind before ActionFromKind)", res.StatusCode)
	}
}
```

(f) 追加三个新用例：
```go
func TestSignL1DeniedWithoutPolicy(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	srv := httptest.NewServer(newMux(ks, policy.NewStore())) // no policy Set → default-deny
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1,"isTestnet":false}`
	res, _ := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (default-deny without policy)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "kind not allowed" {
		t.Fatalf("reason = %q, want %q", out.Error, "kind not allowed")
	}
}

func TestSignL1OverNotionalCap(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 100}) // 100 < 500 notional
	srv := httptest.NewServer(newMux(ks, policies))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1,"isTestnet":false}`
	res, _ := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (over notional cap)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "over notional cap" {
		t.Fatalf("reason = %q, want %q", out.Error, "over notional cap")
	}
}

func TestSignL1BadParamsAfterPolicy(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"cancel": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(newMux(ks, policies))
	defer srv.Close()
	// cancel passes policy (non-notional, allowlisted) but has malformed params → ActionFromKind 400.
	body := `{"keyId":"k1","kind":"cancel","params":{"cancels":"notarray"},"nonce":1,"isTestnet":false}`
	res, _ := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400 (bad params after policy pass)", res.StatusCode)
	}
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && go test ./cmd/signer/`
Expected: FAIL — `newMux` still takes one arg (compile error from the two-arg calls); policy gate not implemented.

- [ ] **Step 3: Update main.go — imports, intentFor, gate, newMux, main**

In `backend/cmd/signer/main.go`:

(a) Extend the import block to add `math`, `strconv`, and the policy package (keep the existing imports):
```go
import (
	"encoding/hex"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
)
```

(b) Add the `intentFor` helper (place it just above `handleSignL1`):
```go
// intentFor derives the policy Intent from a sign request's kind + params.
// For "order" it computes notional = px*sz (asset index as the per-coin key); an
// unparseable/malformed px/sz yields NaN so the policy fails closed. Non-order
// kinds are non-notional.
func intentFor(kind string, params json.RawMessage) policy.Intent {
	if kind != "order" {
		return policy.Intent{Kind: kind}
	}
	var p struct {
		Asset int64  `json:"asset"`
		Px    string `json:"px"`
		Sz    string `json:"sz"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return policy.Intent{Kind: "order", NotionalUsdc: math.NaN()}
	}
	pxF, errP := strconv.ParseFloat(p.Px, 64)
	szF, errS := strconv.ParseFloat(p.Sz, 64)
	notional := pxF * szF
	if errP != nil || errS != nil {
		notional = math.NaN()
	}
	return policy.Intent{Kind: "order", Coin: strconv.FormatInt(p.Asset, 10), NotionalUsdc: notional}
}
```

(c) Change `handleSignL1` to accept the policy store and insert the gate after the signer lookup. Replace the function signature line and add the gate block:
```go
func handleSignL1(ks *keystore.Keystore, policies *policy.Store) http.HandlerFunc {
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
		sig, err := signer.SignL1Action(action, req.Nonce, req.IsTestnet)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "sign failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(signL1Response{
			R: "0x" + hex.EncodeToString(sig.R[:]),
			S: "0x" + hex.EncodeToString(sig.S[:]),
			V: int(sig.V),
		})
	}
}
```

(d) Change `newMux` to accept and pass the policy store:
```go
func newMux(ks *keystore.Keystore, policies *policy.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies))
	return mux
}
```

(e) Change `main()` to build an empty policy store:
```go
func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	ks := keystore.New()
	policies := policy.NewStore()
	log.Printf("signer service listening on %s (empty keystore + policy; fail-closed)", addr)
	if err := http.ListenAndServe(addr, newMux(ks, policies)); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 4: Run tests + build**

Run: `cd backend && go test ./cmd/signer/`
Expected: PASS — TestHealthz, TestDigestL1Endpoint, TestDigestL1BadRequests, TestSignL1Endpoint (200 with permissive policy; {r,s,v} byte-exact), TestSignL1UnknownKey (404), TestSignL1BadKind (403), TestSignL1DeniedWithoutPolicy (403 "kind not allowed"), TestSignL1OverNotionalCap (403 "over notional cap"), TestSignL1BadParamsAfterPolicy (400).
Run: `cd backend && go build ./cmd/signer && rm -f signer && go vet ./cmd/signer/`
Expected: build succeeds (binary removed); vet clean.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): policy-gate /v1/sign/l1 (reject-first before signing, §5.1a)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd backend && go test ./... && go vet ./...` 全绿；`go test -race ./internal/policy/ ./cmd/signer/` 通过；`go build ./cmd/signer` 成功（构建后 `rm -f signer`）。
- 端到端 smoke（可选人工）：`SIGNER_ADDR=127.0.0.1:8093 go run ./cmd/signer &` → `curl -s -XPOST localhost:8093/v1/sign/l1 -d '{"keyId":"nope","kind":"order","params":{},"nonce":1,"isTestnet":false}'` 返回 404（空 keystore 先拒）→ `kill` 进程。
- `git diff --stat main...HEAD` —— 仅触及：`backend/internal/policy/{store.go,store_test.go}`、`backend/cmd/signer/{main.go,main_test.go}` + 两份 docs。无其它改动。
