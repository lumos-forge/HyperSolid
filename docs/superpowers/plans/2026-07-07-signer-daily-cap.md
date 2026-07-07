# policy 每日封顶 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增有状态 `policy.SpendTracker`（每-key 每日累计名义额，UTC 日分桶，原子 Charge）+ `Config.DailyMaxNotionalUsdc`，并在 `/v1/sign/l1` 单笔 policy 通过后、生成 nonce 前做每日封顶门控（deny → 403）。

**Architecture:** `policy.Evaluate` 保持纯；每日封顶由 `SpendTracker.Charge`（单锁原子检查+预留）在签名边界强制。签名端注入 `SpendTracker`；每日拒在 nonce 生成之前（不烧 nonce），并发下绝不超顶。

**Tech Stack:** Go（`backend/internal/policy` + `backend/cmd/signer`，标准库）。

---

## File Structure

- `backend/internal/policy/policy.go`（改）—— `Config` 加 `DailyMaxNotionalUsdc`。
- `backend/internal/policy/spend.go`（新）—— `SpendTracker`（NewSpendTracker/Charge/Spent）。
- `backend/internal/policy/spend_test.go`（新）—— 封顶/日滚动/隔离/并发测试。
- `backend/cmd/signer/main.go`（改）—— `handleSignL1`/`newMux`/`main` 注入 `SpendTracker` + 每日 Charge 门控。
- `backend/cmd/signer/main_test.go`（改）—— `newMux` 加第四参 + 每日超顶用例。

## 现有约定（供无上下文的实现者参考）

- `internal/policy/policy.go`：`Config{AllowedKinds map[string]bool; KillSwitch bool; MaxNotionalUsdc float64; PerCoinMaxUsdc map[string]float64}`；`Evaluate(intent, cfg) Decision`（纯，负/NaN notional 拒 "invalid notional"）；`Intent{Kind, Coin string; NotionalUsdc float64}`；`Store{Set/Get}`。
- `cmd/signer/main.go`（PR #26）：`handleSignL1(ks *keystore.Keystore, policies *policy.Store, nonces *nonce.Allocator)` —— method 405/json 400 → `ks.Signer` 404 → `policy.Evaluate(intentFor(req.Kind, req.Params), policies.Get(req.KeyID))` 403 → `hl.ActionFromKind` 400 → `n := nonces.Next(req.KeyID)` → `SignL1Action(action, n, req.IsTestnet)` 500 → 200 `{r,s,v,nonce:n}`。`newMux(ks, policies, nonces)`；`main()` 建 `ks:=keystore.New(); policies:=policy.NewStore(); nonces:=nonce.New(nil)`。`intentFor(kind, params) policy.Intent`。`writeErr(w, code, msg)`。
- `cmd/signer/main_test.go`（PR #26）：当前 `newMux(...)` 调用点均三参（TestHealthz、TestDigestL1Endpoint、TestDigestL1BadRequests、TestSignL1Endpoint、TestSignL1UnknownKey、TestSignL1BadKind、TestSignL1DeniedWithoutPolicy、TestSignL1OverNotionalCap、TestSignL1BadParamsAfterPolicy、TestSignL1ModifyOverNotionalCap、TestSignL1BatchModifyOverNotionalCap、TestSignL1BatchModifyNegativeLegMasking、TestSignL1OrderNegativePriceRejected、TestSignL1GeneratesMonotonicNonce）。golden order 名义额 = px 50000 × sz 0.01 = 500。
- Go module `github.com/lumos-forge/hypersolid/backend`。验证 `go test ./...`、`go vet ./...`、`go test -race ...`、`go build ./cmd/signer`。
- 提交 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。

---

### Task 1: `Config.DailyMaxNotionalUsdc` + `policy.SpendTracker`

**Files:**
- Modify: `backend/internal/policy/policy.go`
- Create: `backend/internal/policy/spend.go`
- Create: `backend/internal/policy/spend_test.go`

- [ ] **Step 1: Write the failing tests**

创建 `backend/internal/policy/spend_test.go`：

```go
package policy

import (
	"sync"
	"testing"
)

func TestChargeWithinCap(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	if !s.Charge("k1", 300, 1000) {
		t.Fatal("300 within cap 1000 should charge")
	}
	if got := s.Spent("k1"); got != 300 {
		t.Fatalf("Spent = %v, want 300", got)
	}
	if !s.Charge("k1", 700, 1000) {
		t.Fatal("300+700=1000 == cap should charge (strict >)")
	}
	if s.Charge("k1", 1, 1000) {
		t.Fatal("1001 > cap 1000 should be denied")
	}
	if got := s.Spent("k1"); got != 1000 {
		t.Fatalf("Spent = %v, want 1000 (denied charge not added)", got)
	}
}

func TestChargeZeroCapUnlimited(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	if !s.Charge("k1", 1e15, 0) {
		t.Fatal("dailyCap 0 = unlimited, should charge")
	}
	if got := s.Spent("k1"); got != 1e15 {
		t.Fatalf("Spent = %v, want 1e15", got)
	}
}

func TestChargeDayRollResets(t *testing.T) {
	now := int64(1_700_000_000_000)
	s := NewSpendTracker(func() int64 { return now })
	s.Charge("k1", 900, 1000)
	if s.Charge("k1", 200, 1000) {
		t.Fatal("900+200 over cap same day should deny")
	}
	now += 24 * 60 * 60 * 1000 // next UTC day
	if !s.Charge("k1", 900, 1000) {
		t.Fatal("new day should reset the key's total")
	}
	if got := s.Spent("k1"); got != 900 {
		t.Fatalf("Spent = %v, want 900 (new day)", got)
	}
}

func TestChargePerKeyIsolation(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	s.Charge("a", 1000, 1000)
	if s.Charge("a", 1, 1000) {
		t.Fatal("key a is full")
	}
	if !s.Charge("b", 1000, 1000) {
		t.Fatal("key b is independent and empty")
	}
}

func TestChargeConcurrentNeverExceeds(t *testing.T) {
	s := NewSpendTracker(func() int64 { return 1_700_000_000_000 })
	const per = 100.0
	const cap = 1000.0 // exactly 10 charges fit
	const goroutines = 100
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.Charge("k1", per, cap) {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if allowed != 10 {
		t.Fatalf("allowed = %d, want exactly 10 (cap/per)", allowed)
	}
	if got := s.Spent("k1"); got != 1000 {
		t.Fatalf("Spent = %v, want 1000 (never exceeds cap)", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/policy/`
Expected: FAIL — `NewSpendTracker`/`SpendTracker.Charge`/`Spent` undefined (compile error).

- [ ] **Step 3: Add the Config field + create spend.go**

在 `backend/internal/policy/policy.go` 的 `Config` 结构体中，`PerCoinMaxUsdc` 字段之后追加：
```go
	DailyMaxNotionalUsdc float64 // per-key daily notional cap; 0 = no daily limit (enforced by SpendTracker, not Evaluate)
```

创建 `backend/internal/policy/spend.go`：
```go
package policy

import (
	"sync"
	"time"
)

const dayMs int64 = 24 * 60 * 60 * 1000

type daySpend struct {
	day   int64   // UTC day number = nowMs / dayMs
	total float64 // notional spent within that day
}

// SpendTracker accumulates per-key notional spent within the current UTC day and
// enforces a per-key daily cap. It is the stateful complement to the pure
// Evaluate. Safe for concurrent use.
type SpendTracker struct {
	nowMs func() int64
	mu    sync.Mutex
	spent map[string]daySpend
}

// NewSpendTracker returns a tracker. If nowMs is nil, it uses the real clock
// (time.Now().UnixMilli()); tests inject a fake clock.
func NewSpendTracker(nowMs func() int64) *SpendTracker {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &SpendTracker{nowMs: nowMs, spent: make(map[string]daySpend)}
}

// Charge atomically enforces the per-key daily cap. If the current UTC day rolled
// over, the key's total resets to 0; if dailyCap > 0 and total+notional would
// exceed it, Charge returns false WITHOUT adding; otherwise it adds notional to
// the day's total and returns true. dailyCap == 0 means no daily limit.
func (s *SpendTracker) Charge(keyID string, notional, dailyCap float64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.nowMs() / dayMs
	e := s.spent[keyID]
	if e.day != d {
		e = daySpend{day: d, total: 0}
	}
	if dailyCap > 0 && e.total+notional > dailyCap {
		s.spent[keyID] = e
		return false
	}
	e.total += notional
	e.day = d
	s.spent[keyID] = e
	return true
}

// Spent returns the notional spent by keyID within the current UTC day (0 if the
// stored day has rolled). For tests/observability.
func (s *SpendTracker) Spent(keyID string) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.nowMs() / dayMs
	e := s.spent[keyID]
	if e.day != d {
		return 0
	}
	return e.total
}
```

- [ ] **Step 4: Run tests + race + vet**

Run: `cd backend && go test -race ./internal/policy/ && go vet ./internal/policy/`
Expected: PASS (5 new SpendTracker tests + existing Evaluate/Store tests); race clean; vet clean.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/policy/policy.go backend/internal/policy/spend.go backend/internal/policy/spend_test.go
git commit --no-verify -m "feat(backend): policy.SpendTracker + Config.DailyMaxNotionalUsdc (stateful daily cap)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 每日封顶门控 `/v1/sign/l1`

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Update main_test.go (fail first)**

在 `backend/cmd/signer/main_test.go` 中，给**每一处** `newMux(...)` 调用追加第四参 `policy.NewSpendTracker(nil)`（即每个 `newMux(A, B, C)` → `newMux(A, B, C, policy.NewSpendTracker(nil))`）。涉及全部 14 个既有 `newMux` 调用点（TestHealthz、TestDigestL1Endpoint、TestDigestL1BadRequests、TestSignL1Endpoint、TestSignL1UnknownKey、TestSignL1BadKind、TestSignL1DeniedWithoutPolicy、TestSignL1OverNotionalCap、TestSignL1BadParamsAfterPolicy、TestSignL1ModifyOverNotionalCap、TestSignL1BatchModifyOverNotionalCap、TestSignL1BatchModifyNegativeLegMasking、TestSignL1OrderNegativePriceRejected、TestSignL1GeneratesMonotonicNonce）。

然后追加每日超顶用例：
```go
func TestSignL1DailyCapExceeded(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	// Per-order cap is generous (1e12); the DAILY cap is 600 and each order is 500.
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12, DailyMaxNotionalUsdc: 600})
	nonces := nonce.New(func() int64 { return 1700000000000 })
	spend := policy.NewSpendTracker(func() int64 { return 1700000000000 })
	srv := httptest.NewServer(newMux(ks, policies, nonces, spend))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	post := func() int {
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if s := post(); s != 200 {
		t.Fatalf("first sign status = %d, want 200 (500 <= daily cap 600)", s)
	}
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("second sign status = %d, want 403 (500+500 > daily cap 600)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "daily cap exceeded" {
		t.Fatalf("reason = %q, want %q", out.Error, "daily cap exceeded")
	}
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && go test ./cmd/signer/`
Expected: FAIL — `newMux` still takes three args (compile error from the four-arg calls); the daily gate isn't implemented.

- [ ] **Step 3: Update main.go**

在 `backend/cmd/signer/main.go` 中：

(a) 把整个 `handleSignL1` 替换为（新增 `spend` 参数；computes intent+cfg once；在 ActionFromKind 之后、Next 之前插入每日 Charge）：
```go
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, nonces *nonce.Allocator, spend *policy.SpendTracker) http.HandlerFunc {
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
		if !spend.Charge(req.KeyID, intent.NotionalUsdc, cfg.DailyMaxNotionalUsdc) {
			writeErr(w, http.StatusForbidden, "daily cap exceeded")
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

(b) 把整个 `newMux` 替换为（新增 `spend` 参数）：
```go
func newMux(ks *keystore.Keystore, policies *policy.Store, nonces *nonce.Allocator, spend *policy.SpendTracker) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, nonces, spend))
	return mux
}
```

(c) 把整个 `main` 替换为（建 SpendTracker）：
```go
func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	ks := keystore.New()
	policies := policy.NewStore()
	nonces := nonce.New(nil)
	spend := policy.NewSpendTracker(nil)
	log.Printf("signer service listening on %s (empty keystore + policy; fail-closed)", addr)
	if err := http.ListenAndServe(addr, newMux(ks, policies, nonces, spend)); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 4: Run tests + build + vet + race**

Run: `cd backend && go test ./cmd/signer/`
Expected: PASS — all existing tests (now four-arg newMux; TestSignL1Endpoint still 200 since its Config has DailyMaxNotionalUsdc 0 = unlimited) + TestSignL1DailyCapExceeded (first 200, second 403 "daily cap exceeded").
Run: `cd backend && go build ./cmd/signer && rm -f signer && go vet ./cmd/signer/ && go test -race ./cmd/signer/`
Expected: build succeeds (binary removed); vet clean; race clean.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): daily notional cap gate on /v1/sign/l1

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- `cd backend && go test ./... && go vet ./...` 全绿；`go test -race ./internal/policy/ ./cmd/signer/` 通过；`go build ./cmd/signer` 成功（`rm -f signer`）。
- `git diff --stat main...HEAD` —— 仅触及：`backend/internal/policy/{policy.go,spend.go,spend_test.go}`、`backend/cmd/signer/{main.go,main_test.go}` + 两份 docs。无其它改动。
