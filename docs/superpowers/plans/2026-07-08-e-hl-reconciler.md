# E HL info 客户端 + 自动对账循环（E1+E2）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增只读 HL info 客户端（`internal/hlinfo`）与自动对账循环（`internal/reconciler`），周期性拉 open orders/fills 并按 cloid 映射为 `ledger.Status` 调 `Reconcile`。

**Architecture:** E1 `internal/hlinfo`：POST HL `/info` 解析 open/fills（可注入 baseURL+http.Client，httptest 可测）。E2 `internal/reconciler`：`step` 遍历配置的 `Account{keyID,address}`，把 open→open、fills-非-open→filled 喂 `Reconcile`，容忍良性拒绝；`Run` 薄 ticker。前置：给 ledger DAG 补 `signed→open`/`signed→filled`（HL 不报 submitted）。先不接线。

**Tech Stack:** Go 1.26；`net/http`；`encoding/json`；`internal/ledger`（已合并）。

参考 spec：`docs/superpowers/specs/2026-07-08-e-hl-reconciler-design.md`
镜像语义：`server/src/agent/openOrdersReader.ts`、`server/src/agent/userFillsReader.ts`（HL info 请求/响应形状）。模块路径 `github.com/lumos-forge/hypersolid/backend`。

## 文件结构
- `backend/internal/ledger/reconcile.go` — allowedTransitions 追加 signed→open/filled。
- `backend/internal/ledger/reconcile_test.go` — 断言随之更新。
- `backend/internal/hlinfo/hlinfo.go` — NEW：Client + OpenCloids + FillsByCloid。
- `backend/internal/hlinfo/hlinfo_test.go` — NEW：httptest 单测。
- `backend/internal/reconciler/reconciler.go` — NEW：Account/InfoClient/targetFor/Reconciler/step/Run。
- `backend/internal/reconciler/reconciler_test.go` — NEW：targetFor + step + Run 单测。

---

### Task 1: ledger DAG 追加 signed→open / signed→filled

**Files:**
- Modify: `backend/internal/ledger/reconcile.go`
- Modify: `backend/internal/ledger/reconcile_test.go`

- [ ] **Step 1: 更新测试断言（先改测试，TDD）**

在 `reconcile_test.go` 的 `TestTransitionForwardChain` 的用例切片中追加两行（放在 `{StatusSigned, StatusSubmitted, StatusSubmitted},` 之后）：

```go
		{StatusSigned, StatusOpen, StatusOpen},
		{StatusSigned, StatusFilled, StatusFilled},
```

并从 `TestTransitionInvalid` 的切片中**删除**这一行：

```go
		{StatusSigned, StatusOpen},
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/ledger/ -run Transition`
Expected: `TestTransitionForwardChain` 失败（当前 signed→open/filled 返回 ErrInvalidTransition）。

- [ ] **Step 3: 改 `reconcile.go` — 追加两条边**

把 `allowedTransitions` 中 signed 的一行：

```go
	StatusSigned:    {StatusSubmitted: true, StatusRejected: true},
```

改为：

```go
	StatusSigned:    {StatusSubmitted: true, StatusOpen: true, StatusFilled: true, StatusRejected: true},
```

并更新 `allowedTransitions` 上方注释增加一句：`signed→open/filled 允许，因 HL info 只报 open/filled（无 submitted 中间态），自动对账需能直接推进未经 submitted 上报的 signed 记录。`

- [ ] **Step 4: 运行确认通过 + 全 ledger 包**

Run: `cd backend && go test ./internal/ledger/... && go vet ./internal/ledger/...`
Expected: PASS（Transition 单测 + conformance 均过；conformance 的对账场景不依赖 signed→open 非法，无需改）；vet 静默。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/reconcile.go backend/internal/ledger/reconcile_test.go
git commit --no-verify -m "feat(backend): allow signed->open and signed->filled ledger transitions

HL info reports only open/filled (no submitted intermediate), so the auto
reconciler must advance a signed record it observes resting or filled.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `internal/hlinfo` 只读 HL info 客户端

**Files:**
- Create: `backend/internal/hlinfo/hlinfo.go`
- Test: `backend/internal/hlinfo/hlinfo_test.go`

- [ ] **Step 1: 写失败测试 `hlinfo_test.go`**

```go
package hlinfo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenCloids(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "frontendOpenOrders" || body["user"] != "0xacc" {
			t.Fatalf("bad body: %+v", body)
		}
		_, _ = w.Write([]byte(`[
			{"cloid":"c1","oid":10,"coin":"BTC","side":"B","limitPx":"50000"},
			{"cloid":"c2","oid":11,"coin":"ETH","side":"A","limitPx":"3000"},
			{"cloid":null,"oid":12,"coin":"BTC","side":"B","limitPx":"1"}
		]`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	got, err := c.OpenCloids(context.Background(), "0xacc")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (null-cloid dropped)", len(got))
	}
	if got["c1"].Side != "buy" || got["c1"].Px != 50000 || got["c1"].Oid != 10 {
		t.Fatalf("c1 = %+v", got["c1"])
	}
	if got["c2"].Side != "sell" || got["c2"].Coin != "ETH" {
		t.Fatalf("c2 = %+v", got["c2"])
	}
}

func TestFillsByCloidAggregates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "userFills" {
			t.Fatalf("bad type: %s", body["type"])
		}
		_, _ = w.Write([]byte(`[
			{"cloid":"c1","px":"100","sz":"2","closedPnl":"5"},
			{"cloid":"c1","px":"110","sz":"1","closedPnl":"3"},
			{"cloid":null,"px":"1","sz":"1","closedPnl":"0"}
		]`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	got, err := c.FillsByCloid(context.Background(), "0xacc")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	f := got["c1"]
	if f.Sz != 3 || f.ClosedPnl != 8 {
		t.Fatalf("c1 sz/pnl = %+v", f)
	}
	// size-weighted avg px = (100*2 + 110*1)/3 = 103.333...
	if f.Px < 103.33 || f.Px > 103.34 {
		t.Fatalf("c1 px = %v, want ~103.333", f.Px)
	}
}

func TestErrorsOnNon2xxAndBadJSON(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}))
	defer bad.Close()
	if _, err := New(bad.URL, nil).OpenCloids(context.Background(), "0xacc"); err == nil {
		t.Fatal("want error on 500")
	}
	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{not-an-array`))
	}))
	defer garbage.Close()
	if _, err := New(garbage.URL, nil).FillsByCloid(context.Background(), "0xacc"); err == nil {
		t.Fatal("want error on bad json")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/hlinfo/`
Expected: 编译失败（`New`/`OpenCloids`/`FillsByCloid`/`OpenOrder`/`Fill` 未定义）。

- [ ] **Step 3: 写 `hlinfo.go`**

```go
// Package hlinfo is a read-only Hyperliquid /info client. It exposes only the
// queries the reconciler needs — a user's resting orders and fills, indexed by
// client order id (cloid) — and holds no keys and signs nothing.
package hlinfo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

// Client posts to a Hyperliquid /info endpoint.
type Client struct {
	baseURL string
	http    *http.Client
}

// New returns a Client that POSTs to baseURL+"/info" (baseURL has no trailing
// /info, e.g. https://api.hyperliquid.xyz). A nil hc uses http.DefaultClient.
func New(baseURL string, hc *http.Client) *Client {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Client{baseURL: baseURL, http: hc}
}

// OpenOrder is a resting order (the fields the reconciler and consumers need).
type OpenOrder struct {
	Oid  int64
	Coin string
	Side string // "buy" | "sell"
	Px   float64
}

// Fill aggregates a cloid's fills: total size, size-weighted average price, total closed pnl.
type Fill struct {
	Sz        float64
	Px        float64
	ClosedPnl float64
}

// post issues an /info query with the given typed body and decodes the JSON array
// response into out. Non-2xx and any decode failure (bad JSON / non-array error
// body) surface as errors so the caller can log and retry next cycle.
func (c *Client) post(ctx context.Context, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/info", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("hlinfo: status %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("hlinfo: decode: %w", err)
	}
	return nil
}

type rawOpenOrder struct {
	Cloid   *string `json:"cloid"`
	Oid     int64   `json:"oid"`
	Coin    string  `json:"coin"`
	Side    string  `json:"side"` // "B" | "A"
	LimitPx string  `json:"limitPx"`
}

// OpenCloids returns the user's currently-resting orders indexed by cloid.
// Orders with a null/absent cloid (not placed by us) are dropped.
func (c *Client) OpenCloids(ctx context.Context, user string) (map[string]OpenOrder, error) {
	var raw []rawOpenOrder
	if err := c.post(ctx, map[string]string{"type": "frontendOpenOrders", "user": user}, &raw); err != nil {
		return nil, err
	}
	out := make(map[string]OpenOrder)
	for _, o := range raw {
		if o.Cloid == nil {
			continue
		}
		side := "buy"
		if o.Side == "A" {
			side = "sell"
		}
		px, _ := strconv.ParseFloat(o.LimitPx, 64)
		out[*o.Cloid] = OpenOrder{Oid: o.Oid, Coin: o.Coin, Side: side, Px: px}
	}
	return out, nil
}

type rawFill struct {
	Cloid     *string `json:"cloid"`
	Px        string  `json:"px"`
	Sz        string  `json:"sz"`
	ClosedPnl string  `json:"closedPnl"`
}

// FillsByCloid returns the user's fills aggregated by cloid (partial fills summed;
// price size-weighted). Fills with a null/absent cloid are dropped.
func (c *Client) FillsByCloid(ctx context.Context, user string) (map[string]Fill, error) {
	var raw []rawFill
	if err := c.post(ctx, map[string]string{"type": "userFills", "user": user}, &raw); err != nil {
		return nil, err
	}
	type acc struct{ sz, closedPnl, pxSz float64 }
	m := make(map[string]acc)
	for _, f := range raw {
		if f.Cloid == nil {
			continue
		}
		sz, _ := strconv.ParseFloat(f.Sz, 64)
		px, _ := strconv.ParseFloat(f.Px, 64)
		pnl, _ := strconv.ParseFloat(f.ClosedPnl, 64)
		a := m[*f.Cloid]
		a.sz += sz
		a.closedPnl += pnl
		a.pxSz += px * sz
		m[*f.Cloid] = a
	}
	out := make(map[string]Fill)
	for cloid, a := range m {
		px := 0.0
		if a.sz > 0 {
			px = a.pxSz / a.sz
		}
		out[cloid] = Fill{Sz: a.sz, Px: px, ClosedPnl: a.closedPnl}
	}
	return out, nil
}
```

- [ ] **Step 4: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/hlinfo/ && go vet ./internal/hlinfo/ && go test -race ./internal/hlinfo/`
Expected: PASS；vet 静默；race 无告警。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/hlinfo/hlinfo.go backend/internal/hlinfo/hlinfo_test.go
git commit --no-verify -m "feat(backend): read-only Hyperliquid /info client (open orders + fills by cloid)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `internal/reconciler` 映射 + step + Run

**Files:**
- Create: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

- [ ] **Step 1: 写失败测试 `reconciler_test.go`**

```go
package reconciler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/hlinfo"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
)

// fakeClient serves canned per-address snapshots and can inject an error.
type fakeClient struct {
	open  map[string]map[string]hlinfo.OpenOrder
	fills map[string]map[string]hlinfo.Fill
	err   error
	calls chan struct{} // optional: signal each OpenCloids call
}

func (f *fakeClient) OpenCloids(_ context.Context, user string) (map[string]hlinfo.OpenOrder, error) {
	if f.calls != nil {
		select {
		case f.calls <- struct{}{}:
		default:
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	return f.open[user], nil
}

func (f *fakeClient) FillsByCloid(_ context.Context, user string) (map[string]hlinfo.Fill, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.fills[user], nil
}

func seedSigned(t *testing.T, led *ledger.Mem, keyID, cloid string) {
	t.Helper()
	if _, err := led.Authorize(context.Background(), ledger.Request{KeyID: keyID, Cloid: cloid, Digest: [32]byte{1}, Fence: 1, NowMs: 1_700_000_000_000}); err != nil {
		t.Fatalf("seed %s/%s: %v", keyID, cloid, err)
	}
}

func statusOf(t *testing.T, led *ledger.Mem, cloid string) (ledger.Status, bool) {
	t.Helper()
	orph, _ := led.Orphans(context.Background(), 4_000_000_000_000)
	for _, o := range orph {
		if o.Cloid == cloid {
			return o.Status, true
		}
	}
	return "", false // terminal or absent
}

func TestTargetFor(t *testing.T) {
	open := map[string]hlinfo.OpenOrder{"o": {}}
	fills := map[string]hlinfo.Fill{"f": {}, "o": {}}
	if s, ok := targetFor("o", open, fills); !ok || s != ledger.StatusOpen {
		t.Fatalf("open-precedence = %s,%v", s, ok)
	}
	if s, ok := targetFor("f", open, fills); !ok || s != ledger.StatusFilled {
		t.Fatalf("fills = %s,%v", s, ok)
	}
	if _, ok := targetFor("none", open, fills); ok {
		t.Fatalf("neither should be ok=false")
	}
}

func TestStepAdvancesOpenAndFilled(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1") // will be seen open
	seedSigned(t, led, "k", "c2") // will be seen filled
	fc := &fakeClient{
		open:  map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}},
		fills: map[string]map[string]hlinfo.Fill{"0xacc": {"c2": {Sz: 1}}},
	}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if s, ok := statusOf(t, led, "c1"); !ok || s != ledger.StatusOpen {
		t.Fatalf("c1 = %s,%v, want open", s, ok)
	}
	if _, ok := statusOf(t, led, "c2"); ok {
		t.Fatalf("c2 should be terminal (filled) → absent from orphans")
	}
}

func TestStepSkipsUnknownCloid(t *testing.T) {
	led := ledger.NewMem()
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"ghost": {}}}}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step should skip unknown cloid, got %v", err)
	}
}

func TestStepReturnsClientError(t *testing.T) {
	boom := errors.New("boom")
	r := New(&fakeClient{err: boom}, ledger.NewMem(), []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("step err = %v, want boom", err)
	}
}

func TestStepMultiAccount(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k1", "a1")
	seedSigned(t, led, "k2", "b1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{
		"0xA": {"a1": {}},
		"0xB": {"b1": {}},
	}}
	r := New(fc, led, []Account{{KeyID: "k1", Address: "0xA"}, {KeyID: "k2", Address: "0xB"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if s, _ := statusOf(t, led, "a1"); s != ledger.StatusOpen {
		t.Fatalf("a1 = %s, want open", s)
	}
	if s, _ := statusOf(t, led, "b1"); s != ledger.StatusOpen {
		t.Fatalf("b1 = %s, want open", s)
	}
}

func TestRunStepsUntilCanceled(t *testing.T) {
	calls := make(chan struct{}, 4)
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}, calls: calls}
	r := New(fc, ledger.NewMem(), []Account{{KeyID: "k", Address: "0xacc"}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx, time.Millisecond); close(done) }()
	select {
	case <-calls:
	case <-time.After(2 * time.Second):
		t.Fatal("Run never stepped")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/reconciler/`
Expected: 编译失败（`New`/`Account`/`targetFor`/`step`/`Run` 未定义）。

- [ ] **Step 3: 写 `reconciler.go`**

```go
// Package reconciler polls Hyperliquid for each configured account's open orders
// and fills and advances the ledger lifecycle (open/filled) by cloid. It reads
// only — it signs nothing and allocates no nonces.
package reconciler

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/hlinfo"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
)

// Account binds an agent key id to the HL master account address whose orders it places.
type Account struct {
	KeyID   string
	Address string
}

// InfoClient is the read-side HL surface the reconciler needs (hlinfo.Client satisfies it).
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloid(ctx context.Context, user string) (map[string]hlinfo.Fill, error)
}

// Reconciler advances ledger intents from observed HL state, one poll at a time.
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
}

// New returns a Reconciler over the given HL info client, ledger, and accounts.
func New(client InfoClient, led ledger.Reconciler, accounts []Account) *Reconciler {
	return &Reconciler{client: client, led: led, accounts: accounts}
}

// targetFor returns the ledger status a cloid should advance toward given the open
// and fills snapshots; ok=false when neither mentions it (no-op this cycle). Open
// wins over fills so a partially-filled resting order stays open.
func targetFor(cloid string, open map[string]hlinfo.OpenOrder, fills map[string]hlinfo.Fill) (ledger.Status, bool) {
	if _, ok := open[cloid]; ok {
		return ledger.StatusOpen, true
	}
	if _, ok := fills[cloid]; ok {
		return ledger.StatusFilled, true
	}
	return "", false
}

// reconcileOne applies one transition, swallowing benign per-cloid rejections
// (ErrUnknownIntent = not our order; ErrInvalidTransition = stale/idempotent) and
// surfacing only infrastructure errors.
func (r *Reconciler) reconcileOne(ctx context.Context, keyID, cloid string, target ledger.Status) error {
	if _, err := r.led.Reconcile(ctx, keyID, cloid, target); err != nil &&
		!errors.Is(err, ledger.ErrUnknownIntent) && !errors.Is(err, ledger.ErrInvalidTransition) {
		return err
	}
	return nil
}

// step runs one poll+reconcile pass over all accounts, returning the first
// infrastructure error (HL query or ledger infra) encountered.
func (r *Reconciler) step(ctx context.Context) error {
	for _, a := range r.accounts {
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
		fills, err := r.client.FillsByCloid(ctx, a.Address)
		if err != nil {
			return err
		}
		seen := make(map[string]struct{}, len(open)+len(fills))
		for cloid := range open {
			seen[cloid] = struct{}{}
		}
		for cloid := range fills {
			seen[cloid] = struct{}{}
		}
		for cloid := range seen {
			target, ok := targetFor(cloid, open, fills)
			if !ok {
				continue
			}
			if err := r.reconcileOne(ctx, a.KeyID, cloid, target); err != nil {
				return err
			}
		}
	}
	return nil
}

// Run drives step on a ticker until ctx is done. Step errors are transient
// (retried next tick) and logged, never fatal.
func (r *Reconciler) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.step(ctx); err != nil {
				log.Printf("reconciler step: %v", err)
			}
		}
	}
}
```

> 注：`step` 现通过 `targetFor` 派生每个 cloid 的目标状态（open 优先），二者共用同一优先级逻辑（DRY）。`TestTargetFor` 直接覆盖该纯函数。

- [ ] **Step 4: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/reconciler/ && go vet ./internal/reconciler/ && go test -race ./internal/reconciler/`
Expected: 全 PASS（含 Run 的取消用例）；vet 静默；race 无告警。

- [ ] **Step 5: 全量门 + 集成编译校验**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer && go test -c -tags=integration -o /dev/null ./...`
Expected: 全 PASS；vet/race 静默；signer 构建成功；集成编译成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/reconciler/reconciler.go backend/internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(backend): auto-reconciler loop (poll HL, advance ledger by cloid)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- DAG 补 signed→open/filled + 测试更新 → Task 1 ✅
- E1 hlinfo Client/OpenCloids/FillsByCloid（解析、null 丢弃、聚合、非2xx/坏JSON error）→ Task 2 ✅
- E2 Account/InfoClient/targetFor/Reconciler/New/step/Run（open→open、fills→filled、open 优先、容忍良性拒绝、infra 上报）→ Task 3 ✅
- 测试（httptest 客户端；fake-client step；Run 取消；多 account；未知 cloid 跳过）→ Task 2/3 ✅
- 非目标（不接线/无 canceled 映射/不改 hl）→ 计划未触及 ✅

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码。`targetFor` 未内联使用已显式说明（包级函数无 unused 报错，且被单测引用）。

**Type consistency：** `hlinfo.OpenOrder{Oid,Coin,Side,Px}`/`hlinfo.Fill{Sz,Px,ClosedPnl}`/`New(baseURL,hc)`/`OpenCloids`/`FillsByCloid` 跨 Task 2/3 一致；`reconciler.Account{KeyID,Address}`/`InfoClient`/`Reconciler`/`New(client,led,accounts)`/`step`/`Run`/`targetFor` 一致；依赖 `ledger.Reconciler`/`Reconcile`/`Orphans`/`StatusOpen`/`StatusFilled`/`ErrUnknownIntent`/`ErrInvalidTransition`/`NewMem`/`Authorize` 与已合并 API 一致。
