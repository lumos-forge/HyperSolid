# Go 签名引擎：keystore + /v1/sign/l1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增进程内 `keystore`（复用 tier-① `hl.Signer`，Close 归零）+ `cmd/signer` 的 `/v1/sign/l1` 端点，让 Go 侧真正产出签名；可运行二进制默认空 keystore（fail-closed），不接入 TS 运行时。

**Architecture:** 纯增量 Go。`internal/keystore` 按不透明 keyId 并发安全地管理多个 `hl.Signer`；`cmd/signer` 注入 keystore 并新增签名端点，签名正确性用既有 golden 向量逐字节断言。无生产密钥加载路径、无 key 注入端点、不接线到 server。

**Tech Stack:** Go（`backend/internal/keystore` + `backend/cmd/signer`，标准库 `net/http`）。

---

## File Structure

- `backend/internal/keystore/keystore.go`（新）—— `Keystore`：New/Add/Signer/Remove/Close。
- `backend/internal/keystore/keystore_test.go`（新）—— keystore 行为 + 归零单测。
- `backend/cmd/signer/main.go`（改）—— `newMux(ks)` 注入 + `handleSignL1` + `main()` 建空 keystore。
- `backend/cmd/signer/main_test.go`（改）—— 既有用例改用 `newMux(keystore.New())` + 新增签名端点用例。

## 现有约定（供无上下文的实现者参考）

- `hl.Signer`（`internal/hl/signer.go`）：`NewSigner(priv []byte) (*Signer, error)`（priv 必须 32 字节，否则 error）；`SignL1Action(action Map, nonce uint64, isTestnet bool) (Sig, error)`；`Close()`（归零；Close 后再签返回 error）。`Sig{R,S [32]byte; V byte}`。
- `hl.ActionFromKind(kind string, params json.RawMessage) (Map, error)`；`hl.BuildTwapCancelAction(asset, twapID int64) Map`。
- `cmd/signer/main.go`（现状）：`writeErr(w, code, msg)`；`handleDigestL1`（keyless，包级函数）；`newMux() http.Handler`（`/healthz` + `/v1/digest/l1`）；`main()`。既有 `main_test.go` 有 `TestHealthz` / `TestDigestL1Endpoint` / `TestDigestL1BadRequests`，均调 `newMux()`（无参）。
- golden 向量文件：`backend/internal/hl/testdata/golden.json`，是一个数组，每元素含 `name/kind/params/nonce/isTestnet/privKey/sig{r,s,v}`（所有元素 privKey 均为 `0x1111…1111`）。从 `cmd/signer/` 测试相对路径为 `../../internal/hl/testdata/golden.json`。
- Go module：`github.com/lumos-forge/hypersolid/backend`。验证：`go test ./...`、`go vet ./...`、`go build ./cmd/signer`。
- 提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: `internal/keystore` 包

**Files:**
- Create: `backend/internal/keystore/keystore.go`
- Create: `backend/internal/keystore/keystore_test.go`

- [ ] **Step 1: Write the failing tests**

创建 `backend/internal/keystore/keystore_test.go`：

```go
package keystore

import (
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
)

func testKey(b byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = b
	}
	return k
}

func canSign(s *hl.Signer) error {
	_, err := s.SignL1Action(hl.BuildTwapCancelAction(0, 1), 1, false)
	return err
}

func TestAddAndSign(t *testing.T) {
	ks := New()
	defer ks.Close()
	if err := ks.Add("k1", testKey(0x11)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	s, ok := ks.Signer("k1")
	if !ok {
		t.Fatal("expected signer present")
	}
	if err := canSign(s); err != nil {
		t.Fatalf("sign: %v", err)
	}
}

func TestAddInvalidKey(t *testing.T) {
	ks := New()
	defer ks.Close()
	if err := ks.Add("bad", make([]byte, 16)); err == nil {
		t.Fatal("expected error for short key")
	}
	if _, ok := ks.Signer("bad"); ok {
		t.Fatal("invalid key must not be stored")
	}
}

func TestRemoveZeroizes(t *testing.T) {
	ks := New()
	defer ks.Close()
	_ = ks.Add("k1", testKey(0x22))
	s, _ := ks.Signer("k1")
	ks.Remove("k1")
	if _, ok := ks.Signer("k1"); ok {
		t.Fatal("expected removed")
	}
	if err := canSign(s); err == nil {
		t.Fatal("expected zeroized signer to fail signing")
	}
}

func TestReAddClosesOld(t *testing.T) {
	ks := New()
	defer ks.Close()
	_ = ks.Add("k1", testKey(0x33))
	old, _ := ks.Signer("k1")
	_ = ks.Add("k1", testKey(0x44))
	if err := canSign(old); err == nil {
		t.Fatal("expected old signer closed after re-add")
	}
	newS, ok := ks.Signer("k1")
	if !ok || newS == old {
		t.Fatal("expected a new signer after re-add")
	}
	if err := canSign(newS); err != nil {
		t.Fatalf("new signer should sign: %v", err)
	}
}

func TestCloseAll(t *testing.T) {
	ks := New()
	_ = ks.Add("a", testKey(0x55))
	_ = ks.Add("b", testKey(0x66))
	ks.Close()
	if _, ok := ks.Signer("a"); ok {
		t.Fatal("a should be gone")
	}
	if _, ok := ks.Signer("b"); ok {
		t.Fatal("b should be gone")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/keystore/`
Expected: FAIL — package/`New`/`Add`/etc. undefined (compile error / no non-test files).

- [ ] **Step 3: Create keystore.go**

创建 `backend/internal/keystore/keystore.go`：

```go
// Package keystore holds tier-① in-process HL signers keyed by an opaque keyID.
// Removing or closing a key zeroizes the underlying secp256k1 material (hl.Signer.Close).
// It performs NO policy checks — a reject-first policy layer must wrap it before any
// production use (see docs/BACKEND-ARCHITECTURE.md §5.1a).
package keystore

import (
	"sync"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
)

// Keystore is a concurrency-safe registry of keyID -> *hl.Signer.
type Keystore struct {
	mu   sync.RWMutex
	byID map[string]*hl.Signer
}

// New returns an empty keystore.
func New() *Keystore {
	return &Keystore{byID: make(map[string]*hl.Signer)}
}

// Add registers a signer for keyID from a 32-byte private key. If keyID already exists,
// the old signer is closed (zeroized) and replaced. Returns an error on an invalid key
// (nothing is stored in that case).
func (k *Keystore) Add(keyID string, priv []byte) error {
	s, err := hl.NewSigner(priv)
	if err != nil {
		return err
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if old, ok := k.byID[keyID]; ok {
		old.Close()
	}
	k.byID[keyID] = s
	return nil
}

// Signer returns the signer for keyID, or (nil, false) if absent.
func (k *Keystore) Signer(keyID string) (*hl.Signer, bool) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	s, ok := k.byID[keyID]
	return s, ok
}

// Remove closes (zeroizes) and deletes the signer for keyID, if present.
func (k *Keystore) Remove(keyID string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if s, ok := k.byID[keyID]; ok {
		s.Close()
		delete(k.byID, keyID)
	}
}

// Close closes (zeroizes) all signers and empties the store.
func (k *Keystore) Close() {
	k.mu.Lock()
	defer k.mu.Unlock()
	for id, s := range k.byID {
		s.Close()
		delete(k.byID, id)
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/keystore/ && go vet ./internal/keystore/`
Expected: PASS (5 tests); vet clean.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/keystore/keystore.go backend/internal/keystore/keystore_test.go
git commit --no-verify -m "feat(backend): internal/keystore (in-process tier-1 signers by keyId)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `cmd/signer` `/v1/sign/l1` 端点

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Write the failing tests**

在 `backend/cmd/signer/main_test.go` 顶部，把 import 块替换为（新增 `bytes`、`encoding/hex`、`os` 与 keystore 包；保留既有）：

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
)
```

把既有三个测试里的 `newMux()` 调用全部改为 `newMux(keystore.New())`（`TestHealthz`、`TestDigestL1Endpoint`、`TestDigestL1BadRequests` 各一处）。

然后在文件末尾追加：

```go
type goldenSig struct {
	R string `json:"r"`
	S string `json:"s"`
	V int    `json:"v"`
}

type goldenVec struct {
	Name      string          `json:"name"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Nonce     uint64          `json:"nonce"`
	IsTestnet bool            `json:"isTestnet"`
	PrivKey   string          `json:"privKey"`
	Sig       goldenSig       `json:"sig"`
}

func loadFirstGolden(t *testing.T) goldenVec {
	t.Helper()
	raw, err := os.ReadFile("../../internal/hl/testdata/golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var vs []goldenVec
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	if len(vs) == 0 {
		t.Fatal("no golden vectors")
	}
	return vs[0]
}

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
	srv := httptest.NewServer(newMux(ks))
	defer srv.Close()
	body, _ := json.Marshal(struct {
		KeyID     string          `json:"keyId"`
		Kind      string          `json:"kind"`
		Params    json.RawMessage `json:"params"`
		Nonce     uint64          `json:"nonce"`
		IsTestnet bool            `json:"isTestnet"`
	}{"k1", v.Kind, v.Params, v.Nonce, v.IsTestnet})
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out goldenSig
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.R != v.Sig.R || out.S != v.Sig.S || out.V != v.Sig.V {
		t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", out.R, out.S, out.V, v.Sig.R, v.Sig.S, v.Sig.V)
	}
}

func TestSignL1UnknownKey(t *testing.T) {
	srv := httptest.NewServer(newMux(keystore.New()))
	defer srv.Close()
	body := `{"keyId":"nope","kind":"order","params":{"asset":0,"isBuy":true,"px":"1","sz":"1","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1,"isTestnet":false}`
	res, _ := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	defer res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

func TestSignL1BadKind(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	srv := httptest.NewServer(newMux(ks))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"nope","params":{},"nonce":1,"isTestnet":false}`
	res, _ := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./cmd/signer/`
Expected: FAIL — `newMux` now takes an argument (existing tests already updated to pass `keystore.New()`), but `newMux`'s definition still takes none and `/v1/sign/l1` isn't wired → compile error / 404-not-405 mismatches. (Primary: compile error because main.go `newMux()` signature differs.)

- [ ] **Step 3: Add keystore + sign endpoint to main.go**

在 `backend/cmd/signer/main.go` 的 import 块加入 keystore 包：

```go
	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
```

在 `handleDigestL1` 之后追加签名请求/响应类型与 handler：

```go
type signL1Request struct {
	KeyID     string          `json:"keyId"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Nonce     uint64          `json:"nonce"`
	IsTestnet bool            `json:"isTestnet"`
}

type signL1Response struct {
	R string `json:"r"`
	S string `json:"s"`
	V int    `json:"v"`
}

// handleSignL1 signs an L1 action with the keystore signer named by keyId.
// Fail-closed: an unknown keyId returns 404. Never logs key material.
func handleSignL1(ks *keystore.Keystore) http.HandlerFunc {
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

把 `newMux` 改为接收 keystore 并挂载签名路由：

```go
// newMux builds the service router (no side effects; testable).
// The digest endpoints are keyless; /v1/sign/l1 uses the injected keystore.
func newMux(ks *keystore.Keystore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks))
	return mux
}
```

把 `main()` 改为建立空 keystore：

```go
func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	ks := keystore.New()
	log.Printf("signer service listening on %s (keystore empty; fail-closed)", addr)
	if err := http.ListenAndServe(addr, newMux(ks)); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 4: Run tests + build to verify pass**

Run: `cd backend && go test ./cmd/signer/`
Expected: PASS — existing 3 tests + `TestSignL1Endpoint` (200 + `{r,s,v}` byte-exact vs golden vector) + `TestSignL1UnknownKey` (404) + `TestSignL1BadKind` (400).
Run: `cd backend && go build ./cmd/signer && rm -f signer`
Expected: build succeeds (remove the produced binary so it isn't committed).

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): cmd/signer /v1/sign/l1 (keystore-backed L1 signing)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd backend && go test ./... && go vet ./...` 全绿。
- `go build ./cmd/signer` 成功（构建后 `rm -f signer`）。
- 端到端 smoke（可选人工）：`SIGNER_ADDR=127.0.0.1:8092 go run ./cmd/signer &` → `curl -s localhost:8092/healthz` = `{"status":"ok"}` → `curl -s -XPOST localhost:8092/v1/sign/l1 -d '{"keyId":"nope","kind":"order","params":{},"nonce":1,"isTestnet":false}'` 返回 404（fail-closed，运行态 keystore 为空）→ `kill` 掉进程。
- `git diff --stat main...HEAD` —— 仅触及：`backend/internal/keystore/{keystore.go,keystore_test.go}`、`backend/cmd/signer/{main.go,main_test.go}`、以及两份 docs。无 server/mobile 改动、无 internal/hl 改动。
