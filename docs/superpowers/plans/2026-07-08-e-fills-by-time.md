# E’ userFillsByTime 分页 + 账本锚定窗口化成交对账 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `userFillsByTime`（分页）取代 `userFills` 匹配成交，并把 fills 查询锚定到该 keyID 最老未终态意图时间，修复 2000-fill 窗口漏单。

**Architecture:** E’1 `internal/hlinfo` 加分页 `FillsByCloidSince`（tid 去重、时间游标翻页、页数封顶）。E’2 `internal/reconciler` 的 `step` 每轮先 `Orphans` 求每 keyID 锚点（min updatedAt，无待办取 now），`OpenCloids` 照查、`FillsByCloidSince(anchor)` 窗口化查成交，其余对账逻辑不变。

**Tech Stack:** Go 1.26；`net/http`；`internal/{hlinfo,reconciler,ledger}`（已合并）。

参考 spec：`docs/superpowers/specs/2026-07-08-e-fills-by-time-design.md`
现状：`internal/hlinfo/hlinfo.go`（`rawFill{Cloid,Px,Sz,ClosedPnl}`；`post(ctx,body any,out any)`；`FillsByCloid` 聚合模式 line 113-141）；`internal/reconciler/reconciler.go`（`InfoClient{OpenCloids,FillsByCloid}`；`step` 每 account 查 open+fills 并 union 对账；`targetFor`/`reconcileOne`/`Run`/`WithLeaderGate`）；`internal/reconciler/reconciler_test.go`（`fakeClient{open,fills,err,calls}` + `OpenCloids`/`FillsByCloid` 方法；`seedSigned`/`statusOf`）。HL fill 字段 `time`(ms)/`tid`（见 mobile/src/lib/hyperliquid/history.ts 按 tid 去重）。

## 文件结构
- `backend/internal/hlinfo/hlinfo.go` — rawFill +Time/Tid；+`fillsMaxPages`；+`FillsByCloidSince`。
- `backend/internal/hlinfo/hlinfo_test.go` — 分页/去重/封顶单测。
- `backend/internal/reconciler/reconciler.go` — InfoClient 换 FillsByCloidSince；step 锚定；+import time；+常量。
- `backend/internal/reconciler/reconciler_test.go` — fake 换方法+记录 startMs；+锚点单测。

---

### Task 1: `internal/hlinfo` 分页 `FillsByCloidSince`

**Files:**
- Modify: `backend/internal/hlinfo/hlinfo.go`
- Test: `backend/internal/hlinfo/hlinfo_test.go`

- [ ] **Step 1: 写失败测试（追加到 `hlinfo_test.go` 末尾）**

```go
func TestFillsByCloidSincePaginates(t *testing.T) {
	// page 1 (startTime=100): two fills for c1 incl. one at the boundary time 200;
	// page 2 (startTime=201): one more fill for c1 + a duplicate tid (must be ignored);
	// page 3 (startTime=301): empty → stop.
	var starts []int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "userFillsByTime" {
			t.Fatalf("bad type: %v", body["type"])
		}
		st := int64(body["startTime"].(float64))
		starts = append(starts, st)
		switch {
		case st <= 100:
			_, _ = w.Write([]byte(`[
				{"cloid":"c1","px":"100","sz":"2","closedPnl":"1","time":150,"tid":1},
				{"cloid":"c1","px":"110","sz":"1","closedPnl":"1","time":200,"tid":2}
			]`))
		case st <= 201:
			_, _ = w.Write([]byte(`[
				{"cloid":"c1","px":"120","sz":"1","closedPnl":"1","time":250,"tid":2},
				{"cloid":"c1","px":"130","sz":"1","closedPnl":"1","time":300,"tid":3}
			]`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	defer srv.Close()
	got, err := New(srv.URL, nil).FillsByCloidSince(context.Background(), "0xacc", 100)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	// tid 2 appears on both pages but must be counted once: total sz = 2+1+1 = 4 (tids 1,2,3).
	f := got["c1"]
	if f.Sz != 4 {
		t.Fatalf("c1 sz = %v, want 4 (tid-dedup across pages)", f.Sz)
	}
	// cursor advanced by maxTime+1: 100 -> 201 -> 301.
	if len(starts) != 3 || starts[0] != 100 || starts[1] != 201 || starts[2] != 301 {
		t.Fatalf("startTimes = %v, want [100 201 301]", starts)
	}
}

func TestFillsByCloidSinceEmptyFirstPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	got, err := New(srv.URL, nil).FillsByCloidSince(context.Background(), "0xacc", 0)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, err %v; want empty", got, err)
	}
}

func TestFillsByCloidSinceCapsPages(t *testing.T) {
	// always a full advancing page → must stop at fillsMaxPages, not spin forever.
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		st := int64(body["startTime"].(float64))
		calls++
		_, _ = w.Write([]byte(`[{"cloid":"c1","px":"1","sz":"1","closedPnl":"0","time":` +
			strconv.FormatInt(st+1, 10) + `,"tid":` + strconv.FormatInt(st+1, 10) + `}]`))
	}))
	defer srv.Close()
	if _, err := New(srv.URL, nil).FillsByCloidSince(context.Background(), "0xacc", 0); err != nil {
		t.Fatalf("err = %v", err)
	}
	if calls != fillsMaxPages {
		t.Fatalf("calls = %d, want fillsMaxPages=%d", calls, fillsMaxPages)
	}
}
```

（`hlinfo_test.go` 需 import `strconv`——若未 import 则补。context/encoding/json/net/http/net/http/httptest/testing 已在。）

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/hlinfo/ -run FillsByCloidSince`
Expected: 编译失败（`FillsByCloidSince`/`fillsMaxPages` 未定义）。

- [ ] **Step 3: 改 `hlinfo.go` — rawFill 加 Time/Tid + fillsMaxPages + FillsByCloidSince**

在 `rawFill` 结构追加两个字段：

```go
type rawFill struct {
	Cloid     *string `json:"cloid"`
	Px        string  `json:"px"`
	Sz        string  `json:"sz"`
	ClosedPnl string  `json:"closedPnl"`
	Time      int64   `json:"time"`
	Tid       int64   `json:"tid"`
}
```

在文件中（`FillsByCloid` 之后）追加常量与方法：

```go
// fillsMaxPages caps userFillsByTime pagination so a hot account can't spin the
// loop unbounded; on hitting it FillsByCloidSince returns what it has (best-effort;
// the ledger orphan detection backstops any gap).
const fillsMaxPages = 50

// FillsByCloidSince pages userFillsByTime forward from startMs (unix ms),
// aggregating fills by cloid (dedup by trade id across page boundaries) until an
// empty page, no forward progress, or fillsMaxPages. Null-cloid fills are dropped.
func (c *Client) FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]Fill, error) {
	type acc struct{ sz, closedPnl, pxSz float64 }
	m := make(map[string]acc)
	seen := make(map[int64]struct{}) // dedup by tid across pages
	cursor := startMs
	for page := 0; page < fillsMaxPages; page++ {
		var raw []rawFill
		if err := c.post(ctx, map[string]any{"type": "userFillsByTime", "user": user, "startTime": cursor}, &raw); err != nil {
			return nil, err
		}
		if len(raw) == 0 {
			break
		}
		var maxTime int64
		for _, f := range raw {
			if f.Time > maxTime {
				maxTime = f.Time
			}
			if _, dup := seen[f.Tid]; dup {
				continue
			}
			seen[f.Tid] = struct{}{}
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
		next := maxTime + 1
		if next <= cursor { // window did not advance → stop (avoids an infinite loop)
			break
		}
		cursor = next
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
Expected: 全 PASS（含既有 `FillsByCloid`/`OpenCloids` 用例）；vet 静默；race 无告警。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/hlinfo/hlinfo.go backend/internal/hlinfo/hlinfo_test.go
git commit --no-verify -m "feat(backend): hlinfo FillsByCloidSince (paginated userFillsByTime)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `internal/reconciler` 账本锚定窗口化 fills

**Files:**
- Modify: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

- [ ] **Step 1: 改 fake + 加锚点测试（`reconciler_test.go`）**

(a) 把 `fakeClient` 的 `FillsByCloid` 方法改名并加 `startMs` 参数 + 记录：在结构加字段 `lastStart map[string]int64`（或简单 `lastStart int64`——取最后一次即可）。改为：

```go
func (f *fakeClient) FillsByCloidSince(_ context.Context, user string, startMs int64) (map[string]hlinfo.Fill, error) {
	if f.lastStart == nil {
		f.lastStart = map[string]int64{}
	}
	f.lastStart[user] = startMs
	if f.err != nil {
		return nil, f.err
	}
	return f.fills[user], nil
}
```

并在 `fakeClient` 结构体加字段：`lastStart map[string]int64`。

(b) 追加两个新测试：

```go
func TestStepAnchorsToNowWhenNoPending(t *testing.T) {
	before := time.Now().UnixMilli()
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}}
	r := New(fc, ledger.NewMem(), []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if fc.lastStart["0xacc"] < before {
		t.Fatalf("anchor = %d, want >= now(%d) when no pending intents", fc.lastStart["0xacc"], before)
	}
}

func TestStepAnchorsFillsToOldestNonTerminal(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1") // older
	time.Sleep(2 * time.Millisecond)
	seedSigned(t, led, "k", "c2") // newer
	// oldest updatedAt = c1's stamp.
	var oldest int64 = 1<<62
	for _, o := range mustOrphans(t, led) {
		if o.UpdatedAtMs < oldest {
			oldest = o.UpdatedAtMs
		}
	}
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {}}}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}})
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if fc.lastStart["0xacc"] != oldest {
		t.Fatalf("anchor = %d, want oldest updatedAt %d", fc.lastStart["0xacc"], oldest)
	}
}

// mustOrphans returns all non-terminal records (far-future cutoff).
func mustOrphans(t *testing.T, led *ledger.Mem) []ledger.Orphan {
	t.Helper()
	o, err := led.Orphans(context.Background(), 4_000_000_000_000)
	if err != nil {
		t.Fatalf("orphans: %v", err)
	}
	return o
}
```

（现有测试用例中所有 `fakeClient{...}` 字面量无需改；`fills` 字段保留。既有 `TestStepAdvancesOpenAndFilled` 等因 fake 返回 `f.fills[user]`（忽略 startMs）行为不变。）

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/reconciler/`
Expected: 编译失败（`FillsByCloidSince` 尚未在 InfoClient 接口 / step 未调用；fake 方法名已改导致既有 `r.client.FillsByCloid` 调用与接口不匹配）。

- [ ] **Step 3: 改 `reconciler.go` — 接口 + step 锚定**

(a) `import` 追加 `"time"`。

(b) `InfoClient` 接口把 `FillsByCloid` 换成：

```go
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]hlinfo.Fill, error)
}
```

(c) 加包级常量（放在类型定义附近）：

```go
// allNonTerminalCutoffMs is a far-future cutoff (year ~2096) so Orphans returns
// every currently non-terminal intent; their min updatedAt is the per-key fills anchor.
const allNonTerminalCutoffMs int64 = 4_000_000_000_000
```

(d) 把整个 `step` 方法替换为：

```go
func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil // not the leader; another instance polls
	}
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
	if err != nil {
		return err
	}
	// oldest non-terminal intent's updatedAt per keyID = that key's fills anchor.
	anchorByKey := make(map[string]int64)
	for _, o := range orphs {
		if cur, ok := anchorByKey[o.KeyID]; !ok || o.UpdatedAtMs < cur {
			anchorByKey[o.KeyID] = o.UpdatedAtMs
		}
	}
	now := time.Now().UnixMilli()
	for _, a := range r.accounts {
		anchor, ok := anchorByKey[a.KeyID]
		if !ok {
			anchor = now // no pending intents → fills window from now (≈empty)
		}
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
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
```

（`Reconciler`/`New`/`WithLeaderGate`/`targetFor`/`reconcileOne`/`Run` 不变。）

- [ ] **Step 4: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/reconciler/ && go vet ./internal/reconciler/ && go test -race ./internal/reconciler/`
Expected: 全 PASS（既有 step/Run/LeaderGate 用例 + 两个锚点用例）；vet 静默；race 无告警。

- [ ] **Step 5: 全量门 + 集成编译校验**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer && go test -c -tags=integration -o /dev/null ./...`
Expected: 全 PASS（含 `cmd/signer` 的 `TestBuildHandlerStartsReconciler`——httptest 对任意请求回 `[]`，OpenCloids 仍触发轮询）；vet/race 静默；signer 构建成功；集成编译成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/reconciler/reconciler.go backend/internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(backend): anchor reconciler fills query to oldest pending intent

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- rawFill Time/Tid + fillsMaxPages + FillsByCloidSince（分页/tid 去重/游标推进/封顶）→ Task 1 ✅
- InfoClient 换 FillsByCloidSince + step 锚定（Orphans 求 min updatedAt/无待办取 now）→ Task 2 ✅
- 保留 FillsByCloid → Task 1（不删）✅
- 测试（分页/去重/空/封顶；锚点到 oldest / 到 now；既有用例保持）→ Task 1/2 ✅
- 既有 E3 wiring 测试不破（OpenCloids 照查）→ Task 2 Step 5 ✅
- 非目标（不改 openOrders/hl/ledger、不持久化游标）→ 计划未触及 ✅

**Placeholder scan：** 无 TBD/TODO；代码步骤含完整代码；import 补充点已标注。

**Type consistency：** `FillsByCloidSince(ctx,user string,startMs int64)(map[string]hlinfo.Fill,error)` 在 hlinfo/接口/fake/step 一致；`rawFill.Time/Tid`(json time/tid)；`fillsMaxPages`/`allNonTerminalCutoffMs` 常量；`fakeClient.lastStart map[string]int64`；`ledger.Orphans`/`Orphan.{KeyID,UpdatedAtMs}`/`ledger.Mem`/`seedSigned` 与已合并 API 一致。
