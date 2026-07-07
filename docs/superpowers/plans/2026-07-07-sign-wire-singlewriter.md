# 接线 /v1/sign/l1 → singlewriter.Authorize + Fencer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `cmd/signer` 的 `/v1/sign/l1` 从进程内 `nonce.Allocator`+`policy.SpendTracker` 切换到统一的 `singlewriter.Writer.Authorize`（fence+每日额度+nonce 原子），并引入 `Fencer` 领导权闸门（非 leader→503、`ErrFenced`→409）+ 注入时钟。

**Architecture:** `handleSignL1` 在 `Evaluate`（保持不变）与 `ActionFromKind` 之后，读 `fencer.Fence()`；非 leader→503；否则 `writer.Authorize(Request{KeyID,Fence,Notional,DailyCap,NowMs:nowMs()})` 替代 `spend.Charge`+`nonces.Next`，按 typed error 映射 HTTP。`main()` 用内存 `singlewriter.NewMem()` + 静态 always-leader fencer（单实例）。

**Tech Stack:** Go 1.26；现有 `internal/singlewriter`（`Writer`/`NewMem`/`Request`/`Grant`/`ErrFenced`/`ErrDailyCap`/`ErrInvalidNotional`/`ErrInvalidClock`）、`internal/policy`（`Evaluate`/`Intent`/`Store`/`Config`）、`internal/keystore`、`internal/hl`。

---

## File Structure

- `backend/cmd/signer/main.go` — 端点重写：`Fencer`/`staticFencer` + `handleSignL1`/`newMux`/`main` 用 `singlewriter.Writer`+`Fencer`+时钟。（Task 1）
- `backend/cmd/signer/main_test.go` — 测试助手 `constFencer`/`leaderMux` + 既有 15 用例适配（Task 1）；新增 `TestSignL1NonLeader503`/`TestSignL1FencedConflict`（Task 2）。

> 现有端点管线（供参照）：`Signer(404)→Evaluate(403)→ActionFromKind(400)→spend.Charge(403)→nonces.Next→sign(200)`。模块路径 `github.com/lumos-forge/hypersolid/backend`。提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: 端点重写 + 既有测试适配

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 改 main.go 的 import 块**

在 `backend/cmd/signer/main.go`，替换整个 import 块：
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
	"github.com/lumos-forge/hypersolid/backend/internal/nonce"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
)
```
为：
```go
import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)
```

- [ ] **Step 2: 更新 package 文档注释**

替换 main.go 顶部 1–5 行的 package 文档：
```go
// Command signer is the M5 signing service. It exposes keyless digest endpoints
// (/healthz, /v1/digest/l1) plus a keystore-backed L1 signing endpoint (/v1/sign/l1).
// The shipped binary starts with an EMPTY keystore (fail-closed: nothing is signable)
// and has no key-injection path. It performs NO policy checks — a reject-first policy
// layer must wrap /v1/sign/l1 before any production use (docs/BACKEND-ARCHITECTURE.md §5.1a).
```
为：
```go
// Command signer is the M5/M6 signing service. It exposes keyless digest endpoints
// (/healthz, /v1/digest/l1) plus a keystore-backed L1 signing endpoint (/v1/sign/l1)
// gated by the reject-first policy (Evaluate) then the single-writer authority
// (fence + daily notional cap + monotonic nonce, atomically). The shipped binary
// starts with an EMPTY keystore (fail-closed) and, by default, an in-memory
// single-writer + an always-leader fencer (single instance); wiring a leased
// cross-host single-writer is a later slice (docs/BACKEND-ARCHITECTURE.md §5.1a/§6.2).
```

- [ ] **Step 3: 新增 `Fencer` + `staticFencer`（插在 `intentFor` 之后、`handleSignL1` 之前）**

在 main.go 中 `intentFor` 函数的右花括号之后、`handleSignL1` 之前插入：
```go
// Fencer supplies the current fencing token (a lease epoch) and whether this
// instance currently holds leadership. A non-leader must not sign. leader.Leader
// satisfies this; main() uses a static always-leader fencer for the in-memory
// single-instance default.
type Fencer interface {
	Fence() (epoch uint64, isLeader bool)
}

// staticFencer is an always-leader fencer with a fixed epoch (single instance).
type staticFencer struct{ epoch uint64 }

func (s staticFencer) Fence() (uint64, bool) { return s.epoch, true }
```

- [ ] **Step 4: 替换 `handleSignL1`（整个函数含 doc）**

把 main.go 中从 `// handleSignL1 signs an L1 action` 注释起、到该函数结束的整个 `handleSignL1` 替换为：
```go
// handleSignL1 signs an L1 action with the keystore signer named by keyId. The
// reject-first policy (Evaluate) runs first; then, if this instance is the leader,
// the single-writer atomically enforces the fencing token + daily notional cap and
// allocates a strictly-increasing per-key nonce, which is returned. Fail-closed: an
// unknown keyId → 404; a non-leader → 503; a stale fence → 409. Never logs key material.
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, writer singlewriter.Writer, fencer Fencer, nowMs func() int64) http.HandlerFunc {
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
		intent := intentFor(req.Kind, req.Params)
		cfg := policies.Get(req.KeyID)
		if d := policy.Evaluate(intent, cfg); !d.Allow {
			writeErr(w, http.StatusForbidden, d.Reason)
			return
		}
		action, err := hl.ActionFromKind(req.Kind, req.Params)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		fence, isLeader := fencer.Fence()
		if !isLeader {
			writeErr(w, http.StatusServiceUnavailable, "not leader")
			return
		}
		grant, err := writer.Authorize(r.Context(), singlewriter.Request{
			KeyID:    req.KeyID,
			Fence:    fence,
			Notional: intent.NotionalUsdc,
			DailyCap: cfg.DailyMaxNotionalUsdc,
			NowMs:    nowMs(),
		})
		if err != nil {
			switch {
			case errors.Is(err, singlewriter.ErrFenced):
				writeErr(w, http.StatusConflict, "fenced")
			case errors.Is(err, singlewriter.ErrDailyCap):
				writeErr(w, http.StatusForbidden, "daily cap exceeded")
			case errors.Is(err, singlewriter.ErrInvalidNotional):
				writeErr(w, http.StatusForbidden, "invalid notional")
			case errors.Is(err, singlewriter.ErrInvalidClock):
				writeErr(w, http.StatusInternalServerError, "invalid clock")
			default:
				writeErr(w, http.StatusInternalServerError, "authorize failed")
			}
			return
		}
		sig, err := signer.SignL1Action(action, grant.Nonce, req.IsTestnet)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "sign failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(signL1Response{
			R:     "0x" + hex.EncodeToString(sig.R[:]),
			S:     "0x" + hex.EncodeToString(sig.S[:]),
			V:     int(sig.V),
			Nonce: grant.Nonce,
		})
	}
}
```

- [ ] **Step 5: 替换 `newMux` 与 `main`**

把 main.go 的 `newMux` 整个替换为：
```go
// newMux builds the service router (no side effects; testable). The digest
// endpoints are keyless; /v1/sign/l1 uses the injected keystore, policy,
// single-writer, fencer, and clock.
func newMux(ks *keystore.Keystore, policies *policy.Store, writer singlewriter.Writer, fencer Fencer, nowMs func() int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, writer, fencer, nowMs))
	return mux
}
```
把 `main` 整个替换为：
```go
func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	ks := keystore.New()
	policies := policy.NewStore()
	writer := singlewriter.NewMem()
	fencer := staticFencer{epoch: 1}
	nowMs := func() int64 { return time.Now().UnixMilli() }
	log.Printf("signer service listening on %s (empty keystore + policy; in-memory single-writer, single instance)", addr)
	if err := http.ListenAndServe(addr, newMux(ks, policies, writer, fencer, nowMs)); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 6: 确认 main.go 编译（测试尚未适配，会红）**

Run: `cd backend && go build ./cmd/signer`
Expected: 编译成功（main.go 自洽）。`go vet ./cmd/signer/` 此刻可能因 test 未适配而报错——下一步修 test。

- [ ] **Step 7: 适配 main_test.go —— import + 助手**

在 `backend/cmd/signer/main_test.go`，替换 import 中的这三行：
```go
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/nonce"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
```
为：
```go
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
```
在 import 块之后、`TestHealthz` 之前插入助手：
```go
// constFencer is a test Fencer with a fixed epoch and leadership flag.
type constFencer struct {
	epoch  uint64
	leader bool
}

func (c constFencer) Fence() (uint64, bool) { return c.epoch, c.leader }

// leaderMux builds a mux with a fresh in-memory single-writer, an always-leader
// fencer (epoch 1), and the given clock (nil → real time). It reproduces the
// pre-wiring in-memory nonce+cap behavior plus the fence gate.
func leaderMux(ks *keystore.Keystore, policies *policy.Store, nowMs func() int64) http.Handler {
	return newMux(ks, policies, singlewriter.NewMem(), constFencer{epoch: 1, leader: true}, nowMs)
}
```

- [ ] **Step 8: 适配简单调用点（无固定时钟需求）**

在 main_test.go 中做以下逐字替换（每个是唯一出现）：

- `TestHealthz`、`TestDigestL1Endpoint`、`TestDigestL1BadRequests`、`TestSignL1UnknownKey` 各含一处
  `newMux(keystore.New(), policy.NewStore(), nonce.New(nil), policy.NewSpendTracker(nil))`
  → `leaderMux(keystore.New(), policy.NewStore(), nil)`
- `TestSignL1DeniedWithoutPolicy` 的
  `newMux(ks, policy.NewStore(), nonce.New(nil), policy.NewSpendTracker(nil))`
  → `leaderMux(ks, policy.NewStore(), nil)`
- `TestSignL1BadKind`、`TestSignL1OverNotionalCap`、`TestSignL1BadParamsAfterPolicy`、`TestSignL1ModifyOverNotionalCap`、`TestSignL1BatchModifyOverNotionalCap`、`TestSignL1BatchModifyNegativeLegMasking`、`TestSignL1OrderNegativePriceRejected` 各含一处
  `newMux(ks, policies, nonce.New(nil), policy.NewSpendTracker(nil))`
  → `leaderMux(ks, policies, nil)`

（用 grep 核对：替换后 `grep -n 'nonce\.' backend/cmd/signer/main_test.go` 只应剩下带固定时钟的**四处**——golden / 单调 nonce / 每日额度 / twap，见下一步。）

- [ ] **Step 9: 适配需要固定时钟的调用点（golden / 单调 nonce / 每日额度 / twap）**

`TestSignL1Endpoint`（golden）—— 替换这 3 行：
```go
	// Fixed clock = the golden nonce, so Next("k1") returns v.Nonce and the
	// produced signature matches the golden vector byte-for-byte.
	nonces := nonce.New(func() int64 { return int64(v.Nonce) })
	srv := httptest.NewServer(newMux(ks, policies, nonces, policy.NewSpendTracker(nil)))
```
为：
```go
	// Fixed clock = the golden nonce, so Authorize returns v.Nonce and the produced
	// signature matches the golden vector byte-for-byte.
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
```

`TestSignL1GeneratesMonotonicNonce` —— 替换这 2 行：
```go
	nonces := nonce.New(func() int64 { return 1700000000000 })
	srv := httptest.NewServer(newMux(ks, policies, nonces, policy.NewSpendTracker(nil)))
```
为：
```go
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return 1700000000000 }))
```

`TestSignL1DailyCapExceeded` —— 替换这 3 行：
```go
	nonces := nonce.New(func() int64 { return 1700000000000 })
	spend := policy.NewSpendTracker(func() int64 { return 1700000000000 })
	srv := httptest.NewServer(newMux(ks, policies, nonces, spend))
```
为：
```go
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return 1700000000000 }))
```

`TestSignL1TwapOrderDeniedNoPrice` —— 替换这 3 行：
```go
	nonces := nonce.New(func() int64 { return 1700000000000 })
	spend := policy.NewSpendTracker(func() int64 { return 1700000000000 })
	srv := httptest.NewServer(newMux(ks, policies, nonces, spend))
```
为：
```go
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return 1700000000000 }))
```

- [ ] **Step 10: 全量测试 + vet + build**

Run: `cd backend && go test ./cmd/signer/ && go vet ./cmd/signer/`
Expected: PASS —— 全部既有用例通过（golden 字节级不变；每日额度经 Authorize 仍 403 "daily cap exceeded"；单调 nonce 经 Authorize 仍 `1700000000000` 与 `+1`）。`grep -n 'nonce\.\|NewSpendTracker' backend/cmd/signer/main_test.go` 应无输出（nonce/spend 已全部移除）。
Run: `cd backend && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Expected: 全绿；signer 构建成功（二进制已删）。

- [ ] **Step 11: 提交**

```bash
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): wire /v1/sign/l1 to singlewriter.Authorize + Fencer gate

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 领导权 / fence 新用例

**Files:**
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 加 `context` import**

在 `backend/cmd/signer/main_test.go` 的 import 块顶部加入 `"context"`（与既有 `"bytes"` 等标准库并列，保持字母序：`context` 在 `bytes` 与 `encoding/hex` 之间）。

- [ ] **Step 2: 写失败测试**

在 main_test.go 末尾追加：
```go
func TestSignL1NonLeader503(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	// A non-leader must refuse to sign (503) even for an otherwise-valid request.
	srv := httptest.NewServer(newMux(ks, policies, singlewriter.NewMem(), constFencer{epoch: 1, leader: false}, nil))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 503 {
		t.Fatalf("status = %d, want 503 (not leader)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "not leader" {
		t.Fatalf("reason = %q, want %q", out.Error, "not leader")
	}
}

func TestSignL1FencedConflict(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	// A newer leader has already advanced this key's fence to 5 in the single-writer.
	writer := singlewriter.NewMem()
	if _, err := writer.Authorize(context.Background(), singlewriter.Request{
		KeyID: "k1", Fence: 5, Notional: 0, DailyCap: 0, NowMs: 1700000000000,
	}); err != nil {
		t.Fatalf("seed fence: %v", err)
	}
	// This endpoint still believes it is the leader at the STALE epoch 1 → fenced (409).
	srv := httptest.NewServer(newMux(ks, policies, writer, constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 }))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("status = %d, want 409 (stale fence)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "fenced" {
		t.Fatalf("reason = %q, want %q", out.Error, "fenced")
	}
}
```

- [ ] **Step 3: 运行 + 全量 + vet + build**

Run: `cd backend && go test ./cmd/signer/ -run 'TestSignL1NonLeader503|TestSignL1FencedConflict' -v`
Expected: 两者 PASS。
Run: `cd backend && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Expected: 全绿；signer 构建成功（二进制已删）。

- [ ] **Step 4: 提交**

```bash
git add backend/cmd/signer/main_test.go
git commit --no-verify -m "test(backend): non-leader 503 + stale-fence 409 on /v1/sign/l1

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd backend && go test ./... && go vet ./... && go build ./...` 全绿。
- golden 向量 `TestSignL1Endpoint` 字节级不变。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅改 `cmd/signer/{main.go,main_test.go}` + 两份 docs。不改 `singlewriter`/`lease`/`leader`/`policy`/`nonce`。
- `grep -rn 'nonce\.\|NewSpendTracker' backend/cmd/signer/` 无输出（端点已不再直接用它们）。

## 备注

- 行为等价性：`Evaluate` 相关 403/400/404 全不变；每日额度与 nonce 现由 `singlewriter.Authorize` 统一产出（数学与 `SpendTracker.Charge`/`nonce.Next` 一致），额外多一道 fence 闸门。
- `main()` 仍单实例内存（静态 always-leader）；part 3 注入 `leader.Leader`+Postgres 后 fence 变为真实租约 epoch。
- `nonce`/`policy.SpendTracker` 包保留，仅 `cmd/signer` 不再直接引用。
