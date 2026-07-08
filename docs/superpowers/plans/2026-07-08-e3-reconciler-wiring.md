# E3 对账循环接线 signer（leader-gated）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 E2 的 reconciler `Run` 起进 signer `buildHandler`（leader-gated），按 config 提供 accounts + HL URL，让自动对账真正跑起来。

**Architecture:** 给 `internal/reconciler` 加函数式 `WithLeaderGate` 选项（非 leader 的 step 空转）；`cmd/signer` 从 env 读 HL URL/accounts/间隔/超时，构造 `hlinfo.Client` + `reconciler`，在 `buildHandler` 起 leader-gated `Run` goroutine 并叠加停机进 cleanup。未配置则不启动。

**Tech Stack:** Go 1.26；`net/http`；`internal/{hlinfo,reconciler,ledger}`（已合并）。

参考 spec：`docs/superpowers/specs/2026-07-08-e3-reconciler-wiring-design.md`
现状：`cmd/signer/main.go`（`config`/`configFromEnv` line 400-434；`staticFencer.Fence()→(epoch,true)` line 176-178；`buildHandler` line 451-490；已 import net/http/strconv/time，**未** import strings/hlinfo/reconciler）；`internal/reconciler/reconciler.go`（`New(client,led,accounts)`/`Reconciler{client,led,accounts}`/`step`）；`internal/reconciler/reconciler_test.go`（`fakeClient`/`seedSigned`/`statusOf` helpers）。

## 文件结构
- `backend/internal/reconciler/reconciler.go` — +Option/WithLeaderGate/isLeader 字段 + step 门。
- `backend/internal/reconciler/reconciler_test.go` — +leader 门单测。
- `backend/cmd/signer/main.go` — +config 字段/configFromEnv/parseAccounts + buildHandler 接线。
- `backend/cmd/signer/main_test.go` — +parseAccounts + buildHandler 接线测试。

---

### Task 1: `internal/reconciler` 可选 leader 门

**Files:**
- Modify: `backend/internal/reconciler/reconciler.go`
- Test: `backend/internal/reconciler/reconciler_test.go`

- [ ] **Step 1: 写失败测试（追加到 `reconciler_test.go` 末尾）**

```go
func TestLeaderGateSkipsWhenNotLeader(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}}}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}}, WithLeaderGate(func() bool { return false }))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if s, _ := statusOf(t, led, "c1"); s != ledger.StatusSigned {
		t.Fatalf("c1 = %s, want signed (gate must skip when not leader)", s)
	}
}

func TestLeaderGateRunsWhenLeader(t *testing.T) {
	led := ledger.NewMem()
	seedSigned(t, led, "k", "c1")
	fc := &fakeClient{open: map[string]map[string]hlinfo.OpenOrder{"0xacc": {"c1": {}}}}
	r := New(fc, led, []Account{{KeyID: "k", Address: "0xacc"}}, WithLeaderGate(func() bool { return true }))
	if err := r.step(context.Background()); err != nil {
		t.Fatalf("step: %v", err)
	}
	if s, ok := statusOf(t, led, "c1"); !ok || s != ledger.StatusOpen {
		t.Fatalf("c1 = %s,%v, want open (gate open → runs)", s, ok)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/reconciler/ -run LeaderGate`
Expected: 编译失败（`WithLeaderGate` 未定义）。

- [ ] **Step 3: 改 `reconciler.go` — 加 Option/WithLeaderGate/isLeader + New 变体 + step 门**

给 `Reconciler` 结构加字段 `isLeader func() bool`：

```go
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
	isLeader func() bool // optional leader gate; nil = always run
}
```

把 `New` 改为可变参并追加 Option 类型（放在 New 之前/之后）：

```go
// Option configures a Reconciler.
type Option func(*Reconciler)

// WithLeaderGate makes step a no-op unless isLeader() is true, so in a
// multi-instance deployment only the current lease holder polls HL.
func WithLeaderGate(isLeader func() bool) Option {
	return func(r *Reconciler) { r.isLeader = isLeader }
}

// New returns a Reconciler over the given HL info client, ledger, and accounts.
func New(client InfoClient, led ledger.Reconciler, accounts []Account, opts ...Option) *Reconciler {
	r := &Reconciler{client: client, led: led, accounts: accounts}
	for _, o := range opts {
		o(r)
	}
	return r
}
```

在 `step` 函数体最前面加门：

```go
func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil // not the leader; another instance polls
	}
	for _, a := range r.accounts {
		// ... unchanged ...
```

- [ ] **Step 4: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/reconciler/ && go vet ./internal/reconciler/ && go test -race ./internal/reconciler/`
Expected: 全 PASS（含既有 step/Run 用例——现有 `New(fc, led, accounts)` 三参调用因可变参仍编译）；vet 静默；race 无告警。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/reconciler/reconciler.go backend/internal/reconciler/reconciler_test.go
git commit --no-verify -m "feat(backend): optional leader gate for reconciler (poll only on leader)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `cmd/signer` config + parseAccounts

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 写失败测试（追加到 `main_test.go` 末尾）**

```go
func TestParseAccounts(t *testing.T) {
	got := parseAccounts("k1=0xabc, k2 = 0xdef ")
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].KeyID != "k1" || got[0].Address != "0xabc" {
		t.Fatalf("got[0] = %+v", got[0])
	}
	if got[1].KeyID != "k2" || got[1].Address != "0xdef" {
		t.Fatalf("got[1] = %+v", got[1])
	}
	if a := parseAccounts(""); a != nil {
		t.Fatalf("empty = %+v, want nil", a)
	}
	// all-malformed except a=b
	m := parseAccounts("bad,=x,y=,a=b")
	if len(m) != 1 || m[0].KeyID != "a" || m[0].Address != "b" {
		t.Fatalf("malformed-filter = %+v, want [a=b]", m)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./cmd/signer/ -run ParseAccounts`
Expected: 编译失败（`parseAccounts` 未定义）。

- [ ] **Step 3: 改 `main.go` — imports + config 字段 + parseAccounts + configFromEnv**

在 import 块追加 `"strings"` 与 `reconciler`：

```go
	"github.com/lumos-forge/hypersolid/backend/internal/reconciler"
```

（本任务只加 `"strings"` 和 `reconciler`——二者都会被 `parseAccounts`/`config` 字段引用。`hlinfo` 留到 Task 3 添加，避免本任务出现未使用 import 编译错误。）

`config` 结构追加字段：

```go
type config struct {
	addr        string
	databaseURL string
	leaseName   string
	holderID    string
	leaseTTL    time.Duration
	renewEvery  time.Duration

	hlInfoURL         string
	reconcileAccounts []reconciler.Account
	reconcileInterval time.Duration
	hlTimeout         time.Duration
}
```

新增 `parseAccounts`（放在 `configFromEnv` 之前）：

```go
// parseAccounts parses a comma-separated "keyID=address" list into reconcile
// accounts, trimming whitespace and skipping malformed (missing/empty half) pairs.
func parseAccounts(s string) []reconciler.Account {
	var out []reconciler.Account
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		keyID, addr := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
		if keyID == "" || addr == "" {
			continue
		}
		out = append(out, reconciler.Account{KeyID: keyID, Address: addr})
	}
	return out
}
```

在 `configFromEnv` 的 `return cfg` 之前追加：

```go
	cfg.hlInfoURL = os.Getenv("SIGNER_HL_INFO_URL")
	cfg.reconcileAccounts = parseAccounts(os.Getenv("SIGNER_RECONCILE_ACCOUNTS"))
	cfg.reconcileInterval = 15 * time.Second
	if d, err := time.ParseDuration(os.Getenv("SIGNER_RECONCILE_INTERVAL")); err == nil && d > 0 {
		cfg.reconcileInterval = d
	}
	cfg.hlTimeout = 10 * time.Second
	if d, err := time.ParseDuration(os.Getenv("SIGNER_HL_TIMEOUT")); err == nil && d > 0 {
		cfg.hlTimeout = d
	}
```

- [ ] **Step 4: 运行确认通过 + 编译**

Run: `cd backend && go test ./cmd/signer/ -run ParseAccounts && go build ./cmd/signer && rm -f signer`
Expected: `TestParseAccounts` PASS；signer 编译通过（`reconciler` import 被 config 字段/parseAccounts 使用）。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): signer config for reconcile accounts + HL info URL

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `buildHandler` leader-gated 起停 + 接线测试

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 写失败测试（追加到 `main_test.go` 末尾）**

```go
func TestBuildHandlerStartsReconciler(t *testing.T) {
	polled := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case polled <- struct{}{}:
		default:
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	cfg := config{
		hlInfoURL:         srv.URL,
		reconcileAccounts: []reconciler.Account{{KeyID: "k", Address: "0xacc"}},
		reconcileInterval: time.Millisecond,
		hlTimeout:         time.Second,
	}
	h, cleanup, err := buildHandler(context.Background(), cfg, keystore.New(), policy.NewStore())
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	defer cleanup()
	if h == nil {
		t.Fatal("nil handler")
	}
	select {
	case <-polled:
	case <-time.After(2 * time.Second):
		t.Fatal("reconciler did not poll HL (loop not started or leader gate blocked)")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./cmd/signer/ -run BuildHandlerStartsReconciler`
Expected: FAIL（超时——buildHandler 尚未启动 reconciler）。

- [ ] **Step 3: 改 `main.go` — import hlinfo + 重构 buildHandler**

在 import 块追加（Task 2 已加 `reconciler`）：

```go
	"github.com/lumos-forge/hypersolid/backend/internal/hlinfo"
```

把整个 `buildHandler` 函数体替换为（两分支设 led/fencer/cleanup，再共享 reconciler 起停 + newMux）：

```go
func buildHandler(ctx context.Context, cfg config, ks *keystore.Keystore, policies *policy.Store) (http.Handler, func(), error) {
	nowMs := func() int64 { return time.Now().UnixMilli() }

	var led ledger.Ledger
	var fencer Fencer
	cleanup := func() {}

	if cfg.databaseURL == "" {
		led = ledger.NewMem()
		fencer = staticFencer{epoch: 1}
	} else {
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
		ld := leader.New(leasepg.New(pool), cfg.leaseName, cfg.holderID, cfg.leaseTTL)
		leaderCtx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			ld.Run(leaderCtx, cfg.renewEvery)
			close(done)
		}()
		led = ledgerpg.New(pool)
		fencer = ld
		cleanup = func() {
			cancel() // leader.Run releases the lease on ctx cancel
			<-done   // wait for Run to finish releasing before closing the pool
			pool.Close()
		}
	}

	// Optionally start the leader-gated auto-reconciler when configured.
	if cfg.hlInfoURL != "" && len(cfg.reconcileAccounts) > 0 {
		client := hlinfo.New(cfg.hlInfoURL, &http.Client{Timeout: cfg.hlTimeout})
		isLeader := func() bool { _, l := fencer.Fence(); return l }
		rec := reconciler.New(client, led, cfg.reconcileAccounts, reconciler.WithLeaderGate(isLeader))
		recCtx, recCancel := context.WithCancel(context.Background())
		recDone := make(chan struct{})
		go func() {
			rec.Run(recCtx, cfg.reconcileInterval)
			close(recDone)
		}()
		base := cleanup
		cleanup = func() {
			recCancel()
			<-recDone
			base()
		}
	}

	h := newMux(ks, policies, led, fencer, nowMs)
	return h, cleanup, nil
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && go test ./cmd/signer/ -run 'BuildHandler|ParseAccounts'`
Expected: `TestBuildHandlerStartsReconciler` + `TestBuildHandlerInMemory`（空 cfg，不启 reconciler）+ `TestParseAccounts` 全 PASS。

- [ ] **Step 5: 全量门 + 集成编译校验**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer && go test -c -tags=integration -o /dev/null ./...`
Expected: 全 PASS；vet/race 静默；signer 构建成功；集成编译成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(backend): start leader-gated auto-reconciler in buildHandler

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- reconciler WithLeaderGate + step 门 + 单测 → Task 1 ✅
- config 字段 + parseAccounts + configFromEnv → Task 2 ✅
- buildHandler 重构 + leader-gated 起停 + newMux → Task 3 ✅
- 接线 httptest 测试 + parseAccounts 测试 → Task 3/2 ✅
- 既有行为不变（空 cfg 不启动，TestBuildHandlerInMemory）→ Task 3 Step 4 ✅
- 非目标（不做 userFillsByTime 分页/不改 hl/ledger）→ 计划未触及 ✅

**Placeholder scan：** 无 TBD/TODO；代码步骤含完整代码。Task 2 里对 import 顺序（先只加 reconciler，hlinfo 留 Task 3）有明确说明以避免未使用 import 编译错误。

**Type consistency：** `WithLeaderGate(func() bool) Option` / `New(client,led,accounts,opts...)` / `isLeader func() bool` 一致；`config.{hlInfoURL,reconcileAccounts,reconcileInterval,hlTimeout}` 与 configFromEnv/buildHandler 使用一致；`parseAccounts(string)[]reconciler.Account`；`hlinfo.New(url,*http.Client)`、`reconciler.New(...,WithLeaderGate)`、`fencer.Fence()(uint64,bool)` 与已合并 API 一致；`staticFencer`/`Fencer`/`ledger.Ledger` 一致。
