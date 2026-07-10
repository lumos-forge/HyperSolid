# WS 分片配额 —— `internal/wsshard` 私有 WS 分片分配/准入治理库

- 日期：2026-07-10
- 里程碑：M10（可观测 / 限频预算）收尾项之一
- 语言：Go（`backend/internal/wsshard`）
- 状态：设计已批准，待实现

## 1. 背景与问题

Hyperliquid WebSocket API 对**每个出口 IP** 有硬限（spec §4.7 / §4.8）：

- ≤10 连接、≤1000 订阅、**≤10 个唯一用户地址**、≤2000 msg/min、≤100 inflight post。

其中「**≤10 个唯一用户地址/IP**」使「单连接共享扇出所有用户私有数据」不可行。修订后的私有数据模型（spec §4.8）：

- **公共行情**（allMids/fastAssetCtxs 等）：单连接集中订阅 + 扇出（M2）。
- **用户私有数据**（clearinghouseState/openOrders/orderUpdates/userFills/userEvents）：**默认由客户端自身直连 HL 订阅**（每设备 1 个用户地址，天然在限内）。
- **仅当 agentic 用户离线**、后端必须代持私有监控时，后端按「每 IP ≤10 用户」**显式分片**：IP 池 + 准入控制 + 容量测算 + 超限回退轮询 + 限频监控告警。

本设计交付 M10 的「**WS 分片配额**」治理层：一个建模「≤N 用户/分片」约束、做分片分配与准入控制的纯记账库。真实的 WS 传输、HL 订阅、回退轮询执行属于 M3（`internal/privatefeed`），本库不含。

## 2. 范围与非目标

**在范围内**

- 固定分片池的用户→分片分配（least-loaded 策略）。
- 幂等准入（Admit）、显式释放（Release）、分配查询（Assignment）。
- 全满拒绝准入（供调用方据此回退轮询）。
- fail-closed：非法配置或非法地址一律拒绝。
- 观测快照（Stats），供 M3 未来接入 `/metrics`。
- 并发安全（`sync.Mutex`），`-race` 通过。

**非目标（明确排除）**

- 不建立/维护任何 WS 连接、不做 HL 订阅、不发消息（M3 传输层职责）。
- 不强制订阅数/msg-per-min/inflight 等吞吐维度上限——这些属传输层（M3）与现有 `internal/ratelimit` 的职责。本库只管**唯一用户数**这一绑定约束（单一职责）。
- 不做动态扩缩容（分片数在构造时固定 = IP 池大小）。
- 不做 TTL/心跳自动回收（释放由调用方在用户上线或策略停用时显式触发）。
- 不接线 `/metrics`（M3 消费本库时再接）。

## 3. 约束与硬限（来源）

| 约束 | 值 | 来源 |
|---|---|---|
| 每 IP 唯一用户地址 | ≤10（`maxPerShard` 默认 10，可配） | spec §4.7 line 125 |
| 分片池规模 | = 可用出口 IP 数（`numShards`，构造时固定） | spec §4.8「IP 池」 |
| 超限行为 | 拒绝准入 → 调用方回退轮询 | spec §4.8「超限回退轮询」 |

## 4. API 表面

```go
// Package wsshard 为离线 agentic 用户的私有 WS 流做分片分配与准入控制，
// 建模 HL「≤N 唯一用户/IP」硬限。纯记账，不含 WS 传输（见 M3 privatefeed）。
// fail-closed：非法配置或非法地址一律拒绝。并发安全。
package wsshard

// Allocator 是固定池的用户→分片分配器。
type Allocator struct { /* 私有：mu、每片计数、user→shard 映射、numShards、maxPerShard、denied 计数 */ }

// Stats 是观测快照。
type Stats struct {
    NumShards   int   // 分片总数
    MaxPerShard int   // 每片用户上限
    Capacity    int   // numShards * maxPerShard
    Admitted    int   // 当前在册用户数
    Free        int   // Capacity - Admitted
    ShardLoad   []int // 每片当前用户数，len == NumShards
    DeniedFull  uint64 // 累计因全满而拒绝的准入次数
}

// New 构造固定池分配器。numShards>0 且 maxPerShard>0 才有效；否则返回一个
// fail-closed 分配器（所有 Admit 恒拒绝、Stats 反映零容量）+ 非 nil error。
// 返回非 nil 的 *Allocator 以便调用方无需 nil 检查即可安全（fail-closed）使用。
func New(numShards, maxPerShard int) (*Allocator, error)

// Admit 幂等准入 user。语义（fail-closed）：
//   - fail-closed 分配器（非法配置）或非法/空地址 → (-1, false)。
//   - 已准入 → 返回其现有 (shardID, true)，不占新槽。
//   - 未准入且有空位 → 按 least-loaded 选片（空位最多；平票取最小 index），
//     记账并返回 (shardID, true)。
//   - 全满 → (-1, false) 且 DeniedFull++（调用方据此回退轮询）。
// 地址归一化：strings.ToLower(strings.TrimSpace(user)) 且须为 20 字节 hex EVM 地址。
func (a *Allocator) Admit(user string) (shardID int, admitted bool)

// Release 显式释放 user（用户上线由客户端接管、或策略停用时调用），腾出槽位。
// 返回该 user 此前是否在册。地址同样归一化；非法地址返回 false。
func (a *Allocator) Release(user string) (released bool)

// Assignment 查询 user 当前分片，不改变状态。未在册或非法地址 → (-1, false)。
func (a *Allocator) Assignment(user string) (shardID int, ok bool)

// Stats 返回当前观测快照（深拷贝 ShardLoad，调用方可安全持有）。
func (a *Allocator) Stats() Stats
```

## 5. 行为与算法

### 5.1 地址归一化（与仓库一致）

沿用 signer/policy 约定：`key = strings.ToLower(strings.TrimSpace(addr))`，并校验为 20 字节（`0x` + 40 hex）EVM 地址。非法 → 相关方法 fail-closed（Admit/Assignment 返回 `-1,false`；Release 返回 `false`）。参照 `backend/cmd/signer/main.go:497 normalizeOwnerAddress`。

### 5.2 least-loaded 选片

- 遍历分片，选**当前用户数最少**（即空位最多）且未满（`load < maxPerShard`）的分片。
- 平票取**最小 index**（确定性，便于测试）。
- 无任何未满分片 → 全满 → 拒绝。

### 5.3 fail-closed 语义汇总

| 情形 | 结果 |
|---|---|
| `numShards ≤ 0` 或 `maxPerShard ≤ 0` | `New` 返回 error + fail-closed 分配器（Admit 恒 `-1,false`） |
| 非法/空地址 | Admit/Assignment `-1,false`；Release `false` |
| 全满 | Admit `-1,false`，`DeniedFull++` |
| 重复 Admit 同一用户 | 返回原分片，不占新槽（幂等） |

### 5.4 容量与不变式

- `Capacity == numShards * maxPerShard`。
- `Admitted == Σ ShardLoad == len(user→shard 映射)`。
- 任意时刻每片 `ShardLoad[i] ≤ maxPerShard`。
- `Free == Capacity - Admitted`。

## 6. 并发与观测

- 单个 `sync.Mutex` 保护全部可变状态（map + 每片计数切片 + denied 计数），所有导出方法在锁内读写，安全并发使用（同 `internal/ratelimit`）。
- `Stats()` 在锁内构造并**深拷贝** `ShardLoad` 切片返回，避免调用方读到内部切片。
- 本库不直接注册 Prometheus 指标；`Stats()` 快照供 M3 消费时映射为 gauge（每片负载/总空闲）与 counter（`DeniedFull`）。这样保持 metrics registry 归口 `internal/metrics`，库本身 metrics 无关。

## 7. 测试计划（TDD，`wsshard_test.go`）

1. `New` 合法配置：容量/初始 Stats 正确；非法配置返回 error 且 Admit 恒拒绝。
2. Admit 幂等：同一用户多次 Admit 返回同一分片、Admitted 不增。
3. least-loaded：连续 Admit 均摊到各片；平票取最小 index。
4. Release：释放后 Admitted 减、槽位可被新用户复用；释放不在册用户返回 false。
5. 全满：容量满后 Admit 返回 `-1,false` 且 `DeniedFull` 递增。
6. fail-closed 地址：大小写/空白归一化命中同一用户；非法地址各方法拒绝。
7. 不变式：随机 Admit/Release 序列后校验 §5.4 不变式。
8. 并发：多 goroutine 并发 Admit/Release/Stats，`go test -race` 无竞态，终态不变式成立。
9. `Stats().ShardLoad` 为拷贝：修改返回值不影响后续 Stats。

## 8. 验证命令

```bash
cd backend && \
  go test ./internal/wsshard/ && \
  go test -race ./internal/wsshard/ && \
  go vet ./internal/wsshard/ && \
  go build ./...
```

## 9. 与现有代码的关系

- 形态对齐 `internal/ratelimit`（token-bucket、fail-closed、并发安全、纯库无 IO）。
- 地址归一化对齐 `backend/cmd/signer/main.go` 与 `internal/policy`。
- 观测对齐 `internal/metrics` 的「registry 归口 + 库暴露数值」分工。
- 消费方 M3 `internal/privatefeed`（未建）将注入 `*Allocator`，把 Admit 失败翻译为回退轮询，并把 `Stats()` 接入 `/metrics` 与告警。

## 10. 未来工作（本次不做）

- M3：真实 IP 池 + WS 传输 + 回退轮询执行 + `/metrics` 接线 + 限频告警。
- 若吞吐成为瓶颈：在传输层（非本库）叠加 msg/min、inflight 维度的运行期限频。
- 动态扩缩容 / 心跳 TTL 自动回收（若离线用户规模与在线切换频繁到需要）。
