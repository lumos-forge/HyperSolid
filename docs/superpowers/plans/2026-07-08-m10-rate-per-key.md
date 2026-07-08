# M10-rate 按 key 令牌桶限流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 signer 的 `/v1/sign/l1` 增加按 key 的令牌桶限流，超额 fail-closed 返回 HTTP 429。

**Architecture:** 新增聚焦包 `internal/ratelimit`（per-key 令牌桶 `Limiter`，并发安全，配置按调用传入，仿 `policy.SpendTracker`）；`policy.Config` 增 `RatePerSec`/`RateBurst` 两字段（0=禁用）；`handleSignL1` 在 key 解析成功后、`Evaluate` 之前插入限流闸门，`Limiter` 在 `newMux` 内部构造（公开签名不变，测试零 churn）。

**Tech Stack:** Go 1.26、stdlib（sync/math/time）。无新依赖。

**Module path:** `github.com/lumos-forge/hypersolid/backend`

---

## File Structure

- `backend/internal/ratelimit/ratelimit.go` —（新）`Limiter`、`bucket`、`New`、`Allow` 令牌桶 + fail-closed。
- `backend/internal/ratelimit/ratelimit_test.go` —（新）令牌桶行为 + fail-closed + 并发测试。
- `backend/internal/policy/policy.go` — `Config` 增 `RatePerSec`/`RateBurst` 字段。
- `backend/internal/policy/policy_test.go` — 断言新字段默认 0 且不影响 `Evaluate`。
- `backend/cmd/signer/main.go` — `handleSignL1` 加 `limiter` 参数 + 闸门；`cfg` 上移；`newMux` 内构造 `ratelimit.New(nowMs)` 传入。
- `backend/cmd/signer/main_test.go` — 429 突发耗尽 + rate=0 不限 + 未知 key 仍 404 测试。

---

## Task 1: `internal/ratelimit` 令牌桶 Limiter

**Files:**
- Create: `backend/internal/ratelimit/ratelimit.go`
- Create: `backend/internal/ratelimit/ratelimit_test.go`

依赖：无。

- [ ] **Step 1: 写失败测试 `backend/internal/ratelimit/ratelimit_test.go`**

```go
package ratelimit

import (
	"math"
	"sync"
	"testing"
)

// fakeClock is a mutable millisecond clock for deterministic refill tests.
type fakeClock struct{ ms int64 }

func (c *fakeClock) now() int64 { return c.ms }

func TestAllowFullBucketThenExhausts(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	// burst=3 → first 3 allowed, 4th denied (no time passes → no refill).
	for i := 0; i < 3; i++ {
		if !l.Allow("k", 1, 3) {
			t.Fatalf("request %d should be allowed (full bucket)", i+1)
		}
	}
	if l.Allow("k", 1, 3) {
		t.Fatalf("4th request should be denied (bucket empty)")
	}
}

func TestAllowRefillsOverTime(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	for i := 0; i < 3; i++ {
		l.Allow("k", 2, 3) // drain the 3-token bucket
	}
	if l.Allow("k", 2, 3) {
		t.Fatalf("bucket should be empty before refill")
	}
	clk.ms += 1_000 // 1s at 2 tok/s → +2 tokens
	if !l.Allow("k", 2, 3) {
		t.Fatalf("should allow after 1s refill (1st token)")
	}
	if !l.Allow("k", 2, 3) {
		t.Fatalf("should allow after 1s refill (2nd token)")
	}
	if l.Allow("k", 2, 3) {
		t.Fatalf("only 2 tokens refilled → 3rd denied")
	}
}

func TestRefillCappedAtBurst(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	l.Allow("k", 1, 2) // create bucket (starts full=2), consume 1 → 1 left
	clk.ms += 1_000_000 // huge idle → refill would overflow, must cap at burst=2
	if !l.Allow("k", 1, 2) {
		t.Fatalf("token 1 after idle")
	}
	if !l.Allow("k", 1, 2) {
		t.Fatalf("token 2 after idle (capped at burst=2)")
	}
	if l.Allow("k", 1, 2) {
		t.Fatalf("3rd denied — refill must be capped at burst")
	}
}

func TestDisabledAllowsAndDoesNotAllocate(t *testing.T) {
	clk := &fakeClock{ms: 1_000}
	l := New(clk.now)
	for i := 0; i < 100; i++ {
		if !l.Allow("k", 0, 0) {
			t.Fatalf("ratePerSec=0 must always allow (disabled)")
		}
	}
	if len(l.buckets) != 0 {
		t.Fatalf("disabled key must not allocate a bucket, got %d", len(l.buckets))
	}
}

func TestFailClosedOnMisconfig(t *testing.T) {
	l := New((&fakeClock{ms: 1}).now)
	if l.Allow("k", -1, 5) {
		t.Fatalf("negative rate must deny (fail-closed)")
	}
	if l.Allow("k", 5, 0) {
		t.Fatalf("rate>0 with burst<=0 must deny (fail-closed)")
	}
	if l.Allow("k", math.NaN(), 5) {
		t.Fatalf("NaN rate must deny")
	}
	if l.Allow("k", 5, math.Inf(1)) {
		t.Fatalf("Inf burst must deny")
	}
	if len(l.buckets) != 0 {
		t.Fatalf("fail-closed paths must not allocate buckets, got %d", len(l.buckets))
	}
}

func TestClockRollbackNoNegativeRefill(t *testing.T) {
	clk := &fakeClock{ms: 10_000}
	l := New(clk.now)
	l.Allow("k", 1, 2) // full=2 → 1 left, lastMs=10_000
	clk.ms = 5_000     // clock moved backwards
	if !l.Allow("k", 1, 2) {
		t.Fatalf("rollback must not lose the remaining token")
	}
	if l.Allow("k", 1, 2) {
		t.Fatalf("rollback must not add negative/extra tokens beyond what remained")
	}
}

func TestAllowConcurrent(t *testing.T) {
	l := New((&fakeClock{ms: 1}).now)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				l.Allow("k", 10, 10)
			}
		}()
	}
	wg.Wait() // -race asserts no data race
}
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./internal/ratelimit/`
Expected: 编译失败（`New`/`Allow`/`Limiter.buckets` 未定义）。

- [ ] **Step 3: 写实现 `backend/internal/ratelimit/ratelimit.go`**

```go
// Package ratelimit provides a per-key token-bucket rate limiter for the signing
// boundary. Config (ratePerSec, burst) is supplied per call — mirroring
// policy.SpendTracker.Charge — so the limiter holds only bucket state, not policy.
// It is fail-closed: misconfiguration or a NaN/Inf parameter denies the request.
// Safe for concurrent use.
package ratelimit

import (
	"math"
	"sync"
	"time"
)

type bucket struct {
	tokens float64 // available tokens (fractional)
	lastMs int64   // last refill timestamp (ms)
}

// Limiter enforces a per-key token-bucket budget.
type Limiter struct {
	nowMs   func() int64
	mu      sync.Mutex
	buckets map[string]bucket
}

// New returns a Limiter. If nowMs is nil, it uses the real clock
// (time.Now().UnixMilli()); tests inject a fake clock.
func New(nowMs func() int64) *Limiter {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &Limiter{nowMs: nowMs, buckets: make(map[string]bucket)}
}

// Allow atomically charges one token against keyID's bucket, refilling by elapsed
// time at ratePerSec (capped at burst). It returns true when a token was consumed.
//
// Config semantics (fail-closed):
//   - ratePerSec == 0: limiting disabled → always true, without allocating a bucket.
//   - ratePerSec < 0, or (ratePerSec > 0 and burst <= 0), or NaN/Inf on either:
//     misconfiguration → false, without allocating a bucket.
//   - ratePerSec > 0 and burst > 0: active token bucket. A first-seen key starts
//     full (tokens = burst).
func (l *Limiter) Allow(keyID string, ratePerSec, burst float64) bool {
	// Fail closed on non-finite parameters: they would corrupt the bucket math.
	if math.IsNaN(ratePerSec) || math.IsInf(ratePerSec, 0) ||
		math.IsNaN(burst) || math.IsInf(burst, 0) {
		return false
	}
	if ratePerSec < 0 {
		return false // negative rate is a misconfiguration → deny
	}
	if ratePerSec == 0 {
		return true // disabled: no limit, no bucket allocation
	}
	if burst <= 0 {
		return false // rate>0 requires a positive burst; otherwise deny
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.nowMs()
	b, ok := l.buckets[keyID]
	if !ok {
		b = bucket{tokens: burst, lastMs: now} // first-seen key starts full
	} else {
		if elapsed := now - b.lastMs; elapsed > 0 {
			b.tokens += float64(elapsed) / 1000.0 * ratePerSec
			if b.tokens > burst {
				b.tokens = burst
			}
		}
		b.lastMs = now
	}
	if b.tokens >= 1 {
		b.tokens -= 1
		l.buckets[keyID] = b
		return true
	}
	l.buckets[keyID] = b
	return false
}
```

- [ ] **Step 4: 运行确认 PASS + vet + race**

Run: `cd backend && go test ./internal/ratelimit/ -count=1 && go vet ./internal/ratelimit/ && go test -race ./internal/ratelimit/`
Expected: 全部 PASS，race 干净。

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ratelimit/ratelimit.go backend/internal/ratelimit/ratelimit_test.go
git commit --no-verify -m "feat(ratelimit): per-key token-bucket limiter (fail-closed)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `policy.Config` 新增限流字段

**Files:**
- Modify: `backend/internal/policy/policy.go`
- Test: `backend/internal/policy/policy_test.go`

依赖：无（与 Task 1 独立）。

### 背景（当前 Config，policy.go:16-23）
```go
type Config struct {
	AllowedKinds         map[string]bool
	KillSwitch           bool
	MaxNotionalUsdc      float64
	PerCoinMaxUsdc       map[string]float64
	DailyMaxNotionalUsdc float64
}
```

- [ ] **Step 1: 写失败测试到 `backend/internal/policy/policy_test.go`**

在文件末尾追加：
```go
func TestConfigRateFieldsDefaultZeroAndIgnoredByEvaluate(t *testing.T) {
	// New rate fields default to 0 (disabled) and must NOT affect the pure Evaluate.
	cfg := Config{
		AllowedKinds: map[string]bool{"order": true},
	}
	if cfg.RatePerSec != 0 || cfg.RateBurst != 0 {
		t.Fatalf("rate fields must default to 0, got rate=%v burst=%v", cfg.RatePerSec, cfg.RateBurst)
	}
	// Setting them does not change the allow decision (Evaluate ignores rate).
	cfg.RatePerSec = 5
	cfg.RateBurst = 10
	d := Evaluate(Intent{Kind: "order", NotionalUsdc: 0}, cfg)
	if !d.Allow {
		t.Fatalf("Evaluate must ignore rate fields; got deny: %s", d.Reason)
	}
}
```

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./internal/policy/ -run TestConfigRateFields`
Expected: 编译失败（`RatePerSec`/`RateBurst` 未定义）。

- [ ] **Step 3: 给 `Config` 加两字段（policy.go）**

把：
```go
	DailyMaxNotionalUsdc float64            // per-key daily notional cap; 0 = no daily limit (enforced by SpendTracker, not Evaluate)
}
```
改为：
```go
	DailyMaxNotionalUsdc float64            // per-key daily notional cap; 0 = no daily limit (enforced by SpendTracker, not Evaluate)
	RatePerSec           float64            // per-key sustained sign rate (tokens/sec); 0 = no rate limit (enforced by ratelimit.Limiter, not Evaluate)
	RateBurst            float64            // token-bucket capacity (max burst); paired with RatePerSec
}
```

- [ ] **Step 4: 运行确认 PASS + vet**

Run: `cd backend && go test ./internal/policy/ -count=1 && go vet ./internal/policy/`
Expected: 全部 PASS（含既有策略测试不受影响）。

- [ ] **Step 5: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/policy/policy.go backend/internal/policy/policy_test.go
git commit --no-verify -m "feat(policy): add per-key RatePerSec/RateBurst config fields

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: signer 限流闸门装配

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

依赖：Task 1（`ratelimit.Limiter`）+ Task 2（`policy.Config.RatePerSec/RateBurst`）。

### 背景（当前代码）
`handleSignL1` 头（main.go:200）：
```go
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64) http.HandlerFunc {
```
key 解析 + policy 段（main.go:211-221）：
```go
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
```
`newMux`（main.go:398）构造 sign 路由（main.go:405）：
```go
	mux.HandleFunc("/v1/sign/l1", metrics.Middleware("sign_l1", handleSignL1(ks, policies, led, fencer, nowMs)))
```
`main.go` 已 import `internal/policy`、`internal/keystore`、`internal/ledger`、`internal/metrics`。需新增 import `internal/ratelimit`。`main_test.go` 头部 helper（line 32-34）：
```go
func leaderMux(...) http.Handler {  // 具体签名以文件为准
	return newMux(ks, policies, ledger.NewMem(), constFencer{epoch: 1, leader: true}, nowMs)
}
```

- [ ] **Step 1: 写失败测试到 `backend/cmd/signer/main_test.go`**

在文件末尾追加以下三个测试。它们复用文件中既有 sign 测试的确切 API：`ks.Add(id, 32字节私钥)` 注册 key（见 main_test.go:540 `ks.Add("k1", bytes.Repeat([]byte{0x11}, 32))`），以及 `order` kind 的请求体形状（见 main_test.go:555）。`bytes`/`strings`/`net/http`/`httptest`/`constFencer` 均已在文件中可用。

```go
// signOrderBody builds a well-formed order sign request for key k1 with cloid.
func signOrderBody(cloid string) string {
	return `{"keyId":"k1","cloid":"` + cloid + `","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
}

func TestSignRateLimitReturns429(t *testing.T) {
	ks := keystore.New()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add key: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{
		AllowedKinds:    map[string]bool{"order": true},
		MaxNotionalUsdc: 1e12,
		RatePerSec:      1,
		RateBurst:       2, // 突发 2 → 固定时钟下第 3 个必 429
	})
	srv := httptest.NewServer(newMux(ks, policies, ledger.NewMem(), constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 }))
	defer srv.Close()

	post := func(cloid string) int {
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(signOrderBody(cloid)))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	// 固定时钟 → 无 refill。前 2 个消耗满桶（通过限流层，不是 429），第 3 个被限流。
	if c := post("c1"); c == http.StatusTooManyRequests {
		t.Fatalf("1st request unexpectedly 429")
	}
	if c := post("c2"); c == http.StatusTooManyRequests {
		t.Fatalf("2nd request unexpectedly 429")
	}
	if c := post("c3"); c != http.StatusTooManyRequests {
		t.Fatalf("3rd sign status = %d, want 429 (rate limit)", c)
	}
}

func TestSignRateDisabledNotThrottled(t *testing.T) {
	ks := keystore.New()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add key: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{
		AllowedKinds:    map[string]bool{"order": true},
		MaxNotionalUsdc: 1e12,
		// RatePerSec 默认 0 → 禁用限流。
	})
	srv := httptest.NewServer(newMux(ks, policies, ledger.NewMem(), constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 }))
	defer srv.Close()

	for i := 0; i < 10; i++ {
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(signOrderBody("d"+string(rune('0'+i)))))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		code := res.StatusCode
		res.Body.Close()
		if code == http.StatusTooManyRequests {
			t.Fatalf("request %d got 429 but rate limiting is disabled", i+1)
		}
	}
}

func TestSignUnknownKeyNotRateLimited(t *testing.T) {
	// Unknown key → 404 before the limiter (no bucket allocation for random keyIDs).
	srv := httptest.NewServer(newMux(keystore.New(), policy.NewStore(), ledger.NewMem(), constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 }))
	defer srv.Close()
	body := `{"keyId":"nope","cloid":"x","kind":"order","params":{"asset":0,"isBuy":true,"px":"1","sz":"1","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown key status = %d, want 404", res.StatusCode)
	}
}
```

> 说明：三个测试用互不相同的 cloid（c1/c2/c3、d0..d9、x）避免 cloid-reuse 干扰；限流闸门在 `Evaluate`/Authorize 之前，故前两个请求经限流后的最终 code（200/其它）与本测试无关——只断言「前两个非 429、第三个 429」。若实施者发现文件中已有等价的 order-body helper，可复用之而非新增 `signOrderBody`。

- [ ] **Step 2: 运行确认 FAIL**

Run: `cd backend && go test ./cmd/signer/ -run 'TestSignRate|TestSignUnknownKeyNotRateLimited'`
Expected: `TestSignRateLimitReturns429` FAIL（当前无限流，第 3 个不会 429）。另两个可能已 PASS（未知 key 已 404、rate=0 天然不限）——正常；关键红灯是 429 测试。

- [ ] **Step 3: 加 import + 改 `handleSignL1` 签名与闸门（main.go）**

(a) 在 import 块加入（保持 internal 分组字母序，`ratelimit` 在 `policy` 之后、`reconciler` 之前）：
```go
	"github.com/lumos-forge/hypersolid/backend/internal/ratelimit"
```

(b) 改 `handleSignL1` 签名，加 `limiter *ratelimit.Limiter`：
```go
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64, limiter *ratelimit.Limiter) http.HandlerFunc {
```

(c) 把 key 解析 + policy 段（main.go:211-221）替换为（`cfg` 上移到闸门之前，闸门插入）：
```go
		signer, ok := ks.Signer(req.KeyID)
		if !ok {
			writeErr(w, http.StatusNotFound, "unknown keyId")
			return
		}
		cfg := policies.Get(req.KeyID)
		if !limiter.Allow(req.KeyID, cfg.RatePerSec, cfg.RateBurst) {
			writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		intent := intentFor(req.Kind, req.Params)
		if d := policy.Evaluate(intent, cfg); !d.Allow {
			writeErr(w, http.StatusForbidden, d.Reason)
			return
		}
```

- [ ] **Step 4: 在 `newMux` 内构造 limiter 并传入（main.go:398-405）**

把 `newMux` 里的 sign 路由行（main.go:405）：
```go
	mux.HandleFunc("/v1/sign/l1", metrics.Middleware("sign_l1", handleSignL1(ks, policies, led, fencer, nowMs)))
```
替换为（在 `mux.HandleFunc("/healthz", ...)` 之后、sign 路由之前构造一次 limiter）：
```go
	limiter := ratelimit.New(nowMs)
	mux.HandleFunc("/v1/sign/l1", metrics.Middleware("sign_l1", handleSignL1(ks, policies, led, fencer, nowMs, limiter)))
```
> `newMux` 的公开签名保持不变——所有既有 `newMux(...)` 调用点（含 6 处测试）零改动。

- [ ] **Step 5: 运行确认 PASS + signer 全套件 + vet**

Run: `cd backend && go test ./cmd/signer/ -count=1 && go vet ./cmd/signer/`
Expected: 三个新测试 + 既有全部 PASS。若既有直连 `handleSignL1` 的测试存在（应无——它只在 newMux 内调用），据实对齐。

- [ ] **Step 6: 全量后端门禁**

Run:
```bash
cd backend
go test ./...
go vet ./...
go test -race ./internal/... ./cmd/...
go build ./cmd/signer && rm -f signer
go test -c -tags=integration -o /dev/null ./...
```
Expected: 全部 PASS/编译通过。

- [ ] **Step 7: 提交（不 push）**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): per-key rate limit on /v1/sign/l1 (429, M10-rate)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 验证门禁（最终）

```bash
cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer
go test -c -tags=integration -o /dev/null ./...
```

既有测试基线必须保持绿；新增限流覆盖令牌桶行为 + fail-closed + 429 端到端。
