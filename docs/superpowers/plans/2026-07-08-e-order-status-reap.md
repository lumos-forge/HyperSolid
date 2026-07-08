# E’’ orderStatus reap of canceled/rejected 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让自动对账用 HL `orderStatus`（按 cloid 权威查单）把 canceled/rejected 的缺失非终态意图 reap 到终态。

**Architecture:** 先补 DAG（signed/submitted→canceled）；E’’1 `internal/hlinfo` 加 `OrderStatus`；E’’2 `internal/reconciler` 的 `step` 对「既不在 open 也不在 fills」的非终态 cloid 查 orderStatus 并经 `reapTarget` 映射后 `Reconcile`；`unknownOid` 保留不动。

**Tech Stack:** Go 1.26；`net/http`；`internal/{hlinfo,reconciler,ledger}`（已合并）。

参考 spec：`docs/superpowers/specs/2026-07-08-e-order-status-reap-design.md`
现状：`internal/ledger/reconcile.go` `allowedTransitions`（signed:{submitted,open,filled,rejected}；submitted:{open,filled,rejected}；open:{filled,canceled,rejected}）；`internal/ledger/reconcile_test.go` `TestTransitionForwardChain`/`TestTransitionInvalid`；`cmd/signer/main_test.go` `TestReconcileInvalidTransition`（现 signed→canceled 期望 409）；`internal/hlinfo/hlinfo.go`（`post(ctx,body any,out any)` 通用解码）；`internal/reconciler/reconciler.go`（`step` 含 anchor/open/fills union；`InfoClient{OpenCloids,FillsByCloidSince}`）；`internal/reconciler/reconciler_test.go`（`fakeClient{open,fills,err,calls,lastStart}` + `OpenCloids`/`FillsByCloidSince`；`seedSigned`/`statusOf`）。HL 状态映射参照 mobile/src/lib/hyperliquid/order.ts。

## 文件结构
- `backend/internal/ledger/reconcile.go` — allowedTransitions 加 signed/submitted→canceled。
- `backend/internal/ledger/reconcile_test.go` — 断言更新。
- `backend/cmd/signer/main_test.go` — TestReconcileInvalidTransition 改用仍非法边。
- `backend/internal/hlinfo/hlinfo.go` — +OrderStatusResult +OrderStatus。
- `backend/internal/hlinfo/hlinfo_test.go` — orderStatus 单测。
- `backend/internal/reconciler/reconciler.go` — InfoClient +OrderStatus；+reapTarget；step reap。
- `backend/internal/reconciler/reconciler_test.go` — fake +OrderStatus；reapTarget + reap 单测。

---

### Task 1: DAG 补 signed→canceled / submitted→canceled

**Files:**
- Modify: `backend/internal/ledger/reconcile.go`
- Modify: `backend/internal/ledger/reconcile_test.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 更新 ledger 转移测试断言（先改测试）**

在 `reconcile_test.go` 的 `TestTransitionForwardChain` 用例切片追加两行（放在 `{StatusOpen, StatusCanceled, StatusCanceled},` 附近或末尾）：

```go
		{StatusSigned, StatusCanceled, StatusCanceled},
		{StatusSubmitted, StatusCanceled, StatusCanceled},
```

（`TestTransitionInvalid` 无需改——它不含 signed/submitted→canceled。）

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/ledger/ -run Transition`
Expected: `TestTransitionForwardChain` 失败（signed/submitted→canceled 当前返回 ErrInvalidTransition）。

- [ ] **Step 3: 改 `reconcile.go` — 追加两条边**

把 `allowedTransitions` 的 signed 与 submitted 两行改为（各加 `StatusCanceled: true`）：

```go
	StatusSigned:    {StatusSubmitted: true, StatusOpen: true, StatusFilled: true, StatusCanceled: true, StatusRejected: true},
	StatusSubmitted: {StatusOpen: true, StatusFilled: true, StatusCanceled: true, StatusRejected: true},
```

并在 `allowedTransitions` 上方注释补一句：signed/submitted→canceled 允许，因 HL orderStatus 可报一笔已被接受再取消的单为 canceled，自动对账需能直接 reap 未记录 open 中间态的记录。

- [ ] **Step 4: 运行确认通过（全 ledger 包）**

Run: `cd backend && go test ./internal/ledger/... && go vet ./internal/ledger/...`
Expected: PASS（Transition 单测 + conformance 均过；conformance 的非法场景用 submitted→signed，不受影响）；vet 静默。

- [ ] **Step 5: 改 `cmd/signer/main_test.go` — TestReconcileInvalidTransition 用仍非法边**

`signed→canceled` 现已合法，把该测试改为先驱动到终态 `filled` 再试非法 `filled→open`。整段替换 `TestReconcileInvalidTransition`：

```go
func TestReconcileInvalidTransition(t *testing.T) {
	led := ledger.NewMem()
	ctx := context.Background()
	_, _ = led.Authorize(ctx, ledger.Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000})
	// drive c1 to a terminal state so a further transition is genuinely invalid.
	if _, err := led.Reconcile(ctx, "k", "c1", ledger.StatusSubmitted); err != nil {
		t.Fatalf("->submitted: %v", err)
	}
	if _, err := led.Reconcile(ctx, "k", "c1", ledger.StatusFilled); err != nil {
		t.Fatalf("->filled: %v", err)
	}
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()
	// filled->open is not an allowed edge (terminal → non-terminal).
	res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"c1","status":"open"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("status = %d, want 409", res.StatusCode)
	}
}
```

- [ ] **Step 6: 运行确认通过 + 全量门**

Run: `cd backend && go test ./cmd/signer/ -run Reconcile && go test ./... && go vet ./...`
Expected: `TestReconcileInvalidTransition` 及全部包 PASS；vet 静默。

- [ ] **Step 7: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/reconcile.go backend/internal/ledger/reconcile_test.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): allow signed/submitted -> canceled ledger transitions

HL orderStatus can report a signed/submitted order as canceled (accepted then
canceled); the auto reconciler must reap it to terminal without the recorded open.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `internal/hlinfo` `OrderStatus`

**Files:**
- Modify: `backend/internal/hlinfo/hlinfo.go`
- Test: `backend/internal/hlinfo/hlinfo_test.go`

- [ ] **Step 1: 写失败测试（追加到 `hlinfo_test.go` 末尾）**

```go
func TestOrderStatusFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "orderStatus" || body["oid"] != "0xcloid" {
			t.Fatalf("bad body: %+v", body)
		}
		_, _ = w.Write([]byte(`{"status":"order","order":{"order":{},"status":"canceled","statusTimestamp":123}}`))
	}))
	defer srv.Close()
	got, err := New(srv.URL, nil).OrderStatus(context.Background(), "0xacc", "0xcloid")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !got.Found || got.Status != "canceled" {
		t.Fatalf("got = %+v, want {canceled true}", got)
	}
}

func TestOrderStatusUnknownOid(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"unknownOid"}`))
	}))
	defer srv.Close()
	got, err := New(srv.URL, nil).OrderStatus(context.Background(), "0xacc", "0xcloid")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.Found {
		t.Fatalf("got = %+v, want Found=false", got)
	}
}

func TestOrderStatusErrorOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()
	if _, err := New(srv.URL, nil).OrderStatus(context.Background(), "0xacc", "0xcloid"); err == nil {
		t.Fatal("want error on 500")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/hlinfo/ -run OrderStatus`
Expected: 编译失败（`OrderStatus`/`OrderStatusResult` 未定义）。

- [ ] **Step 3: 改 `hlinfo.go` — 加 OrderStatusResult + OrderStatus**

在文件中（`FillsByCloidSince` 之后）追加：

```go
// OrderStatusResult is an order's resolved status queried by cloid. Found=false
// means HL returned "unknownOid" (it has no record of this order).
type OrderStatusResult struct {
	Status string // HL order status string (e.g. "filled"/"open"/"canceled"/"marginCanceled"/"rejected"); "" if not found
	Found  bool
}

// OrderStatus queries orderStatus by cloid (passed as the oid field). A non-"order"
// envelope (e.g. "unknownOid") yields Found=false.
func (c *Client) OrderStatus(ctx context.Context, user, cloid string) (OrderStatusResult, error) {
	var resp struct {
		Status string `json:"status"`
		Order  *struct {
			Status string `json:"status"`
		} `json:"order"`
	}
	if err := c.post(ctx, map[string]any{"type": "orderStatus", "user": user, "oid": cloid}, &resp); err != nil {
		return OrderStatusResult{}, err
	}
	if resp.Status != "order" || resp.Order == nil {
		return OrderStatusResult{Found: false}, nil
	}
	return OrderStatusResult{Status: resp.Order.Status, Found: true}, nil
}
```

- [ ] **Step 4: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/hlinfo/ && go vet ./internal/hlinfo/ && go test -race ./internal/hlinfo/`
Expected: 全 PASS；vet 静默；race 无告警。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/hlinfo/hlinfo.go backend/internal/hlinfo/hlinfo_test.go
git commit --no-verify -m "feat(backend): hlinfo OrderStatus (authoritative order status by cloid)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `internal/reconciler` reap 缺失非终态意图

**Files:**
- Modify: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

- [ ] **Step 1: 改 fake + 加 reapTarget/reap 测试（`reconciler_test.go`）**

(a) 给 `fakeClient` 结构加字段 `orderStatus map[string]hlinfo.OrderStatusResult`（按 cloid）与 `statusQueried []string`（记录被查的 cloid），并加方法：

```go
func (f *fakeClient) OrderStatus(_ context.Context, _ string, cloid string) (hlinfo.OrderStatusResult, error) {
	f.statusQueried = append(f.statusQueried, cloid)
	if f.err != nil {
		return hlinfo.OrderStatusResult{}, f.err
	}
	return f.orderStatus[cloid], nil // zero value = {Found:false}
}
```
在 `fakeClient` 结构体加两个字段：`orderStatus map[string]hlinfo.OrderStatusResult` 与 `statusQueried []string`。

(b) 追加测试：

```go
func TestReapTarget(t *testing.T) {
	cases := map[string]struct {
		want ledger.Status
		ok   bool
	}{
		"canceled":       {ledger.StatusCanceled, true},
		"marginCanceled": {ledger.StatusCanceled, true},
		"scheduledCancel": {ledger.StatusCanceled, true},
		"rejected":       {ledger.StatusRejected, true},
		"tickRejected":   {ledger.StatusRejected, true},
		"filled":         {ledger.StatusFilled, true},
		"open":           {ledger.StatusOpen, true},
		"resting":        {ledger.StatusOpen, true},
		"triggered":      {ledger.StatusOpen, true},
		"weird":          {"", false},
	}
	for in, exp := range cases {
		got, ok := reapTarget(in)
		if ok != exp.ok || got != exp.want {
			t.Fatalf("reapTarget(%q) = %s,%v; want %s,%v", in, got, ok, exp.want, exp.ok)
		}
	}
}

func TestStepReapsCanceled(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{
		open:        map[string]map[string]hlinfo.OpenOrder{"0xacc": {}},
		orderStatus: map[string]hlinfo.OrderStatusResult{"c1": {Status: "canceled", Found: true}},
	}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if _, ok := statusOf(t, led, "c1"); ok {
		t.Fatalf("c1 should be terminal (canceled) → absent from orphans")
	}
}

func TestStepLeavesUnknownOid(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}} // orderStatus zero → Found=false
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if s, ok := statusOf(t, led, "c1"); !ok || s != ledger.StatusSigned {
		t.Fatalf("c1 = %s,%v, want still signed (unknownOid → leave)", s, ok)
	}
}

func TestStepSkipsOrderStatusWhenOpen(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}}}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if len(fc.statusQueried) != 0 {
		t.Fatalf("orderStatus queried %v; want none (c1 is in openOrders)", fc.statusQueried)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/reconciler/`
Expected: 编译失败（`reapTarget` 未定义；`InfoClient` 未含 `OrderStatus`——fake 有该方法但接口无、step 未调）。

- [ ] **Step 3: 改 `reconciler.go` — InfoClient + reapTarget + step reap**

(a) `import` 追加 `"strings"`。

(b) `InfoClient` 接口追加 `OrderStatus`：

```go
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]hlinfo.Fill, error)
	OrderStatus(ctx context.Context, user, cloid string) (hlinfo.OrderStatusResult, error)
}
```

(c) 加纯 `reapTarget`（放在 `targetFor` 附近）：

```go
// reapTarget maps an HL order status string to the ledger status to advance toward,
// ok=false for statuses that don't imply a lifecycle change. Mirrors the mobile
// normalizeOrderStatus classification.
func reapTarget(hlStatus string) (ledger.Status, bool) {
	switch {
	case strings.HasSuffix(hlStatus, "Rejected"), hlStatus == "rejected":
		return ledger.StatusRejected, true
	case strings.HasSuffix(hlStatus, "Canceled"), hlStatus == "canceled", hlStatus == "scheduledCancel":
		return ledger.StatusCanceled, true
	case hlStatus == "filled":
		return ledger.StatusFilled, true
	case hlStatus == "open", hlStatus == "resting", hlStatus == "triggered":
		return ledger.StatusOpen, true
	default:
		return "", false
	}
}
```

(d) 把整个 `step` 方法替换为（按 keyID 分组、锚点由组内 min、open/fills union 不变、末尾加 reap）：

```go
func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil // not the leader; another instance polls
	}
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
	if err != nil {
		return err
	}
	byKey := make(map[string][]ledger.Orphan)
	for _, o := range orphs {
		byKey[o.KeyID] = append(byKey[o.KeyID], o)
	}
	now := time.Now().UnixMilli()
	for _, a := range r.accounts {
		group := byKey[a.KeyID]
		anchor := now
		for _, o := range group {
			if o.UpdatedAtMs < anchor {
				anchor = o.UpdatedAtMs
			}
		}
		anchor = clampAnchor(anchor, now)
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		if err != nil {
			return err
		}
		// advance open/filled from the batch snapshots.
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
		// reap non-terminal intents HL no longer reports as open/filled: the
		// authoritative orderStatus advances canceled/rejected (or filled) to terminal.
		for _, o := range group {
			if _, inOpen := open[o.Cloid]; inOpen {
				continue
			}
			if _, inFills := fills[o.Cloid]; inFills {
				continue
			}
			res, err := r.client.OrderStatus(ctx, a.Address, o.Cloid)
			if err != nil {
				return err
			}
			if !res.Found {
				continue // unknownOid → HL has no record; leave (may be mid-submission)
			}
			target, ok := reapTarget(res.Status)
			if !ok {
				continue
			}
			if err := r.reconcileOne(ctx, a.KeyID, o.Cloid, target); err != nil {
				return err
			}
		}
	}
	return nil
}
```

（删除旧的独立 `anchorByKey` map——锚点已改由 `byKey` 组内 min 求得。`Reconciler`/`New`/`WithLeaderGate`/`targetFor`/`reconcileOne`/`Run`/`clampAnchor`/常量不变。）

- [ ] **Step 4: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/reconciler/ && go vet ./internal/reconciler/ && go test -race ./internal/reconciler/`
Expected: 全 PASS（既有 step/Run/LeaderGate/anchor/clamp 用例 + reapTarget/reap 用例）；vet 静默；race 无告警。既有用例的 `fakeClient{...}` 字面量无需改（`orderStatus`/`statusQueried` 缺省 nil，`OrderStatus` 返回零值 `{Found:false}`）。

- [ ] **Step 5: 全量门 + 集成编译校验**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer && go test -c -tags=integration -o /dev/null ./...`
Expected: 全 PASS；vet/race 静默；signer 构建成功；集成编译成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/reconciler/reconciler.go backend/internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(backend): reap canceled/rejected intents via orderStatus

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- E’’0 DAG signed/submitted→canceled + 测试 + signer 测试改 → Task 1 ✅
- E’’1 hlinfo OrderStatus + OrderStatusResult（found/unknownOid/非2xx）→ Task 2 ✅
- E’’2 InfoClient +OrderStatus；reapTarget；step reap（缺失非终态、unknownOid 保留、open/fills 里不查）→ Task 3 ✅
- 保留 clampAnchor → Task 3（step 保留）✅
- 测试（reapTarget/reap canceled/unknownOid 保留/open 不查）→ Task 3 ✅
- 非目标（不设 staleness、不改 hl）→ 计划未触及 ✅

**Placeholder scan：** 无 TBD/TODO；代码步骤含完整代码；import 补充点已标注。

**Type consistency：** `OrderStatusResult{Status,Found}`/`OrderStatus(ctx,user,cloid)` 在 hlinfo/接口/fake/step 一致；`reapTarget(string)(ledger.Status,bool)`；`fakeClient.orderStatus map[string]hlinfo.OrderStatusResult`/`statusQueried []string`；`allowedTransitions` 加 canceled；`ledger.StatusCanceled/Rejected/Filled/Open`、`ledger.Orphan.{KeyID,Cloid,UpdatedAtMs}` 与已合并 API 一致。
