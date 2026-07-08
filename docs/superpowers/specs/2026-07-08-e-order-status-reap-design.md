# M6 意图账本 · orderStatus 权威查单 reap canceled/rejected（E’’）

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）；A#39·C#40·B#41·D#42·E1E2#43·E3#44·E’#46 已合并

## 背景

自动对账（E/E’）只能把意图推进到 `open`/`filled`（源自 `frontendOpenOrders`/`userFillsByTime`）。
被 **canceled/rejected** 的单既不在 openOrders（非 resting）也不在 fills（未成交）→
`targetFor` 返回 false → 意图永久非终态（孤儿），并把 fills 锚点钉老（E’ 加了 7 天 `clampAnchor`
兜底）。本子项目让自动对账用 HL `orderStatus`（按 cloid 权威查单）reap 这些单到终态。

## 目标

- 对「既不在 openOrders 也不在 fills」的**非终态**意图，查 `orderStatus` 拿权威状态并
  `Reconcile` 到 `canceled`/`rejected`/`filled`/`open`。
- `unknownOid`（HL 无此单）→ **保留不动**（可能刚签未提交/HL 尚未索引；权威终态才 reap，
  杜绝误终态）。
- 保留 E’ 的 7 天 `clampAnchor` 作 unknownOid-永久 的极端兜底。

## E’’0 DAG：补 signed→canceled / submitted→canceled

reap 到 `canceled` 需要 `current→canceled` 合法。当前 DAG 仅 `open→canceled`；一笔
signed/submitted 的单在 HL 侧被 canceled（它已被接受再取消，我方未记录 open 中间态）时，
`signed→canceled`/`submitted→canceled` 为非法边 → reconcileOne 吞掉 → 无法 reap。故在
`internal/ledger/reconcile.go` 的 `allowedTransitions` 追加：`signed→canceled`、`submitted→canceled`
（HL 报 canceled 即证明该单曾被接受，跳过中间态安全；与 E 补 signed→open/filled 同理）。

同步测试改动：
- `internal/ledger/reconcile_test.go` `TestTransitionForwardChain` 追加
  `{StatusSigned,StatusCanceled,StatusCanceled}`、`{StatusSubmitted,StatusCanceled,StatusCanceled}` 为合法。
- `cmd/signer/main_test.go` `TestReconcileInvalidTransition` 现用 signed→canceled 期望 409——因该边
  已合法，改为先把记录驱动到终态 `filled`（`led.Reconcile` 到 submitted→filled）再 POST
  `{status:"open"}`（filled→open 非法）→ 409。
- `conformance` 的非法转移场景用 submitted→signed（回退），不受影响。

## E’’1 `internal/hlinfo`：`OrderStatus`

```go
// OrderStatusResult is an order's resolved status queried by cloid. Found=false
// means HL returned "unknownOid" (it has no record of this order).
type OrderStatusResult struct {
	Status string // HL order status string (e.g. "filled"/"open"/"canceled"/"marginCanceled"/"rejected"); "" if not found
	Found  bool
}

// OrderStatus queries orderStatus by cloid (passed as the oid field). A non-"order"
// response envelope (e.g. "unknownOid") yields Found=false.
func (c *Client) OrderStatus(ctx context.Context, user, cloid string) (OrderStatusResult, error)
```

实现：POST `{"type":"orderStatus","user":user,"oid":cloid}`，解码进：

```go
var resp struct {
	Status string `json:"status"` // "order" | "unknownOid"
	Order  *struct {
		Status string `json:"status"` // the order's HL status string
	} `json:"order"`
}
```

`resp.Status != "order" || resp.Order == nil` → `{Found:false}`；否则 `{Status: resp.Order.Status, Found:true}`。
（复用现有 `post` helper——它按 JSON 解码进任意 `out`，object 亦可。）

测试（`hlinfo_test.go`）：
- found：`{"status":"order","order":{"status":"canceled"}}` → `{Status:"canceled",Found:true}`。
- unknownOid：`{"status":"unknownOid"}` → `{Found:false}`。
- httptest 断言请求体 `type=="orderStatus"`、`oid==<cloid>`。
- 非 2xx → error。

## E’’2 `internal/reconciler`：reap 缺失非终态意图

`InfoClient` 追加：

```go
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]hlinfo.Fill, error)
	OrderStatus(ctx context.Context, user, cloid string) (hlinfo.OrderStatusResult, error)
}
```

纯映射（镜像 mobile `normalizeOrderStatus`）：

```go
// reapTarget maps an HL order status string to the ledger status to advance toward,
// ok=false for statuses that don't imply a lifecycle change (unknown/none).
func reapTarget(hlStatus string) (ledger.Status, bool) {
	switch {
	case strings.HasSuffix(hlStatus, "Rejected"), hlStatus == "rejected":
		return ledger.StatusRejected, true
	case strings.HasSuffix(hlStatus, "Canceled"), hlStatus == "canceled", hlStatus == "scheduledCancel":
		return ledger.StatusCanceled, true
	case hlStatus == "filled":
		return ledger.StatusFilled, true
	case hlStatus == "open", hlStatus == "resting", hlStatus == "triggered":
		return ledger.StatusOpen, true
	default:
		return "", false
	}
}
```

`step` 改写（按 keyID 分组非终态意图 → 锚点仍为组内 min updatedAt → open/fills 对账不变 →
再 reap「既不在 open 也不在 fills」的非终态 cloid）：

```go
func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil
	}
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
	if err != nil {
		return err
	}
	byKey := make(map[string][]ledger.Orphan)
	for _, o := range orphs {
		byKey[o.KeyID] = append(byKey[o.KeyID], o)
	}
	now := time.Now().UnixMilli()
	for _, a := range r.accounts {
		group := byKey[a.KeyID]
		anchor := now
		for _, o := range group {
			if o.UpdatedAtMs < anchor {
				anchor = o.UpdatedAtMs
			}
		}
		anchor = clampAnchor(anchor, now)
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		if err != nil {
			return err
		}
		// advance open/filled from the batch snapshots (unchanged).
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
		// reap non-terminal intents HL no longer reports as open/filled: query the
		// authoritative orderStatus and advance canceled/rejected (or filled) to terminal.
		for _, o := range group {
			if _, inOpen := open[o.Cloid]; inOpen {
				continue
			}
			if _, inFills := fills[o.Cloid]; inFills {
				continue
			}
			res, err := r.client.OrderStatus(ctx, a.Address, o.Cloid)
			if err != nil {
				return err
			}
			if !res.Found {
				continue // unknownOid → HL has no record; leave (may be mid-submission)
			}
			target, ok := reapTarget(res.Status)
			if !ok {
				continue
			}
			if err := r.reconcileOne(ctx, a.KeyID, o.Cloid, target); err != nil {
				return err
			}
		}
	}
	return nil
}
```

（`import "strings"` 追加。`targetFor`/`reconcileOne`/`Run`/`WithLeaderGate`/`clampAnchor`/常量不变。
去掉旧的 `anchorByKey` 单独 map——锚点改由 `byKey` 组内 min 求得，等价。）

测试（`reconciler_test.go`）：
- fake `InfoClient` 加 `OrderStatus` 方法（可配 `map[cloid]hlinfo.OrderStatusResult` + 记录被查的 cloid）。
- `TestReapTarget` 纯单测：`marginCanceled`/`canceled`/`scheduledCancel`→Canceled；`tickRejected`/`rejected`→Rejected；`filled`→Filled；`open`/`resting`/`triggered`→Open；未知→false。
- `TestStepReapsCanceled`：播种 signed 意图 c1；fake open/fills 皆空；fake orderStatus[c1]=`{Status:"canceled",Found:true}` → step → 断言 c1 变 canceled（`statusOf` 已消失=终态；或用 Orphans 确认不在）。
- `TestStepLeavesUnknownOid`：同上但 orderStatus[c1]=`{Found:false}` → step → c1 仍非终态（signed）。
- `TestStepSkipsOrderStatusWhenOpenOrFilled`：c1 在 fake open 中 → step 后 orderStatus 未被查（fake 记录为空）——证明只对缺失意图查 orderStatus。
- 既有 step/Run/LeaderGate/anchor 用例：fake 加 `OrderStatus`（缺省返回 `{Found:false}`）后保持通过。

## 非目标（YAGNI）

- 不改 openOrders/fills 查询；不设 staleness 门（`unknownOid` 已天然防误 reap 刚签在途单）。
- 不移除 `clampAnchor`（保留 unknownOid-永久 兜底）。
- 不改 `internal/hl`/`cmd/signer` 的签名逻辑；`internal/ledger` **仅**在 reconcile.go 追加
  signed→canceled/submitted→canceled 两条边（及其测试）。

## 验收门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./...`
