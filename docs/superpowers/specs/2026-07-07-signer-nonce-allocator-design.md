# `internal/nonce` 进程内单调 nonce 分配器 + 窗口校验（不接线）

日期：2026-07-07
状态：已批准，待实现

## 背景

`docs/BACKEND-ARCHITECTURE.md §5`（line 90）：nonce 规则 = ms 时间戳、窗口 (T-2d, T+1d)、每签名者严格递增不复用、**按私钥而非账户**、每 agent key 配**租约/fencing 单写者**。目前 `cmd/signer` `/v1/sign/l1` 的 nonce 是**客户端传入**（`req.Nonce`），Go 侧无 nonce 管理。

本片是 nonce 组件的**第一步**：一个自包含、可注入时钟、并发安全的**进程内每-key 单调递增 nonce 分配器** + **窗口校验器**。进程内单写者 = 互斥锁串行化。**不接入 `/v1/sign/l1`**。跨进程**租约/fencing** 单写者（需持久 lease store / Postgres，M6）是独立的后续子项目。

## 架构

单个纯 Go 包 `backend/internal/nonce`（仅标准库 `sync`/`time`）。无副作用、可注入时钟、并发安全。

### 组件（`backend/internal/nonce/nonce.go`）

```go
package nonce

import (
	"sync"
	"time"
)

// Allocator hands out strictly-increasing millisecond-timestamp nonces per key.
// It is the single writer WITHIN a process (a mutex serializes Next); the
// cross-process lease/fencing single-writer is a separate concern (M6).
type Allocator struct {
	nowMs func() int64
	mu    sync.Mutex
	last  map[string]uint64
}

// New returns an Allocator. If nowMs is nil, it uses the real clock
// (time.Now().UnixMilli()). Tests inject a fake clock for determinism.
func New(nowMs func() int64) *Allocator {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &Allocator{nowMs: nowMs, last: make(map[string]uint64)}
}

// Next returns a strictly-increasing ms nonce for keyID: n = max(now, last+1).
// A stalled or regressing clock still yields a strictly higher nonce than the
// previous one for that key, so a nonce is never reused. Per-key isolated; safe
// for concurrent use.
func (a *Allocator) Next(keyID string) uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := uint64(a.nowMs())
	if last := a.last[keyID]; n <= last {
		n = last + 1
	}
	a.last[keyID] = n
	return n
}

// HL accepts a nonce only within (T-2days, T+1day) of the current time.
const (
	windowPastMs   int64 = 2 * 24 * 60 * 60 * 1000 // 2 days
	windowFutureMs int64 = 1 * 24 * 60 * 60 * 1000 // 1 day
)

// WithinWindow reports whether a nonce (ms) is inside HL's accepted open
// interval (nowMs - 2d, nowMs + 1d).
func WithinWindow(nonce uint64, nowMs int64) bool {
	n := int64(nonce)
	return n > nowMs-windowPastMs && n < nowMs+windowFutureMs
}
```

## 关键性质

- **严格递增、绝不复用**：`Next` 用 `max(now, last+1)`。同一毫秒突发多次 → last+1 递增；时钟回拨（now < last）→ last+1 递增。
- **按 key 隔离**：`last` 按 keyID 分桶；不同 key 互不影响。
- **进程内单写者**：`mu` 串行化所有 `Next`；`go test -race` 干净。
- **窗口开区间**：`WithinWindow` 严格 `>` / `<`；now-2d 与 now+1d 边界值本身返回 false。
- **可注入时钟**：`New(nil)` 用真实时钟；测试传固定/可控假时钟。

## 测试（`backend/internal/nonce/nonce_test.go`）

- `Next` 同一固定时钟连调两次 → 第二个 == 第一个 + 1（严格递增）。
- `Next` 时钟回拨（第二次 now 更小）→ 结果仍严格大于第一次。
- `Next` 时钟前进（now 增大且 > last+1）→ nonce 跟随真实时钟（== now）。
- 多 key：`Next("a")` 与 `Next("b")` 独立（各自从 now 起，互不递增干扰）。
- 并发：N（如 500）个 goroutine 对同一 key 调 `Next`，收集结果 → 全部唯一（`len(set)==N`）；`go test -race` 干净。
- `WithinWindow`：`nonce == now` → true；`now - windowPastMs + 1` → true，`now - windowPastMs` → false；`now + windowFutureMs - 1` → true，`now + windowFutureMs` → false。
- `New(nil)`：不 panic，`Next` 返回接近 `time.Now().UnixMilli()` 的值（`WithinWindow(n, time.Now().UnixMilli())` 为 true）。

## 验证门槛

- `cd backend && go test ./internal/nonce/ && go vet ./internal/nonce/` 全绿；`go test -race ./internal/nonce/` 通过。
- `cd backend && go test ./...` 全绿（新包不影响既有）。

## 范围外（YAGNI，后续子项目）

- 跨进程**租约/fencing** 单写者（fencing token + 持久 lease store，保证跨进程一个 key 仅一个写者）。
- nonce 状态**持久化**（进程重启后恢复 last，防回退）。
- 接入 `cmd/signer` `/v1/sign/l1`（签名端生成/校验 nonce，取代客户端传入）。
- HL「保留最高 100」replay 窗口的显式复现（分配器的单调 `Next` 已保证不复用，故无需）。
