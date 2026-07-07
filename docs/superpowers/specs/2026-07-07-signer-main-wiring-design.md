# main() 后端接线（leader + Postgres）+ 优雅关停设计

> M6 单写者「接线 /v1/sign/l1」的**第 3 部分（收尾）**。承接端点接线（PR #32）。把 `leader.Leader` + Postgres（`singlewriter/pg` + `lease/pg`）接入 `cmd/signer` 的 `main()`，让 `Fencer` 提供的 fence 变为**真实租约 epoch**，实现端到端跨主机单写者。

## 背景与目标

part 2 已让 `/v1/sign/l1` 走 `singlewriter.Writer.Authorize` + `Fencer` 闸门，但 `main()` 仍是内存单实例（`singlewriter.NewMem()` + `staticFencer{1}`）——fence 恒为 1、不来自租约。本切片把 `main()` 按 `DATABASE_URL` 选择后端：

- **未设 `DATABASE_URL`**：内存单实例（现状：`NewMem` + `staticFencer{1}`，无 goroutine、无 DB）。
- **设了 `DATABASE_URL`**：Postgres 跨主机模式——`pgxpool` + 两张表 `EnsureSchema` + `singlewriter/pg.PgWriter`（真单写者）+ `lease/pg.PgStore` + 后台 `leader.Run`（持有并续约租约），`Fencer` 即 `leader.Leader`，其 `Fence()` 的 epoch 作为每个 key 的 `Request.Fence`。

至此 5 个组件（core / pg writer / lease / leader / endpoint）串成端到端：换主时 leader epoch 抬升 → 旧 leader 在 `PgWriter.Authorize` 被 fence，跨主机不双写。

## 范围

- `cmd/signer/main.go`：新增 `config` + `configFromEnv` + `buildHandler`（后端选择、装配、返回 cleanup）+ `main()` 重写（信号驱动优雅关停）。
- 测试：内存分支单测；Postgres 分支 testcontainers 端到端集成测试。

**非目标**：生产密钥/policy 加载（signer 仍启动为空 keystore；密钥按授权下发是独立议题）；leader 选举以外的多 AZ 编排 / 指标 / 限频（M7/M10）。

## 自主设计决策（记录备查）

- **可测性优先**：`main()` 不可单测，故把「装配」抽成 `buildHandler(ctx, cfg, ks, policies) → (http.Handler, cleanup func(), error)`，`main()` 只做 env→cfg、信号关停、`ListenAndServe`。`ks`/`policies` 作为参数注入：生产传空（现状），测试传入带 key 的 keystore 以做端到端签名。
- **standby 模型**：Postgres 模式下立即开始服务；后台 `leader.Run` 在 ~`renewEvery` 内首次 acquire；在成为 leader 前，签名请求命中 `Fencer` 闸门返回 **503**（fail-closed，绝不在领导权未定时签名）。启动窗口的短暂 503 是 HA 常态，客户端重试。
- **优雅关停**：`signal.NotifyContext(SIGINT/SIGTERM)` → `srv.Shutdown`（停收新连接、排空）→ `cleanup`（cancel leaderCtx 使 `Run` 释放租约、**等 `Run` 收尾后**再 `pool.Close()`，避免释放前关池的竞态）。及时释放租约 → 快速故障切换。
- **启动恢复 = 持久状态天然恢复**：无专门恢复代码。重启后 `EnsureSchema` 幂等；leader 重新 acquire（epoch 抬升，自我 fence 掉不存在的旧 in-flight）；`sw_state` nonce 高水位持久 → 不回退。
- **默认参数**：`leaseTTL=15s`、`renewEvery=5s`（`renewEvery ≪ ttl`）；`leaseName` 默认 `"signer-leader"`；`holderID` 默认 `hostname-pid-<random hex>`。TTL/interval 本片不做 env 覆盖（YAGNI）。

## 组件

### `config` 与 `configFromEnv`

```go
type config struct {
	addr        string
	databaseURL string
	leaseName   string
	holderID    string
	leaseTTL    time.Duration
	renewEvery  time.Duration
}

// configFromEnv reads SIGNER_ADDR / DATABASE_URL / SIGNER_LEASE_NAME /
// SIGNER_HOLDER_ID and fills sensible defaults.
func configFromEnv() config

// defaultHolderID returns hostname-pid-<random hex>, a per-process lease identity.
func defaultHolderID() string
```

默认：`addr` 空→`127.0.0.1:8087`；`leaseName` 空→`signer-leader`；`holderID` 空→`defaultHolderID()`；`leaseTTL=15s`、`renewEvery=5s`。

### `buildHandler`

```go
// buildHandler assembles the signing router for cfg, using the given keystore and
// policy store. With an empty DATABASE_URL it wires a single-instance in-memory
// single-writer + always-leader fencer. Otherwise it opens a pgxpool, ensures both
// schemas, and wires the Postgres single-writer + a lease-backed leader (started in
// the background). The returned cleanup cancels the leader (releasing the lease) and
// closes the pool. On any setup error the pool is closed and the error is returned.
func buildHandler(ctx context.Context, cfg config, ks *keystore.Keystore, policies *policy.Store) (http.Handler, func(), error)
```

- **内存分支**（`cfg.databaseURL == ""`）：`newMux(ks, policies, singlewriter.NewMem(), staticFencer{epoch:1}, realClock)`，`cleanup = func(){}`。
- **Postgres 分支**：
  1. `pool, err := pgxpool.New(ctx, cfg.databaseURL)`（err→包装返回）。
  2. `swpg.EnsureSchema(ctx, pool)`、`leasepg.EnsureSchema(ctx, pool)`（任一 err→`pool.Close()`+返回）。
  3. `writer := swpg.New(pool)`；`store := leasepg.New(pool)`；`ld := leader.New(store, cfg.leaseName, cfg.holderID, cfg.leaseTTL)`。
  4. `leaderCtx, cancel := context.WithCancel(context.Background())`；`done := make(chan struct{})`；`go func(){ ld.Run(leaderCtx, cfg.renewEvery); close(done) }()`。
  5. `cleanup := func(){ cancel(); <-done; pool.Close() }`（先让 `Run` 释放租约收尾，再关池）。
  6. `newMux(ks, policies, writer, ld, realClock)`。

`realClock := func() int64 { return time.Now().UnixMilli() }`。编译期断言 `var _ Fencer = (*leader.Leader)(nil)`。

### `main()`

```go
func main() {
	cfg := configFromEnv()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ks := keystore.New()
	policies := policy.NewStore()
	h, cleanup, err := buildHandler(ctx, cfg, ks, policies)
	if err != nil {
		log.Fatal(err)
	}
	defer cleanup()
	srv := &http.Server{Addr: cfg.addr, Handler: h}
	go func() {
		<-ctx.Done()
		sc, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = srv.Shutdown(sc)
	}()
	log.Printf("signer service listening on %s (db=%t)", cfg.addr, cfg.databaseURL != "")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
```

关停顺序：信号 → `ctx.Done` → `srv.Shutdown`（goroutine）→ `ListenAndServe` 返回 `ErrServerClosed` → `defer cleanup()`（释放租约、关池）。

## 测试

- **内存分支单测** `TestBuildHandlerInMemory`（无 DB）：`buildHandler(ctx, config{}, keystore.New(), policy.NewStore())` → `/healthz` 200；`/v1/sign/l1` 未知 key → 404（证明路由装配正确）；`cleanup()` 可调用。
- **Postgres 端到端集成测试** `TestBuildHandlerPostgresEndToEnd`（`//go:build integration`，testcontainers `postgres:17-alpine`）：
  1. 起容器取 DSN；构造 `cfg{databaseURL:dsn, leaseName:"t", holderID:"a", leaseTTL:15s, renewEvery:50ms}`。
  2. `ks` 加一个测试 key（`bytes.Repeat({0x11},32)`）；`policies` 允许 `order`、`MaxNotionalUsdc:1e12`。
  3. `h, cleanup, err := buildHandler(ctx, cfg, ks, policies)`；`defer cleanup()`；`srv := httptest.NewServer(h)`。
  4. 轮询 `POST /v1/sign/l1`（合法 order）直到 **200**（leader 就绪，≤2s）——证明 `pgxpool`+两表 schema + `PgWriter.Authorize`（真 Postgres 单写者）+ `PgStore` 租约 + `leader.Run` acquire + fence 传参 + nonce 生成 端到端打通。
  5. 再签一次，断言 **nonce 严格递增**（`PgWriter` 高水位）。

## 验证门

- 无 Docker 基线：`cd backend && go test ./... && go vet ./... && go build ./...` 全绿（cmd/signer 集成测试被标签跳过；内存单测跑）。
- 集成编译校验：`go test -c -tags=integration -o /dev/null ./cmd/signer/` 通过；**真跑由 CI**（backend job 已 `-tags=integration`）拉起 Postgres 端到端签名。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅改 `cmd/signer/{main.go, main_integration_test.go(新), main_test.go(可能加内存单测)}` + `go.mod`/`go.sum`（若 tidy 无新增依赖则不变——pgxpool/testcontainers 已在）+ 两份 docs。不改 `internal/*`。

## 备注

- 依赖已就位（PR #29/#30 引入 pgx + testcontainers）；本片仅在 `cmd/signer` 组合它们，`go mod tidy` 应无新增。
- 生产密钥/policy 仍需后续「密钥托管/下发」切片；本片 signer 启动为空 keystore（fail-closed）。
- CI 现有三个集成包（lease/pg、singlewriter/pg、cmd/signer）并行起 Postgres；`postgres:17-alpine` 已在 CI 预拉取（PR #30），避免并发拉取竞态。
