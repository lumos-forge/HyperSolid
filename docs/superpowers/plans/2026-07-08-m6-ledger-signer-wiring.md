# M6 意图账本接线 signer `/v1/sign/l1` 实现计划 — 子项目 C

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/v1/sign/l1` 的 nonce 分配从 `singlewriter.Writer` 切到 `ledger.Authorizer`，请求新增顶层必填 `cloid` 幂等键，签名字节保持不变（golden 逐字节仍过）。

**Architecture:** `ledger.Authorizer` 取代端点里的 `singlewriter.Writer`（ledger 是其超集，内部复用 `singlewriter.Decide`，nonce 权威单一）。顶层 `cloid` 与 `params.cloid` 解耦（不写 params）→ 保 golden 字节一致；intent 摘要 `sha256(msgpack(action)‖testnet)` 驱动碰撞检测。

**Tech Stack:** Go 1.26；`internal/ledger`（已合并 PR #39）；`internal/ledger/pg`；`crypto/sha256`；`internal/hl`。

参考 spec：`docs/superpowers/specs/2026-07-08-m6-ledger-signer-wiring-design.md`
现状文件：`backend/cmd/signer/main.go`（`signL1Request`/`signL1Response`/`handleSignL1`/`newMux`/`buildHandler`）、`backend/cmd/signer/main_test.go`、`backend/cmd/signer/main_integration_test.go`。
已合并核心 API：`ledger.Request{KeyID,Cloid,Digest [32]byte,Fence,Notional,DailyCap,NowMs}`、`ledger.Grant{Nonce,Duplicate}`、`ledger.Authorizer.Authorize`、`ledger.NewMem()`、`ledger.ErrMissingCloid`、`ledger.ErrCloidReuse`；Postgres `ledgerpg.New(pool)` + `ledgerpg.EnsureSchema(ctx,pool)`（import path `github.com/lumos-forge/hypersolid/backend/internal/ledger/pg`）。

## 文件结构

- `backend/cmd/signer/main.go` — 端点契约 + 摘要 + handler + newMux + buildHandler 接线。
- `backend/cmd/signer/main_test.go` — 更新既有单测 + 新增幂等单测。
- `backend/cmd/signer/main_integration_test.go` — 更新集成测试为按 cloid 签名 + 幂等断言。

---

### Task 1: 接线 ledger + 更新既有测试（golden 字节不变）

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 改 `main.go` — 请求/响应结构**

把 `signL1Request` / `signL1Response` 改为：

```go
type signL1Request struct {
	KeyID     string          `json:"keyId"`
	Cloid     string          `json:"cloid"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	IsTestnet bool            `json:"isTestnet"`
}

type signL1Response struct {
	R         string `json:"r"`
	S         string `json:"s"`
	V         int    `json:"v"`
	Nonce     uint64 `json:"nonce"`
	Duplicate bool   `json:"duplicate"`
}
```

- [ ] **Step 2: 改 `main.go` — imports**

在 import 块中：新增 `"crypto/sha256"`；新增 `"github.com/lumos-forge/hypersolid/backend/internal/ledger"` 与 `ledgerpg "github.com/lumos-forge/hypersolid/backend/internal/ledger/pg"`；移除不再使用的 `swpg "github.com/lumos-forge/hypersolid/backend/internal/singlewriter/pg"`（buildHandler 改用 ledgerpg）。保留 `"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"`（错误类型仍透传引用）。移除 `leasepg`? 否——lease 接线不变，保留 `leasepg`。

- [ ] **Step 3: 改 `main.go` — `handleSignL1` 签名与授权**

把签名与其后的授权段改为（`writer singlewriter.Writer` → `auth ledger.Authorizer`）：

```go
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64) http.HandlerFunc {
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
		enc, err := hl.Encode(action)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "encode action: "+err.Error())
			return
		}
		hsh := sha256.New()
		hsh.Write(enc)
		if req.IsTestnet {
			hsh.Write([]byte{1})
		} else {
			hsh.Write([]byte{0})
		}
		var digest [32]byte
		copy(digest[:], hsh.Sum(nil))

		fence, isLeader := fencer.Fence()
		if !isLeader {
			writeErr(w, http.StatusServiceUnavailable, "not leader")
			return
		}
		grant, err := auth.Authorize(r.Context(), ledger.Request{
			KeyID:    req.KeyID,
			Cloid:    req.Cloid,
			Digest:   digest,
			Fence:    fence,
			Notional: intent.NotionalUsdc,
			DailyCap: cfg.DailyMaxNotionalUsdc,
			NowMs:    nowMs(),
		})
		if err != nil {
			switch {
			case errors.Is(err, ledger.ErrMissingCloid):
				writeErr(w, http.StatusBadRequest, "missing cloid")
			case errors.Is(err, ledger.ErrCloidReuse):
				writeErr(w, http.StatusConflict, "cloid reuse mismatch")
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
			R:         "0x" + hex.EncodeToString(sig.R[:]),
			S:         "0x" + hex.EncodeToString(sig.S[:]),
			V:         int(sig.V),
			Nonce:     grant.Nonce,
			Duplicate: grant.Duplicate,
		})
	}
}
```

- [ ] **Step 4: 改 `main.go` — `newMux` 签名**

```go
func newMux(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, auth, fencer, nowMs))
	return mux
}
```

- [ ] **Step 5: 改 `main.go` — `buildHandler` 接线**

内存分支：`h := newMux(ks, policies, ledger.NewMem(), staticFencer{epoch: 1}, nowMs)`。

Postgres 分支：把 `swpg.EnsureSchema(...)` 替换为 `ledgerpg.EnsureSchema(ctx, pool)`（内部已链 swpg 建 sw_state + 建 ledger_intents），并把 `writer := swpg.New(pool)` 改为 `auth := ledgerpg.New(pool)`，`newMux(ks, policies, auth, ld, nowMs)`。保留 `leasepg.EnsureSchema` + leader 接线。改完后 Postgres 分支形如：

```go
	pool, err := pgxpool.New(ctx, cfg.databaseURL)
	if err != nil {
		return nil, nil, fmt.Errorf("signer: pgxpool: %w", err)
	}
	if err := ledgerpg.EnsureSchema(ctx, pool); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("signer: ledger schema: %w", err)
	}
	if err := leasepg.EnsureSchema(ctx, pool); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("signer: lease schema: %w", err)
	}

	auth := ledgerpg.New(pool)
	store := leasepg.New(pool)
	ld := leader.New(store, cfg.leaseName, cfg.holderID, cfg.leaseTTL)
	// ... leaderCtx/go ld.Run/cleanup unchanged ...
	h := newMux(ks, policies, auth, ld, nowMs)
```

（同时更新顶部 `var _ singlewriter.Writer = ...` 若存在——不存在；`var _ Fencer = (*leader.Leader)(nil)` 保留不变。）

- [ ] **Step 6: 改 `main_test.go` — imports 与 `leaderMux`**

在 import 块把 `singlewriter` 保留（FencedConflict 仍需 `singlewriter` 错误？否——改造后用 ledger.NewMem；但 seed 不再用 singlewriter.Request）。实际：新增 `"github.com/lumos-forge/hypersolid/backend/internal/ledger"`；移除 `"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"`（FencedConflict 改用 ledger.Mem 预置，见 Step 8）。`leaderMux` 改为：

```go
func leaderMux(ks *keystore.Keystore, policies *policy.Store, nowMs func() int64) http.Handler {
	return newMux(ks, policies, ledger.NewMem(), constFencer{epoch: 1, leader: true}, nowMs)
}
```

- [ ] **Step 7: 改 `main_test.go` — golden 测试补 cloid**

`TestSignL1Endpoint` 里构造 body 的匿名结构体加 `Cloid` 字段并赋值（params 不变）：

```go
	body, _ := json.Marshal(struct {
		KeyID     string          `json:"keyId"`
		Cloid     string          `json:"cloid"`
		Kind      string          `json:"kind"`
		Params    json.RawMessage `json:"params"`
		IsTestnet bool            `json:"isTestnet"`
	}{"k1", "golden-c1", v.Kind, v.Params, v.IsTestnet})
```

其余断言不变（out.R/S/V == 向量、out.Nonce == v.Nonce）。

- [ ] **Step 8: 改 `main_test.go` — `TestSignL1NotLeader` 与 `TestSignL1FencedConflict`**

`TestSignL1NotLeader`：把 `newMux(ks, policies, singlewriter.NewMem(), constFencer{epoch: 1, leader: false}, nil)` 改为 `newMux(ks, policies, ledger.NewMem(), constFencer{epoch: 1, leader: false}, nil)`（body 保持不变——503 在 Authorize 前返回，无需 cloid）。

`TestSignL1FencedConflict`：把预置块与 body 改为：

```go
	// A newer leader has already advanced this key's fence to 5 in the ledger's
	// single-writer state.
	auth := ledger.NewMem()
	if _, err := auth.Authorize(context.Background(), ledger.Request{
		KeyID: "k1", Cloid: "seed", Digest: [32]byte{9}, Fence: 5, Notional: 0, DailyCap: 0, NowMs: 1700000000000,
	}); err != nil {
		t.Fatalf("seed fence: %v", err)
	}
	srv := httptest.NewServer(newMux(ks, policies, auth, constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 }))
	defer srv.Close()
	body := `{"keyId":"k1","cloid":"req-c1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
```

其余断言（409 + error=="fenced"）不变。（`req-c1` 与 seed 的 `seed` 不同 → 走首见路径 → 陈旧 fence 1 < 5 → ErrFenced。）

- [ ] **Step 9: 编译 + 运行既有单测**

Run: `cd backend && go build ./cmd/signer && rm -f signer && go test ./cmd/signer/`
Expected: 编译通过；既有测试全 PASS（golden 逐字节一致、fenced 409、not-leader 503、policy 403、bad-params 400 均不受影响）。若某个 403/400 早拒测试意外变 400（missing cloid），说明 Authorize 被提前——核对 handler 顺序（policy/fence 在 Authorize 前）。

- [ ] **Step 10: 全量门 + 集成编译校验**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go test -c -tags=integration -o /dev/null ./cmd/signer/`
Expected: 全 PASS；vet/race 静默；集成编译成功（注：`main_integration_test.go` 尚未更新契约——若因 body 缺 cloid 导致其**运行**逻辑变化不影响**编译**；本步只要求编译通过。运行更新在 Task 2）。

- [ ] **Step 11: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): wire cloid ledger into /v1/sign/l1

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 新增幂等测试（单元 + 集成）

**Files:**
- Modify: `backend/cmd/signer/main_test.go`
- Modify: `backend/cmd/signer/main_integration_test.go`

- [ ] **Step 1: 写新单元测试（`main_test.go` 末尾追加）**

用 golden 的 key/签名做幂等断言：复用 `loadFirstGolden` 取 key/params/nonce。加一个辅助构造 body 的内联 marshal。三个用例：

```go
func TestSignL1IdempotentReplay(t *testing.T) {
	v := loadFirstGolden(t)
	key, err := hex.DecodeString(v.PrivKey)
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
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
	defer srv.Close()

	post := func(cloid, px string) (int, struct {
		R, S      string
		V         int
		Nonce     uint64
		Duplicate bool
	}) {
		params := v.Params
		if px != "" {
			params = json.RawMessage(`{"asset":0,"isBuy":true,"px":"` + px + `","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"}`)
		}
		body, _ := json.Marshal(map[string]any{"keyId": "k1", "cloid": cloid, "kind": v.Kind, "params": params, "isTestnet": v.IsTestnet})
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		var out struct {
			R, S      string
			V         int
			Nonce     uint64
			Duplicate bool
		}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	c1, o1 := post("c1", "")
	if c1 != 200 || o1.Duplicate {
		t.Fatalf("first: code=%d dup=%v, want 200 dup=false", c1, o1.Duplicate)
	}
	c2, o2 := post("c1", "")
	if c2 != 200 || !o2.Duplicate {
		t.Fatalf("replay: code=%d dup=%v, want 200 dup=true", c2, o2.Duplicate)
	}
	if o2.Nonce != o1.Nonce || o2.R != o1.R || o2.S != o1.S || o2.V != o1.V {
		t.Fatalf("replay sig/nonce differ: o1=%+v o2=%+v", o1, o2)
	}
}

func TestSignL1CloidReuseConflict(t *testing.T) {
	v := loadFirstGolden(t)
	key, _ := hex.DecodeString(v.PrivKey)
	ks := keystore.New()
	defer ks.Close()
	_ = ks.Add("k1", key)
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{v.Kind: true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
	defer srv.Close()

	post := func(px string) int {
		body := `{"keyId":"k1","cloid":"cx","kind":"order","params":{"asset":0,"isBuy":true,"px":"` + px + `","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if c := post("50000"); c != 200 {
		t.Fatalf("first px status = %d, want 200", c)
	}
	if c := post("51000"); c != 409 { // same cloid, different intent digest
		t.Fatalf("reuse status = %d, want 409", c)
	}
}

func TestSignL1MissingCloid(t *testing.T) {
	v := loadFirstGolden(t)
	key, _ := hex.DecodeString(v.PrivKey)
	ks := keystore.New()
	defer ks.Close()
	_ = ks.Add("k1", key)
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{v.Kind: true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("missing cloid status = %d, want 400", res.StatusCode)
	}
}
```

> 注：`loadFirstGolden` 返回的 `goldenVec` 字段名（`PrivKey`/`Params`/`Nonce`/`Kind`/`IsTestnet`/`Sig`）以 `main_test.go` 现有定义为准；实现时先看 `type goldenVec struct` 用真实字段名。若私钥字段非 `PrivKey`，用真实名。

- [ ] **Step 2: 运行新单测**

Run: `cd backend && go test ./cmd/signer/ -run 'Idempotent|CloidReuse|MissingCloid' -v`
Expected: 三个用例 PASS。

- [ ] **Step 3: 改 `main_integration_test.go` — 按 cloid 签名 + 幂等断言**

把 `sign` 闭包改为接受 cloid，两次有效签名用不同 cloid，再补一次首个 cloid 断言同 nonce：

```go
	sign := func(cloid string) (int, uint64) {
		body := `{"keyId":"k1","cloid":"` + cloid + `","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		var out struct {
			Nonce uint64 `json:"nonce"`
		}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out.Nonce
	}
```

轮询改用 `sign("c1")`（取 `n1`）；「第二次签名」改用 `sign("c2")` 断言 `n2 > n1`；随后补：

```go
	// Re-signing the FIRST cloid replays the original nonce (end-to-end idempotency).
	code3, n3 := sign("c1")
	if code3 != 200 {
		t.Fatalf("replay sign status = %d, want 200", code3)
	}
	if n3 != n1 {
		t.Fatalf("replay nonce n3=%d, want original n1=%d", n3, n1)
	}
```

（删除原来定义在 body 变量上的固定 `body :=`，改由 `sign` 内联构造。）

- [ ] **Step 4: 集成编译校验**

Run: `cd backend && go test -c -tags=integration -o /dev/null ./cmd/signer/`
Expected: 编译成功（无输出）。

- [ ] **Step 5: 全量门**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
Expected: 全 PASS；vet/race 静默；signer 构建成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main_test.go backend/cmd/signer/main_integration_test.go
git commit --no-verify -m "test(backend): idempotency + cloid-reuse coverage for signer wiring

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- 顶层 `cloid` 必填 + 响应 `duplicate` → Task 1 Step 1/3 ✅
- intent 摘要 `sha256(msgpack(action)‖testnet)` → Task 1 Step 3 ✅
- handler 用 ledger.Authorizer + 错误映射（400/409 新增，其余透传）→ Task 1 Step 3 ✅
- newMux/handleSignL1 签名 → Task 1 Step 3/4 ✅
- buildHandler 接线（内存 ledger.NewMem / Postgres ledgerpg）→ Task 1 Step 5 ✅
- golden 字节不变（cloid 解耦、params 不变）→ Task 1 Step 7 + Step 9 ✅
- 既有测试更新（leaderMux/NotLeader/FencedConflict）→ Task 1 Step 6/8 ✅
- 新增幂等/复用/缺失单测 → Task 2 Step 1 ✅
- 集成幂等断言 → Task 2 Step 3 ✅
- 验收门 → Task 1 Step 10 / Task 2 Step 5 ✅

**Placeholder scan：** 无 TBD/TODO；代码步骤均含完整代码。`goldenVec` 字段名以现有定义为准的注记已显式标注处理方式。

**Type consistency：** `ledger.Request{KeyID,Cloid,Digest,Fence,Notional,DailyCap,NowMs}` / `Grant{Nonce,Duplicate}` / `Authorize` 全程一致；`handleSignL1`/`newMux` 的 `auth ledger.Authorizer` 参数一致；`ledgerpg.New`/`ledgerpg.EnsureSchema` 与 import 别名一致；错误 `ledger.ErrMissingCloid`/`ledger.ErrCloidReuse` + 透传 `singlewriter.Err*` 一致。
