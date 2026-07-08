# M6 意图账本 · userFillsByTime 分页 + 账本锚定窗口化成交对账（E’）

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）；A#39·C#40·B#41·D#42·E1E2#43·E3#44 已合并

## 背景

E 的自动对账用 `userFills`（最近 ~2000 条成交）匹配 cloid→filled。高频账户上，一笔
「从未 resting、即成即完」的单，其成交可能在下次轮询前滚出 2000 窗口 → 永远不被标
`filled` → 永久孤儿（E code-review 的遗留 Low）。本子项目改用 `userFillsByTime`
（时间窗、可分页），并把成交查询**锚定到该 keyID 最老未终态意图的时间**，既不漏又省页数。

## 设计要点（对已批准方案的实现细化）

- **OpenCloids 每轮照查**（每 account）——保持观测性与「新意图 signed→open」推进；openOrders
  是单快照、廉价。
- **fills 查询窗口化**：锚点 = 该 account 的 keyID 下**所有未终态意图 `updatedAt` 的最小值**；
  若该 keyID 无未终态意图，锚点取 `now`（窗口从当下起 → 成交查询近乎空，廉价）。
- 锚点安全性：未终态意图的成交必发生在其 `updatedAt`（签名/上次转移时刻）之后 → 自
  min(updatedAt) 起查必不漏该单成交。

## E’1 `internal/hlinfo`：`FillsByCloidSince`

`rawFill` 增补 `Time int64 json:"time"`、`Tid int64 json:"tid"`（`userFills` 路径不用，无害）。
新增：

```go
// fillsMaxPages caps pagination so a hot account can't spin the loop unbounded.
const fillsMaxPages = 50

// FillsByCloidSince pages userFillsByTime forward from startMs, aggregating fills
// by cloid (dedup by trade id across page boundaries) until an empty page, no
// forward progress, or fillsMaxPages. Fills with null cloid are dropped. Best-effort
// on cap: returns what it has (orphan detection still backstops any gap).
func (c *Client) FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]Fill, error)
```

分页逻辑：
- 每页 POST `{"type":"userFillsByTime","user":user,"startTime":cursor}`（body 用 `map[string]any`，
  `startTime` 为 int）。
- 空页 → 停。否则遍历：按 `tid` 去重后聚合（sz 和、closedPnl 和、px 加权，与现 `FillsByCloid` 同）；
  记 `maxTime`。
- `next = maxTime + 1`；若 `next <= cursor`（窗口未前进，防死循环）→ 停；否则 `cursor = next` 续页。
- `fillsMaxPages` 封顶 → 停（best-effort）。
- 保留现有 `FillsByCloid`（userFills）作通用工具，其测试不变。

测试（`hlinfo_test.go` 追加）：
- 多页：httptest 按请求体 `startTime` 分段回不同页（第 1 页满、含跨页边界同 `tid` 重复；第 2 页短/空）→
  断言聚合正确、tid 去重、`startTime` 随游标推进、`maxTime+1` 翻页。
- 空首页 → 空 map。
- `fillsMaxPages` 封顶：始终回满页且 time 递增 → 不无限循环，返回聚合（页数 = 上限）。

## E’2 `internal/reconciler`：账本锚定 + 窗口化 fills

`InfoClient` 接口把 `FillsByCloid` 换成 `FillsByCloidSince`（`OpenCloids` 不变）：

```go
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]hlinfo.Fill, error)
}
```

新增包级常量 + `step` 改写：

```go
// allNonTerminalCutoffMs is a far-future cutoff (year ~2096) so Orphans returns
// every currently non-terminal intent; the reconciler uses their min updatedAt as
// the per-key fills anchor.
const allNonTerminalCutoffMs int64 = 4_000_000_000_000

func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil
	}
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
	if err != nil {
		return err
	}
	// oldest non-terminal intent's updatedAt per keyID = that key's fills anchor.
	anchorByKey := make(map[string]int64)
	for _, o := range orphs {
		if cur, ok := anchorByKey[o.KeyID]; !ok || o.UpdatedAtMs < cur {
			anchorByKey[o.KeyID] = o.UpdatedAtMs
		}
	}
	now := time.Now().UnixMilli()
	for _, a := range r.accounts {
		anchor, ok := anchorByKey[a.KeyID]
		if !ok {
			anchor = now // no pending intents → fills window from now (≈empty)
		}
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		if err != nil {
			return err
		}
		// union reconcile via targetFor (unchanged)
		seen := make(map[string]struct{}, len(open)+len(fills))
		for cloid := range open {
			seen[cloid] = struct{}{}
		}
		for cloid := range fills {
			seen[cloid] = struct{}{}
		}
		for cloid := range seen {
			target, ok := targetFor(cloid, open, fills)
			if !ok {
				continue
			}
			if err := r.reconcileOne(ctx, a.KeyID, cloid, target); err != nil {
				return err
			}
		}
	}
	return nil
}
```

（`import "time"` 追加。`targetFor`/`reconcileOne`/`Run`/`WithLeaderGate` 不变。）

测试（`reconciler_test.go` 更新）：
- fake `InfoClient` 的 `FillsByCloid` 方法改名 `FillsByCloidSince(ctx,user,startMs)`，
  记录**最后一次 startMs**（供锚点断言），仍返回 `f.fills[user]`（忽略 startMs）。
- 既有用例保持（`TestStepAdvancesOpenAndFilled`/`SkipsUnknownCloid`/`ReturnsClientError`/
  `MultiAccount`/`RunStepsUntilCanceled`/`LeaderGate*`）——因 OpenCloids 每轮照查，空账本
  仍触发 client 调用，无需播种改动（仅方法签名随接口更新）。
- 新增 `TestStepAnchorsFillsToOldestNonTerminal`：播种两个 signed 意图（不同 updatedAt——
  用 `seedSignedAt` 或先播一个、sleep 1ms 再播另一个以拉开 updatedAt），跑 step →
  断言 fake 记录的 startMs == 两者 updatedAt 的较小值。
- 新增 `TestStepAnchorsToNowWhenNoPending`：空账本（无未终态）→ step → 断言 fake 记录的
  startMs ≈ now（≥ 测试开始时刻），证明无待办时窗口从当下起。

## 数据流（接线后，行为不变，仅 fills 来源变）

leader 每 `interval` → step → `Orphans` 求每 keyID 锚点 → 每 account：`OpenCloids` +
`FillsByCloidSince(anchor)` → `targetFor` 对账。窗口锚定确保「即成即完」单的成交不因
2000 窗口滚动而漏。

## 非目标（YAGNI）

- 不改 openOrders 查询（单快照即可）；不持久化 fills 游标（无状态、重启安全）。
- 同一毫秒海量成交跨页拆分的极端边界不特殊处理（tid 去重覆盖重复；HL 时间游标分页的固有
  限制，与 mobile TWAP 分页一致）；`fillsMaxPages` 封顶 + 孤儿端点兜底。
- 不做限频/多 AZ/指标（=M10）；不改 `internal/hl`/`internal/ledger`。

## 验收门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./...`

> 备注：`userFillsByTime` 的 fill 含 `time`(ms) 与 `tid`；实现时以真实字段名为准（必要时快速核对）。
