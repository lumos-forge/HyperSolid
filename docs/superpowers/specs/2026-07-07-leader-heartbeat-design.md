# 租约持有者心跳/续约循环（Leader）+ 内存 lease.Store 设计

> M6 单写者「接线 /v1/sign/l1」的第 1 部分（心跳/续约循环）。承接租约存储（PR #30）。产出一个后台持有租约、暴露实时 fencing `Fence(epoch, isLeader)` 的组件，供后续端点接线切片消费。

## 背景与目标

M6 已具备：单写者核 `singlewriter.Decide/Writer`（fence+额度+nonce 原子授权，PR #28/#29）、持久租约 `lease.Store`（单调 epoch，PR #30）。缺的是一个**运行时组件**：一个实例后台**获取并持续续约**某个租约，在内存里维护「我当前是不是持有者、当前 epoch 是多少」，把这个 epoch 作为 `Fence` 提供给签名端点。

本切片交付这个 **`leader.Leader`** 心跳/续约循环，外加一个**内存 `lease.Store`（`lease.Mem`）**用于确定性测试与单实例部署。**本切片不改签名端点、不改 `main()`、不引入 Postgres**——端点接线（把 `Leader.Fence()` 接入 `handleSignL1` 的 `singlewriter.Authorize`）与 `main()` 的后端选择是紧接的后续切片。

## 自主设计决策（本次自动执行，记录备查）

- **Leader-election 模型**：一个具名租约（如 `"signer-leader"`），实例竞选为唯一 leader；leader 的 epoch 作为所有 key 的 `Fence`（与 per-key 租约相比更简单、单活写者 + 热备，符合架构文档「leader 选举」）。per-key 租约留作未来细化。
- **可测试性**：把「一次获取或续约」的状态转移拆为纯确定性方法 `step(ctx)`（无 goroutine/计时，单测直接驱动）；`Run(ctx, every)` 只是薄薄的 ticker 循环调用 `step`。
- **内存租约存储 `lease.Mem`**：注入时钟、`mutex + map[string]Row` 套用已导出的 `lease.Decide`；既是 leader 的确定性测试夹具，也是单实例（无 DB）部署的可用 `lease.Store`。

## 组件

### 1. `backend/internal/lease/mem.go` —— 内存 `lease.Store`

```go
// Mem is an in-process lease.Store: a mutex-guarded map of per-name Row applying
// the pure Decide transition with an injectable clock. It is the deterministic
// test fixture for leader and a usable single-instance Store; the cross-host
// authority is the Postgres-backed Store (internal/lease/pg).
type Mem struct {
	nowMs func() int64
	mu    sync.Mutex
	rows  map[string]Row
}

// NewMem returns an empty in-memory Store. nil nowMs uses the real clock.
func NewMem(nowMs func() int64) *Mem

func (m *Mem) Acquire(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
func (m *Mem) Renew(ctx context.Context, name, holder string, ttl time.Duration) (Lease, error)
func (m *Mem) Release(ctx context.Context, name, holder string) error
```

三方法共用一个内部 `op(name, op, holder, ttl)`：加锁 → 读当前行（缺省零 `Row` = 过期种子）→ `Decide(cur, Req{op, holder, nowMs(), ttl.Milliseconds()})` → 若 `err` 返回之；若 `write` 写回 `rows[name]=next`；`out.Name=name` 返回。`var _ Store = (*Mem)(nil)`。语义与 pg 实现一致（epoch 单调、行永不删除、Release 只置过期），由 `Decide` 保证。

### 2. `backend/internal/leader/leader.go` —— 心跳/续约循环

```go
// Leader holds a single named lease on behalf of one holder and keeps it renewed
// in the background, exposing the current fencing epoch and leadership status.
// The epoch is passed to singlewriter as Request.Fence by the signing endpoint
// (a later slice); on a lost/stolen lease the epoch bumps, fencing the old holder.
type Leader struct {
	store  lease.Store
	name   string
	holder string
	ttl    time.Duration
	mu       sync.Mutex
	epoch    uint64
	isLeader bool
}

// New returns a Leader for (name, holder) over store with lease TTL ttl.
func New(store lease.Store, name, holder string, ttl time.Duration) *Leader

// Fence returns the current fencing epoch and whether this instance currently
// holds the lease. Safe for concurrent use.
func (l *Leader) Fence() (epoch uint64, isLeader bool)

// step performs exactly one acquire-or-renew cycle and updates state. If leading,
// it renews; a renew failure drops leadership and it immediately attempts to
// (re)acquire. If not leading, it attempts to acquire. Pure of timing — the loop
// calls it on a ticker; tests call it directly.
func (l *Leader) step(ctx context.Context)

// Run drives step on an `every` ticker until ctx is cancelled, then best-effort
// Releases the lease. It performs one immediate step before ticking.
func (l *Leader) Run(ctx context.Context, every time.Duration)
```

`step` 逻辑：
- 若当前 `isLeader`：`store.Renew`。成功 → `epoch=ls.Epoch, isLeader=true` 返回；失败（`ErrExpired`/`ErrNotHolder`/其它）→ `isLeader=false`，落到下面尝试 acquire。
- `store.Acquire`。成功 → `epoch=ls.Epoch, isLeader=true`；失败（`ErrHeld`/其它）→ `isLeader=false`。

`Run`：先 `step` 一次；然后 `for { select ctx.Done()→ Release(name,holder) + return; <-ticker.C → step } `。

> `ttl` 与 `every` 的关系（续约间隔应显著小于 TTL，如 `every ≈ ttl/3`）由调用方（后续接线切片）决定；本切片不硬编码，由 `Run` 的入参控制。

## 测试

- **`lease.Mem` 单测**（假时钟，快）：Acquire 空闲→epoch1；他人 Acquire→ErrHeld；Renew 保持 epoch；推进时钟过 TTL 后他人 Acquire→epoch2（抢占）；Release 后再 Acquire→epoch 递增不回退；并发 N goroutine Acquire 同名→恰一个胜出（mutex 串行化）。
- **`leader.step` 单测**（`lease.Mem` + 假时钟，确定性）：
  - 新 leader `step` → `Fence()=(1,true)`；
  - 第二个 holder 的 Leader `step` → Acquire ErrHeld → `(0,false)`；
  - leader 在 TTL 内 `step`（续约）→ 仍 `(1,true)`；
  - 推进时钟过 TTL：holder B 的 Leader `step` → 抢占 → `(2,true)`；holder A 的 Leader（原 isLeader=true）`step` → Renew 失败→ Acquire ErrHeld → `(_,false)`（失去领导权）；
  - epoch 跨抢占单调递增。
- **`leader.Run` 集成式单测**（真实短 ticker + `context`，宽裕超时防抖）：`go l.Run(ctx, 5ms)`；轮询 `Fence()` 直到 `isLeader`（≤1s）；断言 epoch≥1；`cancel()`；轮询直到另一 holder 能 Acquire（即租约已被 `Run` 退出时 Release）→ 断言 Release 生效。

## 验证门

- `cd backend && go test ./... && go vet ./... && go build ./...` 全绿（纯 Go、无 Docker、无标签测试）。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅新增 `internal/lease/{mem.go,mem_test.go}` + `internal/leader/{leader.go,leader_test.go}` + 两份 docs。不改 `singlewriter`/`cmd/signer`/`lease/{decide.go,lease.go,pg/*}`。

## 非目标（后续切片）

- 端点接线：`handleSignL1` 用 `singlewriter.Writer.Authorize`（Fence 来自 `Leader.Fence()`；非 leader→503；`ErrFenced`→409），替换现有 `nonces.Next`+`spend.Charge`，含 golden 测试的时钟注入。
- `main()` 后端选择：env-gated `DATABASE_URL` → `pgxpool` + `lease/pg.PgStore` + `singlewriter/pg.PgWriter` + `EnsureSchema` + 启动恢复；否则 `lease.Mem` + `singlewriter.Mem` 单实例。
- leader 选举编排 / 多 AZ / 指标。

## 备注

- `lease.Mem` 与 `singlewriter.Mem` 对称（注入时钟、mutex+map、套用已导出的纯 `Decide`），保持包内一致风格。
- `Leader.step` 的「续约失败即尝试抢占」实现快速故障切换：失去租约的实例下一拍要么夺回（epoch 更高、自我 fence 掉旧 in-flight）要么退位。
