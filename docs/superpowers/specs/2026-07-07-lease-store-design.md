# 持久租约存储 + fencing epoch 设计

> M6「租约 fencing 单写者」的租约生命周期切片（`docs/BACKEND-ARCHITECTURE.md` §6.2）。承接单写者核（PR #28）与 Postgres 落地（PR #29）：单写者层强制 fencing token 单调，本切片负责**产出**这些 token 并裁决**谁**是当前唯一写者。

## 背景与目标

`internal/singlewriter` 的 `Decide` 接收一个外部传入的 `Fence` token 并在库侧强制单调（`token < 已存 fence` 拒绝）。token 的**铸造与归属裁决**此前留空。本切片交付一个**持久租约存储**：一个实例通过 acquire/renew 持有某个 lease；每次 (re)acquire 铸造一个**严格递增的 epoch**（= fencing token）；持有者把 epoch 作为 `Fence` 传给 `PgWriter.Authorize`。换主时新持有者 epoch 更高，旧持有者在单写者层被 fence，从而实现跨进程/跨主机的单写者裁决。

## 范围

通用的、**按 lease 名字键控**的持久租约存储：`Acquire/Renew/Release` + 单调 `epoch`。lease 名可以是 agent keyID（per-key 单写者）或 shard/leader 名（一个 epoch 覆盖该 shard 全部 key）——**粒度映射留给接线切片③**。

**非目标**：心跳/续约循环 goroutine、接线 `/v1/sign/l1`（per-key vs leader 的 lease-name 映射、epoch→`Fence` 传参）、leader 选举编排、Mem 实现、conformance 抽象。

## 组件

### 1. 包放置
- `backend/internal/lease`：纯 `leaseDecision` + `Lease`/`Store`/错误。
- `backend/internal/lease/pg`（`package pg`）：Postgres 实现，DB 时钟。

不做 Mem 实现：租约仅在多实例才有意义、天然需要共享 DB 时钟；单实例无需租约（接线层可用平凡的 no-op 租约，非本片）。纯决策覆盖快速单测，SQL/时钟由 testcontainers 集成测试覆盖。

### 2. 类型与接口

```go
package lease

// Lease is a claim on a named resource. Epoch is the fencing token: it strictly
// increases on every (re)acquire and is passed to singlewriter as Request.Fence.
type Lease struct {
	Name        string
	Holder      string
	Epoch       uint64
	ExpiresAtMs int64 // absolute expiry on the DB clock (epoch ms)
}

type Store interface {
	// Acquire claims the lease for holder if it is free or expired, minting a
	// bumped Epoch. If a different holder still holds a valid lease → ErrHeld
	// (a valid self-hold also returns ErrHeld: use Renew instead).
	Acquire(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
	// Renew extends the caller's still-valid lease, keeping the same Epoch.
	// If the caller's lease already lapsed → ErrExpired (must re-Acquire);
	// if someone else holds it → ErrNotHolder.
	Renew(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
	// Release voluntarily gives up the lease held by holder (marks it expired now,
	// preserving Epoch). A non-holder / absent lease is an idempotent no-op.
	Release(ctx context.Context, name, holder string) error
}

var (
	ErrHeld      = errors.New("lease held by another holder")
	ErrNotHolder = errors.New("not the lease holder")
	ErrExpired   = errors.New("lease expired; re-acquire")
)
```

`ttl` 在边界转成 ms（`ttl.Milliseconds()`）喂给纯决策。holder 身份由调用方生成（如 hostname+pid+随机），本层只存储/比较。

### 3. 纯 `leaseDecision`（DB 喂 now，skew-free）

在 DB 时钟 `nowMs` 下对当前行判定；纯函数，Postgres 实现在锁事务内把 `SELECT … , now()` 的 now 喂进来，测试注入假 now。

当前行 / 请求（内部类型）：

```go
type row struct {
	Holder      string
	Epoch       uint64
	ExpiresAtMs int64
}

type opKind int

const (
	opAcquire opKind = iota
	opRenew
	opRelease
)

type leaseReq struct {
	Op     opKind
	Holder string
	NowMs  int64
	TtlMs  int64
}

// leaseDecision computes the outcome of an operation against the current row at
// DB time NowMs. On a mutation it returns the next row to persist and write=true;
// on a no-op (Release by non-holder) write=false and err=nil; on a rejection it
// returns err (ErrHeld/ErrNotHolder/ErrExpired) with write=false.
func leaseDecision(cur row, req leaseReq) (next row, write bool, out Lease, err error)
```

规则：

- **opAcquire**：
  - `cur.ExpiresAtMs <= req.NowMs`（空闲/过期，含种子 `epoch=0,expires=0`）→ 授予：`next = {Holder: req.Holder, Epoch: cur.Epoch + 1, ExpiresAtMs: req.NowMs + req.TtlMs}`, `write=true`, `out=Lease(next)`, `err=nil`。
  - 否则（存在**有效**持有，无论是否本人）→ `err=ErrHeld`, `write=false`。
- **opRenew**：
  - `cur.Holder == req.Holder && cur.ExpiresAtMs > req.NowMs` → `next = {Holder: cur.Holder, Epoch: cur.Epoch, ExpiresAtMs: req.NowMs + req.TtlMs}`（**epoch 不变**）, `write=true`, `out=Lease(next)`。
  - `cur.Holder == req.Holder && cur.ExpiresAtMs <= req.NowMs` → `err=ErrExpired`。
  - 否则 → `err=ErrNotHolder`。
- **opRelease**：
  - `cur.Holder == req.Holder`（无论是否已过期）→ `next = {Holder: cur.Holder, Epoch: cur.Epoch, ExpiresAtMs: req.NowMs}`（立即过期，**保留 holder/epoch**）, `write=true`, `out=Lease(next)`。
  - 否则 → `write=false, err=nil`（幂等 no-op，不动他人租约）。

### 4. 关键不变量：epoch 单调、行永不删除

`epoch` 是每个 `name` 的**持久单调计数器**。抢占空闲/过期租约恒 `epoch+1`；Renew 保持；Release **只置过期、绝不删行**。若删行，下次 Acquire 会从 `epoch=1` 重新起，可能低于单写者已存的 `Fence` → 该 name 下的 key 被永久 fence。故本设计**从不 DELETE lease 行**，只更新 `expires_at`。换主（抢占过期）epoch 递增，旧持有者携旧 epoch 的签名请求在 `PgWriter.Authorize` 被 `ErrFenced` 拒绝。

### 5. Postgres 实现（DB 时钟 + FOR UPDATE，复刻 singlewriter 事务范式）

Schema（`expires_at` 用 bigint epoch-ms，与纯决策 int64ms 对齐、避免时间类型转换 bug）：

```sql
CREATE TABLE IF NOT EXISTS lease (
	name       text   PRIMARY KEY,
	holder     text   NOT NULL,
	epoch      bigint NOT NULL,
	expires_at bigint NOT NULL  -- epoch ms
)
```

`EnsureSchema(ctx, *pgxpool.Pool) error` 幂等建表。

`Store` 实现 `PgStore{pool}` + `New(pool)`。每个方法在单个事务内：

```
BEGIN (IsoLevel: ReadCommitted)
INSERT INTO lease(name,holder,epoch,expires_at) VALUES($1,'',0,0) ON CONFLICT (name) DO NOTHING  -- 种子（epoch0、立即过期）
SELECT holder, epoch, expires_at, (extract(epoch from now())*1000)::bigint AS now_ms
  FROM lease WHERE name=$1 FOR UPDATE                                                              -- 行锁 + DB 时钟
→ leaseDecision(cur{holder,uint64(epoch),expires_at}, {op,holder,now_ms,ttlMs})
   err != nil → 事务回滚（deferred Rollback）→ 返回类型化 err
   write == false（Release no-op）→ COMMIT（种子若刚插入则留一行空闲租约，无害）→ 返回 nil
   否则 UPDATE lease SET holder=$2, epoch=$3, expires_at=$4 WHERE name=$1（epoch 传 int64(next.Epoch)）→ COMMIT → 返回 out
```

- `now` 在锁事务内从 DB 读取（所有实例同一时间源，skew-free）。
- `epoch` uint64↔bigint 位型无损（写 `int64(u)`、读 `uint64(int64)`）；DB 不对其算术。
- 种子 `INSERT … ON CONFLICT DO NOTHING` 保证 `FOR UPDATE` 有行可锁、消除新 name 的 PK 竞态；同 name 并发经行锁串行化。
- 基础设施错误 `fmt.Errorf("pg lease: …: %w", err)` 包装，与类型化拒绝区分（上层 5xx vs 4xx/退避）。

### 6. 测试

- **纯 `leaseDecision` 单测**（假 nowMs、无 DB、快）：
  - Acquire 空闲（种子行）→ epoch1、expires=now+ttl；
  - Acquire 他人有效持有 → ErrHeld；本人有效持有 → ErrHeld；
  - Acquire 抢占过期 → epoch = cur.epoch+1（含从他人手中抢）；
  - Renew 本人有效 → epoch 不变、延期；Renew 本人已过期 → ErrExpired；Renew 他人 → ErrNotHolder；
  - Release 本人 → 置过期、保留 epoch/holder；Release 他人/无关 → no-op(write=false,nil)；
  - **epoch 单调**：acquire(e1) → release → acquire → e2 = e1+1（不回退）。
- **Postgres 集成**（`//go:build integration`，testcontainers `postgres:17-alpine`，短 TTL + 真实 sleep）：
  - 新 name Acquire → Epoch 1、holder=me；
  - 另一 holder Acquire 同 name → ErrHeld；
  - 过期抢占：Acquire ttl=200ms，`time.Sleep(300ms)`，另一 holder Acquire → 成功、Epoch 2；
  - Renew 保持：Acquire ttl=1s → Renew（Epoch 不变）→ 另一 holder Acquire → ErrHeld；
  - Release 后另一 holder Acquire → Epoch **递增不回退**（验证不删行的单调性）；
  - Renew 非持有者 → ErrNotHolder；Renew 过期本人 → ErrExpired；
  - **并发**：N goroutine（不同 holder）并发 Acquire 同一新 name → **恰一个成功（Epoch 1）**、其余 ErrHeld（行锁串行化正确）。

### 7. CI

无需改动：backend job 已 `go test -tags=integration ./...`，新集成测试自动纳入。testcontainers 已在 go.mod（PR #29）。本片只新增 `lease` + `lease/pg`，不改现有包。

## 验证门

- 无 Docker 基线：`cd backend && go test ./... && go vet ./... && go build ./...` 全绿（lease/pg 集成被标签跳过）。
- 集成编译校验：`go test -c -tags=integration -o /dev/null ./internal/lease/pg/` 通过；**真跑由 CI**。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅新增 `internal/lease/*` + `internal/lease/pg/*` + 两份 docs（+ 可能的 go.sum 无变化）。

## 备注

- 本片只产出 fencing epoch 与租约裁决；**如何把 epoch 作为 `Fence` 传入 `PgWriter.Authorize`、per-key vs leader 的 lease-name 选择、心跳循环**都在切线切片③。
- 不删行的设计使 epoch 成为每 name 的持久单调序列，天然对齐单写者层的 per-key `Fence` 单调要求（lease 名=keyID 时 epoch 即该 key 的 fence；lease 名=shard 时 shard epoch 作为该 shard 全部 key 的 fence，各 key 的 `State.Fence` 取所见最大值仍单调）。
- 复用 PR #29 建立的 testcontainers 集成测试基础设施与事务范式（种子→FOR UPDATE→纯决策→UPDATE→COMMIT、READ COMMITTED、uint64↔bigint 位型、`%w` 包装）。
