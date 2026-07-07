# main() 后端接线（leader + Postgres）+ 优雅关停 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `cmd/signer` 的 `main()` 按 `DATABASE_URL` env-gate：空→内存单实例；设了→Postgres（`pgxpool` + `singlewriter/pg` + `lease/pg` + 后台 `leader.Run`，fencer=leader），并做信号驱动的优雅关停（关停时释放租约）。装配逻辑抽成可测的 `buildHandler`。

**Architecture:** `buildHandler(ctx, cfg, ks, policies) → (http.Handler, cleanup, error)` 选后端并装配；`main()` 只做 env→cfg、`signal.NotifyContext`、`srv.Shutdown`、`defer cleanup()`。standby 模型：立即服务，非 leader→503（fail-closed）。启动恢复靠持久 Postgres 状态（无专门代码）。

**Tech Stack:** Go 1.26；`github.com/jackc/pgx/v5/pgxpool`；`internal/{keystore,policy,singlewriter,leader}` + `internal/singlewriter/pg`（别名 `swpg`）+ `internal/lease/pg`（别名 `leasepg`）；testcontainers（仅 `//go:build integration`）。均已在 go.mod（PR #29/#30）。

---

## File Structure

- `backend/cmd/signer/main.go` — 加 `config`/`configFromEnv`/`defaultHolderID`/`buildHandler` + `main()` 重写。（Task 1）
- `backend/cmd/signer/main_test.go` — 加 `TestBuildHandlerInMemory`（内存分支单测）。（Task 1）
- `backend/cmd/signer/main_integration_test.go` — 新增，`//go:build integration`，Postgres 端到端。（Task 2）

> 现有（part 2 后）：`handleSignL1`/`newMux(ks, policies, writer singlewriter.Writer, fencer Fencer, nowMs)`、`Fencer` 接口、`staticFencer{epoch}`。`leader.New(store, name, holder, ttl)`、`leader.Leader.Fence() (uint64,bool)`、`Run(ctx, every)`；`swpg.EnsureSchema/New`；`leasepg.EnsureSchema/New`；`singlewriter.NewMem()`。模块路径 `github.com/lumos-forge/hypersolid/backend`。提交用 `--no-verify` + `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer。本机无 Docker——集成测试只**编译校验**。

---

### Task 1: config + buildHandler + main 重写 + 内存单测

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: 替换 main.go 的 import 块**

把 `backend/cmd/signer/main.go` 当前 import 块替换为：
```go
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/leader"
	leasepg "github.com/lumos-forge/hypersolid/backend/internal/lease/pg"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
	swpg "github.com/lumos-forge/hypersolid/backend/internal/singlewriter/pg"
)
```

- [ ] **Step 2: 新增 `config`/`configFromEnv`/`defaultHolderID`/`buildHandler` + Fencer 断言（插在 `newMux` 之后、`main` 之前）**

在 main.go 中 `newMux` 函数右花括号之后、`func main()` 之前插入：
```go
// Fencer is satisfied by leader.Leader (compile-time check).
var _ Fencer = (*leader.Leader)(nil)

// config is the signer's runtime configuration.
type config struct {
	addr        string
	databaseURL string
	leaseName   string
	holderID    string
	leaseTTL    time.Duration
	renewEvery  time.Duration
}

// configFromEnv reads SIGNER_ADDR / DATABASE_URL / SIGNER_LEASE_NAME /
// SIGNER_HOLDER_ID and fills sensible defaults. A non-empty DATABASE_URL selects
// the Postgres cross-host backend; otherwise the signer runs single-instance.
func configFromEnv() config {
	cfg := config{
		addr:        os.Getenv("SIGNER_ADDR"),
		databaseURL: os.Getenv("DATABASE_URL"),
		leaseName:   os.Getenv("SIGNER_LEASE_NAME"),
		holderID:    os.Getenv("SIGNER_HOLDER_ID"),
		leaseTTL:    15 * time.Second,
		renewEvery:  5 * time.Second,
	}
	if cfg.addr == "" {
		cfg.addr = "127.0.0.1:8087"
	}
	if cfg.leaseName == "" {
		cfg.leaseName = "signer-leader"
	}
	if cfg.holderID == "" {
		cfg.holderID = defaultHolderID()
	}
	return cfg
}

// defaultHolderID returns hostname-pid-<random hex>, a per-process lease identity.
func defaultHolderID() string {
	host, _ := os.Hostname()
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s-%d-%s", host, os.Getpid(), hex.EncodeToString(b[:]))
}

// buildHandler assembles the signing router for cfg using the given keystore and
// policy store. With an empty DATABASE_URL it wires a single-instance in-memory
// single-writer + an always-leader fencer. Otherwise it opens a pgxpool, ensures
// both schemas, and wires the Postgres single-writer + a lease-backed leader
// started in the background. The returned cleanup cancels the leader (releasing
// the lease) and closes the pool; on any setup error the pool is closed and the
// error returned.
func buildHandler(ctx context.Context, cfg config, ks *keystore.Keystore, policies *policy.Store) (http.Handler, func(), error) {
	nowMs := func() int64 { return time.Now().UnixMilli() }

	if cfg.databaseURL == "" {
		h := newMux(ks, policies, singlewriter.NewMem(), staticFencer{epoch: 1}, nowMs)
		return h, func() {}, nil
	}

	pool, err := pgxpool.New(ctx, cfg.databaseURL)
	if err != nil {
		return nil, nil, fmt.Errorf("signer: pgxpool: %w", err)
	}
	if err := swpg.EnsureSchema(ctx, pool); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("signer: singlewriter schema: %w", err)
	}
	if err := leasepg.EnsureSchema(ctx, pool); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("signer: lease schema: %w", err)
	}

	writer := swpg.New(pool)
	store := leasepg.New(pool)
	ld := leader.New(store, cfg.leaseName, cfg.holderID, cfg.leaseTTL)

	leaderCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		ld.Run(leaderCtx, cfg.renewEvery)
		close(done)
	}()
	cleanup := func() {
		cancel() // leader.Run releases the lease on ctx cancel
		<-done   // wait for Run to finish releasing before closing the pool
		pool.Close()
	}

	h := newMux(ks, policies, writer, ld, nowMs)
	return h, cleanup, nil
}
```

- [ ] **Step 3: 替换 `main`**

把 main.go 的整个 `main` 函数替换为：
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

- [ ] **Step 4: 加内存分支单测**

在 `backend/cmd/signer/main_test.go` 末尾追加（`context`/`strings`/`net/http`/`httptest`/`keystore`/`policy` 均已 import）：
```go
func TestBuildHandlerInMemory(t *testing.T) {
	h, cleanup, err := buildHandler(context.Background(), config{}, keystore.New(), policy.NewStore())
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	defer cleanup()
	srv := httptest.NewServer(h)
	defer srv.Close()

	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("healthz status = %d, want 200", res.StatusCode)
	}
	// The sign route is wired; an unknown key returns 404 (empty keystore).
	body := `{"keyId":"nope","kind":"order","params":{"asset":0,"isBuy":true,"px":"1","sz":"1","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	sr, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sr.Body.Close()
	if sr.StatusCode != 404 {
		t.Fatalf("sign unknown key status = %d, want 404", sr.StatusCode)
	}
}
```

- [ ] **Step 5: 构建 + 全量 + vet + tidy**

Run: `cd backend && go build ./cmd/signer && go test ./cmd/signer/ && go vet ./cmd/signer/`
Expected: 构建成功；`TestBuildHandlerInMemory` 及既有用例全过；vet 无输出。
Run: `cd backend && go mod tidy && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Expected: 全绿；`go mod tidy` 稳定（无新增依赖——pgxpool 已在）；signer 构建成功（二进制已删）。

- [ ] **Step 6: 提交**

```bash
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go backend/go.mod backend/go.sum
git commit --no-verify -m "feat(backend): main() env-gated Postgres/leader wiring + graceful shutdown

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Postgres 端到端集成测试

**Files:**
- Create: `backend/cmd/signer/main_integration_test.go`（`//go:build integration`）

- [ ] **Step 1: 写集成测试**

创建 `backend/cmd/signer/main_integration_test.go`：
```go
//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
)

func TestBuildHandlerPostgresEndToEnd(t *testing.T) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("signer"),
		tcpostgres.WithUsername("signer"),
		tcpostgres.WithPassword("signer"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2),
		),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	defer func() { _ = container.Terminate(ctx) }()
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("dsn: %v", err)
	}

	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add key: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})

	cfg := config{
		databaseURL: dsn,
		leaseName:   "signer-leader",
		holderID:    "a",
		leaseTTL:    15 * time.Second,
		renewEvery:  50 * time.Millisecond,
	}
	h, cleanup, err := buildHandler(ctx, cfg, ks, policies)
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	defer cleanup()
	srv := httptest.NewServer(h)
	defer srv.Close()

	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	sign := func() (int, uint64) {
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

	// Poll until the background leader has acquired the lease (503 → 200). This
	// exercises the whole stack: pgxpool + both schemas + PgWriter.Authorize (real
	// Postgres single-writer) + PgStore lease + leader.Run + fence + nonce.
	var n1 uint64
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, n := sign()
		if code == 200 {
			n1 = n
			break
		}
		if code != 503 {
			t.Fatalf("unexpected sign status %d before leadership", code)
		}
		if time.Now().After(deadline) {
			t.Fatal("leader did not acquire within timeout")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A second sign advances the persisted nonce high-water strictly.
	code, n2 := sign()
	if code != 200 {
		t.Fatalf("second sign status = %d, want 200", code)
	}
	if n2 <= n1 {
		t.Fatalf("nonce n2=%d not > n1=%d (single-writer must advance)", n2, n1)
	}
}
```

> 第三方库 API 提示：PR #29/#30 已验证 testcontainers-go v0.43.0 与上文一致；若所装版本签名不同，按 `go doc` 微调、保持行为不变。

- [ ] **Step 2: 本地编译校验（无 Docker）+ 无标签基线**

Run: `cd backend && go mod tidy && go build ./... && go vet ./... && go test ./...`
Expected: 全绿；`cmd/signer` 无标签下报常规测试通过（集成测试被 `//go:build integration` 排除）。
Run: `cd backend && go test -c -tags=integration -o /dev/null ./cmd/signer/`
Expected: 编译成功、无输出（不起容器）。若签名有差异按提示微调。
Run: `cd backend && go build ./cmd/signer && rm -f signer`
Expected: signer 构建成功（二进制已删）。

- [ ] **Step 3: 提交**

```bash
git add backend/cmd/signer/main_integration_test.go backend/go.mod backend/go.sum
git commit --no-verify -m "test(backend): Postgres end-to-end wiring integration for signer

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final Verification（全部任务完成后）

- 无 Docker 基线：`cd backend && go test ./... && go vet ./... && go build ./...` 全绿（cmd/signer 集成被标签跳过；`TestBuildHandlerInMemory` 跑）。
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./cmd/signer/` 成功；**真跑由 CI**（backend job 已 `-tags=integration`）端到端 Postgres 签名。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅改 `cmd/signer/{main.go,main_test.go,main_integration_test.go}` + `go.mod`/`go.sum`（若 tidy 无新增则不变）+ 两份 docs。不改 `internal/*`。

## 备注

- 启动恢复无专门代码：`EnsureSchema` 幂等 + `sw_state` nonce 高水位持久 + leader 重 acquire（epoch 抬升）。
- standby：非 leader→503（fail-closed）；leader 在 ~`renewEvery` 内首次 acquire。
- 关停：信号 → `srv.Shutdown` → `cleanup`（cancel leader→释放租约、等 Run 收尾、关 pool）。
- CI 现三个集成包并行起 Postgres（lease/pg、singlewriter/pg、cmd/signer）；`postgres:17-alpine` 已在 CI 预拉取（PR #30）。
