# 持久化 fenced 单写者核（切片 ①）设计

> M6 「租约 fencing 单写者」的第一个可独立交付切片（`docs/BACKEND-ARCHITECTURE.md` §6.2）。承接 M5 签名核（PR #21–#27）。

## 背景与问题

当前 `backend/internal/nonce.Allocator` 与 `backend/internal/policy.SpendTracker` 都是**进程内**单写者（`sync.Mutex` + 内存 `map`），既不持久也不跨进程：

- **多实例竞态（nonce）**：两个 signer 实例各自从陈旧内存 `last` 为同一 agent key 发 nonce → nonce 复用/冲突，成交被 HL 拒或错乱。
- **多实例竞态（额度）**：每实例各算各的每日名义额 → 每日封顶被绕过（N 实例 ≈ N 倍额度）或重复计。
- **重启丢状态**：进程重启后内存高水位清零 → nonce 可能回退、当日已用额度归零。

架构文档把「租约 fencing 单写者 + 持久意图账本」定为 **M6**（规划技术栈 Temporal + Postgres），且 signer 要求「单独部署、最小依赖、单独信任域」。

## 范围（本切片）

只交付 **原子 fenced 单写者核** 的**契约 + 纯逻辑 + 内存参考实现 + 一致性测试套件**：在单次原子授权内强制 ① fence 校验 → ② 每日额度 check+reserve → ③ nonce 高水位推进，全成或全拒。

**目标生产后端 = Postgres (pgx)**（对齐架构文档、真跨主机 HA）；其具体落地作为**紧接的下一切片**，以本切片的接口 + 一致性套件为规约（共享 `RunConformance`）。

**fencing token 归属**：本切片的单写者核**接收**来自租约层（切片②）签发的 token，库侧只强制**单调**（`token < 已存 fence` 拒绝；相等/更高接受并抬升）。token 的铸造/递增留给切片②，故本切片可脱离②独立测试（测试直接提供 token）。

## 包与职责

新增 `backend/internal/singlewriter`，单一职责：把 nonce 高水位 + 每日额度 + fence 三者合成一次**原子授权**。

现有 `internal/nonce.Allocator` 与 `policy.SpendTracker` **保持不变**，仍作进程内快路径；待切片 ③ 接线 `/v1/sign/l1` 时由本包接管为权威来源。

## 接口与类型

```go
package singlewriter

// Request is one signing authorization for an agent key.
type Request struct {
	KeyID    string  // agent private key id (按私钥而非账户)
	Fence    uint64  // fencing token from the caller's lease (minted in slice ②)
	Notional float64 // this action's USD notional; 0 for non-notional kinds
	DailyCap float64 // per-key daily notional cap; 0 = unlimited, <0 = misconfig (denied)
	NowMs    int64   // caller clock (ms); injectable for tests
}

// Grant is the result of an accepted authorization.
type Grant struct {
	Nonce uint64 // strictly-increasing per-key ms nonce to sign with
}

// Writer is the cross-process single-writer authority. Authorize atomically
// fences stale writers and, for the current lease-holder, advances the per-key
// nonce high-water and charges the daily spend — all or nothing.
type Writer interface {
	Authorize(ctx context.Context, r Request) (Grant, error)
}
```

错误分类（sentinel，供未来 endpoint 映射 HTTP）：

```go
var (
	ErrFenced          = errors.New("fenced: stale fencing token") // → 未来 409 Conflict
	ErrDailyCap        = errors.New("daily cap exceeded")          // → 403
	ErrInvalidNotional = errors.New("invalid notional")           // → 403
)
```

`ctx` 供 Postgres 实现（事务/取消）使用；内存实现忽略。

## 纯 `decide`（心脏，两种后端共用，杜绝漂移）

```go
const dayMs int64 = 24 * 60 * 60 * 1000 // 86_400_000

// State is the per-key persisted single-writer state.
type State struct {
	Fence      uint64  // highest fencing token accepted so far
	LastNonce  uint64  // last issued nonce (high-water)
	SpendDay   int64   // UTC day number of SpendTotal (NowMs/dayMs)
	SpendTotal float64 // notional spent within SpendDay
}

// decide is the pure single-writer transition. Given the current persisted
// state and a request it returns the next state and grant, or a typed error
// (leaving state UNCHANGED on every reject). Both the in-memory and Postgres
// writers apply this identical logic so their behavior cannot drift.
func decide(s State, r Request) (State, Grant, error) {
	// 1. fence: a stale writer (lower token) is rejected without touching state.
	if r.Fence < s.Fence {
		return s, Grant{}, ErrFenced
	}
	// 2. invalid notional fails closed (mirrors policy.SpendTracker.Charge).
	if math.IsNaN(r.Notional) || math.IsInf(r.Notional, 0) || r.Notional < 0 {
		return s, Grant{}, ErrInvalidNotional
	}
	// 3. daily cap check+reserve, UTC-day bucketed; rollover resets the total.
	day := r.NowMs / dayMs
	total := s.SpendTotal
	if s.SpendDay != day {
		total = 0
	}
	if r.DailyCap < 0 { // misconfigured cap → fail closed
		return s, Grant{}, ErrDailyCap
	}
	if r.DailyCap > 0 && total+r.Notional > r.DailyCap { // strict >, exactly-at-cap allowed
		return s, Grant{}, ErrDailyCap // deny does NOT advance nonce
	}
	// 4. nonce high-water advance: n = max(now, last+1), strictly increasing.
	n := uint64(r.NowMs)
	if n <= s.LastNonce {
		n = s.LastNonce + 1
	}
	return State{
		Fence:      r.Fence, // monotonic: r.Fence >= s.Fence here
		LastNonce:  n,
		SpendDay:   day,
		SpendTotal: total + r.Notional,
	}, Grant{Nonce: n}, nil
}
```

不变量：

- **拒绝纯读**：`ErrFenced`/`ErrInvalidNotional`/`ErrDailyCap` 三条路径都返回**未改动**的 `s`（Postgres 实现可直接回滚，不落任何写）。fence 只在**接受**时抬升。
- **顺序**：fence → 无效额度 → 每日额度 → nonce。额度拒/ fenced/ 无效都**不烧 nonce**（与 M5 现管线一致）。
- **精确复刻**：nonce 数学等同 `nonce.Next`（`max(now,last+1)`，时钟回退仍严格递增）；额度数学等同 `SpendTracker.Charge`（含上片修的 NaN/Inf/负额度、负上限三处 fail-closed，strict `>`，`0=不限额`，UTC 跨日归零）。差异仅是把三者放进**同一原子提交**并加 fence。

> 额度算法在 `decide` 内自包含（约 6 行），由一致性套件钉死语义以防与 `SpendTracker` 漂移；不在本切片跨包重构 `policy`（未来可提取共享纯 helper 作清理）。

## 内存参考实现 `Mem`

```go
type Mem struct {
	mu    sync.Mutex
	state map[string]State
}

func NewMem() *Mem { return &Mem{state: make(map[string]State)} }

func (m *Mem) Authorize(_ context.Context, r Request) (Grant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, g, err := decide(m.state[r.KeyID], r)
	if err != nil {
		return Grant{}, err
	}
	m.state[r.KeyID] = next
	return g, nil
}
```

既是快速单测夹具，也是**单实例部署**的可用 `Writer`。

## 一致性测试套件（关键）

导出供任意 `Writer` 实现复用（下一切片的 Postgres 实现直接复用同一场景）：

```go
// RunConformance exercises a Writer implementation against the single-writer
// contract. newWriter must return a fresh, empty Writer on each call.
func RunConformance(t *testing.T, newWriter func() Writer)
```

覆盖场景：

- **nonce**：新 key `nonce == NowMs`；跨调用严格递增；时钟回退（NowMs 变小）仍 `last+1`。
- **fence**：`token < 存` → `ErrFenced` 且不改状态（随后一次合法调用仍从原高水位继续）；`token == 存` 接受；`token > 存` 接受并抬升 fence；抬升后再来**旧 token** → `ErrFenced`。
- **额度**：within、恰好等于上限（接受）、超上限 strict `>`（`ErrDailyCap`）；`DailyCap==0` 不限额；跨 UTC 日归零；`NaN/±Inf/负` 额度 → `ErrInvalidNotional`；`DailyCap<0` → `ErrDailyCap`。
- **额度拒不烧 nonce**：一次 `ErrDailyCap` 后，下一次合法授权的 nonce 不因被拒而跳号（等于未发生过被拒时的值）。
- **并发**：N 协程并发 `Authorize` 同一 key —— 收集所有成功的 `Grant.Nonce`，断言**全部唯一**（无复用）；在共享每日上限下断言**成功笔数 == floor(cap/每笔)**（不超额）。`go test -race` 洁净。

内存实现下这些均确定性通过；Postgres 实现将用**同一套**验证事务隔离与 fencing 正确性。

## 验证门

- `cd backend && go test ./... && go vet ./...` 全绿
- `go test -race ./internal/singlewriter/` 通过
- `go build ./cmd/signer && rm -f signer`（不提交二进制）

全程严格 TDD（先失败测试 → 最小实现 → 通过 → 提交）。

## 非目标（后续切片）

- **切片②**：租约 acquire/renew/心跳/过期/接管 + fencing token 铸造与轮换。
- **下一切片**：Postgres (pgx) `Writer` 实现（schema：每 key 一行 `fence/last_nonce/spend_day/spend_total`，`SELECT … FOR UPDATE` + `decide` + `UPDATE`；集成测试 + 复用 `RunConformance`）。
- **切片③**：接线 `/v1/sign/l1`（获取/校验租约 → 走本单写者 → 内存降为受 fence 校验的快路径缓存）+ 启动恢复（从库加载高水位）。
- **切片④**：leader 选举 / 多 AZ / 指标 / failover 运维。
