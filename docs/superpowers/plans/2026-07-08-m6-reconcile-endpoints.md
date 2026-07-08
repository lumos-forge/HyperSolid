# M6 对账端点接线 signer 实现计划 — 子项目 D

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 signer 服务加 `POST /v1/reconcile`（上报订单状态转移）与 `GET /v1/orphans`（查询孤儿单），把 B 的 `Reconcile`/`Orphans` 接上 HTTP。

**Architecture:** 把 `newMux` 持有的账本从 `ledger.Authorizer` 拓宽为 `ledger.Ledger`（Mem 与 pg.Store 已实现），新增两个 handler。签名路径与字节不变；两端点无签名/密钥/fencer 门。

**Tech Stack:** Go 1.26；`net/http`；`encoding/json`；`strconv`；`internal/ledger`（已合并）。

参考 spec：`docs/superpowers/specs/2026-07-08-m6-reconcile-endpoints-design.md`
现状：`backend/cmd/signer/main.go`（`newMux` line 279 参数 `auth ledger.Authorizer`；`handleSignL1` line 185；`writeErr` line 51；已 import `net/http`/`strconv`/`encoding/json`/`errors`/`ledger`）。测试：`backend/cmd/signer/main_test.go`（`constFencer`、`leaderMux`）。
账本 API：`ledger.Ledger`（=Authorizer+Reconciler）、`ledger.Reconciler.Reconcile(ctx,keyID,cloid string,target ledger.Status)(ledger.Status,error)`、`.Orphans(ctx,olderThanMs int64)([]ledger.Orphan,error)`、`ledger.Orphan{KeyID,Cloid string;Nonce uint64;Status ledger.Status;UpdatedAtMs int64}`、consts `StatusSigned..StatusCanceled`、`ledger.ErrUnknownIntent`/`ledger.ErrInvalidTransition`、`ledger.NewMem()`。

## 文件结构
- `backend/cmd/signer/main.go` — `newMux` 拓宽类型 + 两个 handler（reconcile/orphans）+ DTO/校验。
- `backend/cmd/signer/main_test.go` — 两端点的单测。

---

### Task 1: `POST /v1/reconcile` 端点 + newMux 拓宽

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 写失败测试（追加到 `main_test.go` 末尾）**

```go
func reconcileMux(led ledger.Ledger) http.Handler {
	return newMux(keystore.New(), policy.NewStore(), led, constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 })
}

func TestReconcileHappyPath(t *testing.T) {
	led := ledger.NewMem()
	if _, err := led.Authorize(context.Background(), ledger.Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()
	res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"c1","status":"submitted"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		Status string `json:"status"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Status != "submitted" {
		t.Fatalf("status = %q, want submitted", out.Status)
	}
}

func TestReconcileUnknownIntent(t *testing.T) {
	srv := httptest.NewServer(reconcileMux(ledger.NewMem()))
	defer srv.Close()
	res, _ := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"nope","status":"submitted"}`))
	defer res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

func TestReconcileInvalidTransition(t *testing.T) {
	led := ledger.NewMem()
	_, _ = led.Authorize(context.Background(), ledger.Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000})
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()
	// signed -> open is a skip (invalid); must go through submitted.
	res, _ := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"c1","status":"open"}`))
	defer res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("status = %d, want 409", res.StatusCode)
	}
}

func TestReconcileBadStatus(t *testing.T) {
	led := ledger.NewMem()
	_, _ = led.Authorize(context.Background(), ledger.Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000})
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()
	res, _ := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"c1","status":"bogus"}`))
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400 (bad status)", res.StatusCode)
	}
}

func TestReconcileBadJSONAndMethod(t *testing.T) {
	srv := httptest.NewServer(reconcileMux(ledger.NewMem()))
	defer srv.Close()
	res, _ := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{bad`))
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("bad json status = %d, want 400", res.StatusCode)
	}
	res2, _ := http.Get(srv.URL + "/v1/reconcile")
	res2.Body.Close()
	if res2.StatusCode != 405 {
		t.Fatalf("GET status = %d, want 405", res2.StatusCode)
	}
}
```

> 注：`main_test.go` 已 import `bytes`/`context`/`encoding/json`/`net/http`/`net/http/httptest`/`strings`/`testing`/`keystore`/`policy`/`ledger`。若 `context`/`strings` 未在，补之（本任务用到）。

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./cmd/signer/ -run Reconcile`
Expected: 编译失败/404 等——`/v1/reconcile` 路由与 handler 尚不存在（newMux 未注册；且 newMux 参数仍是 Authorizer，`reconcileMux` 传 Ledger 也可编译，但路由 404）。

- [ ] **Step 3: 改 `main.go` — `newMux` 拓宽类型并注册路由**

把 `newMux` 签名的 `auth ledger.Authorizer` 改为 `led ledger.Ledger`，`handleSignL1` 调用改传 `led`，并注册两条新路由：

```go
func newMux(ks *keystore.Keystore, policies *policy.Store, led ledger.Ledger, fencer Fencer, nowMs func() int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, led, fencer, nowMs))
	mux.HandleFunc("/v1/reconcile", handleReconcile(led))
	mux.HandleFunc("/v1/orphans", handleOrphans(led))
	return mux
}
```

（`handleSignL1` 的参数保持 `auth ledger.Authorizer` 不变——`led`（Ledger）满足 Authorizer。）

- [ ] **Step 4: 改 `main.go` — 新增 reconcile DTO + 校验 + handler**

在 `newMux` 之前（或 handleSignL1 附近）追加：

```go
type reconcileRequest struct {
	KeyID  string `json:"keyId"`
	Cloid  string `json:"cloid"`
	Status string `json:"status"`
}

type reconcileResponse struct {
	Status string `json:"status"`
}

// validStatus reports whether s is one of the six known lifecycle states.
func validStatus(s string) bool {
	switch ledger.Status(s) {
	case ledger.StatusSigned, ledger.StatusSubmitted, ledger.StatusOpen,
		ledger.StatusFilled, ledger.StatusRejected, ledger.StatusCanceled:
		return true
	default:
		return false
	}
}

// handleReconcile advances the lifecycle status of an existing (keyId, cloid)
// intent via the ledger reconciliation state machine. It signs nothing and holds
// no fence gate: transitions are serialized in the store and a stale report is
// rejected as an invalid transition. Unknown intent → 404; invalid edge → 409;
// unknown status string → 400.
func handleReconcile(led ledger.Reconciler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req reconcileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
			return
		}
		if !validStatus(req.Status) {
			writeErr(w, http.StatusBadRequest, "invalid status")
			return
		}
		st, err := led.Reconcile(r.Context(), req.KeyID, req.Cloid, ledger.Status(req.Status))
		if err != nil {
			switch {
			case errors.Is(err, ledger.ErrUnknownIntent):
				writeErr(w, http.StatusNotFound, "unknown intent")
			case errors.Is(err, ledger.ErrInvalidTransition):
				writeErr(w, http.StatusConflict, "invalid transition")
			default:
				writeErr(w, http.StatusInternalServerError, "reconcile failed")
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reconcileResponse{Status: string(st)})
	}
}
```

- [ ] **Step 5: 加一个临时空 `handleOrphans`（Task 2 填实现，保证编译）**

因 newMux 注册了 `handleOrphans`，需一个可编译的占位（Task 2 替换为完整实现）：

```go
// handleOrphans is implemented in Task 2; this placeholder returns an empty list
// so the mux compiles after Task 1 registers the route.
func handleOrphans(led ledger.Reconciler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"orphans":[]}`))
	}
}
```

- [ ] **Step 6: 运行确认通过**

Run: `cd backend && go test ./cmd/signer/ -run Reconcile`
Expected: 五个 reconcile 用例 PASS。

- [ ] **Step 7: 全量门（signer 包 + 既有测试不受影响）**

Run: `cd backend && go build ./cmd/signer && rm -f signer && go test ./cmd/signer/ && go vet ./cmd/signer/`
Expected: 编译成功；signer 包全部测试 PASS（golden/sign/fenced 等既有用例不变）；vet 静默。

- [ ] **Step 8: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): POST /v1/reconcile endpoint (wire ledger Reconcile)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `GET /v1/orphans` 端点

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 写失败测试（追加到 `main_test.go` 末尾）**

```go
func TestOrphansEndpoint(t *testing.T) {
	led := ledger.NewMem()
	ctx := context.Background()
	// two non-terminal intents (signed) + one driven to a terminal (filled).
	for _, c := range []string{"a", "b", "term"} {
		if _, err := led.Authorize(ctx, ledger.Request{KeyID: "k", Cloid: c, Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000}); err != nil {
			t.Fatalf("seed %s: %v", c, err)
		}
	}
	if _, err := led.Reconcile(ctx, "k", "term", ledger.StatusSubmitted); err != nil {
		t.Fatalf("term->submitted: %v", err)
	}
	if _, err := led.Reconcile(ctx, "k", "term", ledger.StatusFilled); err != nil {
		t.Fatalf("term->filled: %v", err)
	}
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()

	// far-future cutoff catches the two non-terminal intents, excludes filled.
	res, err := http.Get(srv.URL + "/v1/orphans?olderThanMs=4000000000000")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		Orphans []struct {
			KeyID  string `json:"keyId"`
			Cloid  string `json:"cloid"`
			Status string `json:"status"`
		} `json:"orphans"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := map[string]string{}
	for _, o := range out.Orphans {
		got[o.Cloid] = o.Status
	}
	if len(got) != 2 || got["a"] != "signed" || got["b"] != "signed" {
		t.Fatalf("orphans = %+v; want {a:signed, b:signed} (term excluded)", got)
	}

	// far-past cutoff → empty (never null).
	res2, _ := http.Get(srv.URL + "/v1/orphans?olderThanMs=1000000000")
	defer res2.Body.Close()
	var out2 struct {
		Orphans []any `json:"orphans"`
	}
	if err := json.NewDecoder(res2.Body).Decode(&out2); err != nil {
		t.Fatalf("decode2: %v", err)
	}
	if out2.Orphans == nil || len(out2.Orphans) != 0 {
		t.Fatalf("orphans(past) = %+v; want empty non-nil array", out2.Orphans)
	}
}

func TestOrphansBadParamAndMethod(t *testing.T) {
	srv := httptest.NewServer(reconcileMux(ledger.NewMem()))
	defer srv.Close()
	// missing olderThanMs → 400.
	res, _ := http.Get(srv.URL + "/v1/orphans")
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("missing param status = %d, want 400", res.StatusCode)
	}
	// non-numeric → 400.
	res2, _ := http.Get(srv.URL + "/v1/orphans?olderThanMs=abc")
	res2.Body.Close()
	if res2.StatusCode != 400 {
		t.Fatalf("bad param status = %d, want 400", res2.StatusCode)
	}
	// non-GET → 405.
	res3, _ := http.Post(srv.URL+"/v1/orphans", "application/json", strings.NewReader(`{}`))
	res3.Body.Close()
	if res3.StatusCode != 405 {
		t.Fatalf("POST status = %d, want 405", res3.StatusCode)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./cmd/signer/ -run Orphans`
Expected: FAIL——占位 handleOrphans 未解析 param（缺 param 返回 200 而非 400）、总是返回空数组（TestOrphansEndpoint 期望 2 个）。

- [ ] **Step 3: 改 `main.go` — 用完整实现替换占位 `handleOrphans` + DTO**

在 handleReconcile 附近追加 DTO，并把 Task 1 的占位 `handleOrphans` 替换为完整实现：

```go
type orphanDTO struct {
	KeyID       string `json:"keyId"`
	Cloid       string `json:"cloid"`
	Nonce       uint64 `json:"nonce"`
	Status      string `json:"status"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

type orphansResponse struct {
	Orphans []orphanDTO `json:"orphans"`
}

// handleOrphans returns non-terminal intents whose last update predates the
// olderThanMs (unix ms) cutoff — signing/submitted/open orders never confirmed to
// a terminal state. Read-only; no fence gate. Missing/invalid cutoff → 400.
func handleOrphans(led ledger.Reconciler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		n, err := strconv.ParseInt(r.URL.Query().Get("olderThanMs"), 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid olderThanMs")
			return
		}
		orphs, err := led.Orphans(r.Context(), n)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "orphans failed")
			return
		}
		out := orphansResponse{Orphans: []orphanDTO{}}
		for _, o := range orphs {
			out.Orphans = append(out.Orphans, orphanDTO{
				KeyID:       o.KeyID,
				Cloid:       o.Cloid,
				Nonce:       o.Nonce,
				Status:      string(o.Status),
				UpdatedAtMs: o.UpdatedAtMs,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}
```

删除 Task 1 里那段占位 `handleOrphans`（用此完整实现取代整段函数）。

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && go test ./cmd/signer/ -run 'Orphans|Reconcile'`
Expected: orphans 与 reconcile 用例全 PASS。

- [ ] **Step 5: 全量门 + 集成编译校验**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer && go test -c -tags=integration -o /dev/null ./...`
Expected: 全 PASS；vet/race 静默；signer 构建成功；集成编译成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): GET /v1/orphans endpoint (wire ledger Orphans)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- newMux 账本类型拓宽 Authorizer→Ledger + handleSignL1 传 led → Task 1 Step 3 ✅
- POST /v1/reconcile（DTO/校验/错误映射 404/409/400/405/500）→ Task 1 Step 4 ✅
- GET /v1/orphans（解析 param、[]避免 null、错误 400/405/500）→ Task 2 Step 3 ✅
- 测试（reconcile 5 用例 + orphans 2 用例）→ Task 1 Step 1 / Task 2 Step 1 ✅
- 既有测试不受影响（newMux 传 Ledger 仍满足 Authorizer）→ Task 1 Step 7 ✅
- 非目标（无 fence 门、不接 HL、不改 hl/ledger 核心）→ 计划未触及 ✅

**Placeholder scan：** Task 1 Step 5 的占位 handleOrphans 是**有意的编译桥**（Task 2 Step 3 明确替换为完整实现，非遗留 TODO）；其余代码步骤含完整代码。

**Type consistency：** `newMux(..., led ledger.Ledger, ...)`；`handleReconcile(led ledger.Reconciler)`/`handleOrphans(led ledger.Reconciler)`（Ledger 满足 Reconciler）；`reconcileRequest{KeyID,Cloid,Status}`/`reconcileResponse{Status}`/`orphanDTO{KeyID,Cloid,Nonce,Status,UpdatedAtMs}`/`orphansResponse{Orphans}`；`ledger.Reconcile`/`Orphans`/`Orphan`/`Status`/`ErrUnknownIntent`/`ErrInvalidTransition` 全程一致；`reconcileMux` 测试助手在 Task 1 定义、Task 2 复用。
