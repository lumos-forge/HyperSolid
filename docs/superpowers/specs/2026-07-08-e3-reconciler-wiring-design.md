# M6 意图账本 · 对账循环接线 signer（leader-gated）— 子项目 E3

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）；A(#39)+C(#40)+B(#41)+D(#42)+E1E2(#43) 已合并

## 背景

E1+E2（PR #43）交付了只读 HL info 客户端与自动对账 `Reconciler`（`step`/`Run`），但**未接线**——
无人启动 `Run`。本子项目 E3 把对账循环起进 signer `buildHandler`：按 config 提供 accounts +
HL URL，多实例（Postgres HA）下**只在 leader 实例轮询**（避免冗余 HL 请求）。

## 目标

- `internal/reconciler` 加**可选 leader 门**（`WithLeaderGate`），非 leader 的 `step` 跳过轮询。
- `cmd/signer` 从 env 读 HL URL / accounts / 间隔 / 超时，构造 `hlinfo.Client` + `reconciler`，
  在 `buildHandler` 起 `Run` goroutine（leader-gated），并把停机叠加进现有 `cleanup`。
- 未配置（无 HL URL 或无 accounts）→ 不启动，现有行为逐字节不变。

## 非目标（YAGNI）

- 不做 `userFillsByTime` 分页补 2000-fill 窗口限制（记为已知限制；孤儿端点 `/v1/orphans` 仍兜底；后续）。
- 不做跨实例限频协调（=M10）。
- 不改 `internal/hl`、`internal/ledger`；不改签名/对账端点逻辑。

## 改动

### 1. `internal/reconciler` 可选 leader 门

函数式选项（向后兼容——现有 `New(client, led, accounts)` 三参调用不变）：

```go
// Option configures a Reconciler.
type Option func(*Reconciler)

// WithLeaderGate makes step a no-op unless isLeader() is true, so in a multi-instance
// deployment only the current lease holder polls HL (avoids redundant requests).
func WithLeaderGate(isLeader func() bool) Option {
	return func(r *Reconciler) { r.isLeader = isLeader }
}

// New now accepts optional Options.
func New(client InfoClient, led ledger.Reconciler, accounts []Account, opts ...Option) *Reconciler {
	r := &Reconciler{client: client, led: led, accounts: accounts}
	for _, o := range opts {
		o(r)
	}
	return r
}
```

`Reconciler` 加字段 `isLeader func() bool`（nil = 不设门，恒运行）。`step` 开头：

```go
func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil // not the leader; another instance polls
	}
	// ... existing per-account loop ...
}
```

测试（`reconciler_test.go` 追加）：
- 非 leader（`WithLeaderGate(func() bool { return false })`）：播种 signed "c1"、fake open={c1} → `step` 无错且账本**不变**（c1 仍 signed）。
- leader（`WithLeaderGate(func() bool { return true })`）：同上 → c1 变 open（门放行）。

### 2. `cmd/signer` config + parseAccounts

`config` 新增字段：

```go
	hlInfoURL         string
	reconcileAccounts []reconciler.Account
	reconcileInterval time.Duration
	hlTimeout         time.Duration
```

`configFromEnv` 追加（import `strings`、`reconciler`）：

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

纯 `parseAccounts`（`SIGNER_RECONCILE_ACCOUNTS` 形如 `k1=0xabc,k2=0xdef`）：

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

测试：合法多对（去空白）、空串 → nil、全畸形（`bad,=x,y=,a=b`）→ 仅 `a=b`。

### 3. `buildHandler` 重构 + leader-gated 起停

重构为两分支各设 `led ledger.Ledger` / `fencer Fencer` / `cleanup func()`（内存 staticFencer；
Postgres leader，原逻辑与错误早返不变），再**共享**尾段：

```go
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
```

- 内存单实例 staticFencer 恒 leader → 轮询照跑；Postgres 仅 leader 轮询。
- 未配置 → 不启动，`cleanup` 与行为不变（`TestBuildHandlerInMemory` 空 cfg 仍过）。
- `import` 追加 `internal/hlinfo`、`internal/reconciler`。

测试（`main_test.go`，httptest，无 Docker）：
- `TestBuildHandlerStartsReconciler`：httptest server（回 `[]` 并在收到请求时向 channel 发信号）作 HL URL；
  cfg 设 accounts + 1ms interval + 1s timeout；`buildHandler`（空 DATABASE_URL）→ 等 server 收到轮询请求
  （证明循环在跑、staticFencer 恒 leader 放行）→ `cleanup()` 优雅停。
- 既有 `TestBuildHandlerInMemory` 不变。

## 数据流（接线后）

signer 启动 → `buildHandler` 若配置了 HL URL+accounts → 起 `reconciler.Run`（每 `interval`）→
leader 实例 `step` 拉每 account 的 HL open/fills → `Reconcile` 推进账本 → 非 leader 实例 `step` 空转。
进程收到 SIGTERM → `run` 的 `cleanup` → `recCancel()` 停对账 → 停 leader/关 pool。

## 错误处理

- 未配置 → 不起 goroutine（零开销）。
- 对账 `step` 错误由 `Run` 记录（`log.Printf`）不致命，下轮重试。
- HL 客户端 `hlTimeout` 超时 → 该轮 `step` 返回 error（记录）→ 下轮重试，不卡死循环。

## 验收门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./...`
