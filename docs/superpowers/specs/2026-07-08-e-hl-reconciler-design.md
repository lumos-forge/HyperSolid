# M6 意图账本 · HL 回执源 + 自动对账循环（`internal/hlinfo` + `internal/reconciler`）— 子项目 E1+E2

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）；A(#39)+C(#40)+B(#41)+D(#42) 已合并

## 背景

D（PR #42）暴露了 `/v1/reconcile`/`/v1/orphans`，但状态推进仍需外部**手动**上报。本子项目
E1+E2 接入 HL 回执源：新增只读 HL info 客户端（E1）与后台对账循环（E2），周期性拉取每个
账户的 open orders / fills，按 cloid 映射为 `ledger.Status` 并调用账本 `Reconcile`，实现
**自动对账**。**先不接线**（把循环启动进 signer = 后续 E3）。

## 关键：账本键是 keyID，HL info 按账户地址

账本记录键为 (keyID, cloid)（keyID = agent 私钥 id）；HL `frontendOpenOrders`/`userFills`
按**账户主地址**查询。keystore 不暴露地址。故对账循环由外部配置 `Account{KeyID, Address}`
列表驱动（地址来源留给 E3 的 config）。

## 关键：DAG 需补 signed→open / signed→filled

HL info **不报 "submitted"**（openOrders=resting=open，userFills=filled；"submitted" 是我方
在提交-待确认间的可选中间态）。若调用方未上报 submitted，账本记录停在 `signed`；自动对账看到
它 resting（→open）或成交（→filled）时，当前 DAG 的 `signed→open`/`signed→filled` 为**非法边**，
会被跳过 → 记录无法推进。因此本片在 `internal/ledger/reconcile.go` 的 `allowedTransitions`
**追加两条边**：`signed→open`、`signed→filled`（HL 展示该单即证明已提交，跳过中间 submitted 是安全的）。
`submitted→open`/`submitted→filled` 已允许，故有/无 submitted 上报两种记录都能推进。

同步更新 `internal/ledger/reconcile_test.go`：`signed→open`、`signed→filled` 由「非法」改为「合法」断言。
（`conformance` 的对账场景未断言 signed→open 非法，无需改。）

## E1：`internal/hlinfo`（只读 HL info 客户端）

```go
package hlinfo

// Client is a read-only Hyperliquid /info client.
type Client struct {
	baseURL string       // e.g. https://api.hyperliquid.xyz (no trailing /info)
	http    *http.Client
}

// New returns a Client posting to baseURL+"/info". A nil hc uses http.DefaultClient.
func New(baseURL string, hc *http.Client) *Client

// OpenOrder is a resting order (minimal fields the reconciler/consumers need).
type OpenOrder struct {
	Oid  int64
	Coin string
	Side string // "buy" | "sell"
	Px   float64
}

// Fill aggregates a cloid's fills: total size, size-weighted avg price, total closed pnl.
type Fill struct {
	Sz       float64
	Px       float64
	ClosedPnl float64
}

// OpenCloids POSTs {"type":"frontendOpenOrders","user":user} and indexes resting
// orders by cloid (null-cloid orders — not ours — are dropped).
func (c *Client) OpenCloids(ctx context.Context, user string) (map[string]OpenOrder, error)

// FillsByCloid POSTs {"type":"userFills","user":user} and aggregates fills by cloid
// (null-cloid fills dropped; partial fills of one cloid summed, px size-weighted).
func (c *Client) FillsByCloid(ctx context.Context, user string) (map[string]Fill, error)
```

行为：
- POST `baseURL+"/info"`，`Content-Type: application/json`，body `{"type":<t>,"user":<user>}`。
- 非 2xx → error（含 status code）；响应体解码进类型化 slice 失败（坏 JSON / 非数组的错误
  响应体）→ error（由 `step` 上报、`Run` 记录并继续，可观测）。
- 解析镜像 TS `openOrdersReader`/`userFillsReader`：
  - open：`RawOpenOrder{cloid,oid,coin,side("B"|"A"),limitPx}`；`side` "A"→"sell" 否则 "buy"；跳过非 string cloid。
  - fills：`RawFill{cloid,px,sz,closedPnl}`（字符串数字）；按 cloid 聚合 `sz`、`closedPnl`、`px=Σ(px*sz)/Σsz`；跳过非 string cloid。

测试（`internal/hlinfo/*_test.go`，httptest，无实网）：
- open：喂含 cloid/null-cloid 的 JSON 数组 → 断言映射、null 丢弃、side/px 解析。
- fills：喂同 cloid 多条部分成交 → 断言聚合（sz 和、px 加权）。
- 非 2xx（500）→ error；坏 JSON → error；请求 body 含正确 `type`/`user`（httptest handler 断言）。

## E2：`internal/reconciler`（映射 + 循环）

```go
package reconciler

// Account binds an agent key id to the HL master account address whose orders it places.
type Account struct {
	KeyID   string
	Address string
}

// InfoClient is the read-side HL surface the reconciler needs (hlinfo.Client satisfies it).
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloid(ctx context.Context, user string) (map[string]hlinfo.Fill, error)
}

// Reconciler polls HL for each account and advances the ledger lifecycle.
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
}

func New(client InfoClient, led ledger.Reconciler, accounts []Account) *Reconciler

// step runs one poll+reconcile pass over all accounts. It returns the FIRST
// infrastructure error encountered (HL query / ledger infra); benign per-cloid
// rejections (ErrUnknownIntent = not our order; ErrInvalidTransition = stale/no-op)
// are skipped. Deterministic + injectable for tests.
func (r *Reconciler) step(ctx context.Context) error

// Run drives step on a ticker until ctx is done (thin loop; mirrors leader.Run).
func (r *Reconciler) Run(ctx context.Context, interval time.Duration)
```

### 映射与 step 逻辑

对每个 `account`：
1. `open, err := client.OpenCloids(ctx, account.Address)`；err → 返回（infra）。
2. `fills, err := client.FillsByCloid(ctx, account.Address)`；err → 返回（infra）。
3. 对 `open` 中每个 cloid：`reconcileOne(account.KeyID, cloid, ledger.StatusOpen)`。
4. 对 `fills` 中每个 cloid **且不在 `open`**：`reconcileOne(account.KeyID, cloid, ledger.StatusFilled)`。
   （open 优先：部分成交仍 resting 归 open。）

`reconcileOne` 调 `led.Reconcile(ctx, keyID, cloid, target)`；
- `errors.Is(ErrUnknownIntent)` 或 `errors.Is(ErrInvalidTransition)` → 跳过（benign）；
- 其它非 nil → 记为 step 的返回 infra 错误（首个）。

幂等友好：对已 open 记录反复 `Reconcile(open)` = no-op 且刷新 updatedAt（proof of life，防误判孤儿）。
已 filled 记录再收 `Reconcile(filled)` = 幂等；收 open（若 HL 仍列，异常）= filled→open 非法 → 跳过。

### 纯映射 helper（可选，便于单测）

```go
// targetFor returns the ledger status a cloid should advance toward given the open
// and fills snapshots, and ok=false when neither snapshot mentions it (no-op this cycle).
func targetFor(cloid string, open map[string]hlinfo.OpenOrder, fills map[string]hlinfo.Fill) (ledger.Status, bool)
```

测试（`internal/reconciler/*_test.go`）：
- `targetFor` 纯单测：open→open、fills-非-open→filled、都无→(_,false)、open+fills→open（优先）。
- `step` 用 fake `InfoClient`（canned 两 map）+ `ledger.NewMem()`：
  - 播种 signed 意图 cloid "c1"（仅 `Authorize`）；fake open={c1}；跑 step →
    经 `Orphans(farFuture)` 断言 c1 现为 `open`（依赖新增的 signed→open 边）。
  - 播种 signed 意图 "c2"；fake fills={c2}、open={}；跑 step → `Orphans(farFuture)` 不含 c2（终态 filled）。
  - 播种 submitted 意图 "c3"（Authorize+Reconcile 到 submitted）；fake open={c3} → step → c3 为 open。
  - fake open 含未知 cloid "x"（未 Authorize）→ step 不报错（ErrUnknownIntent 被跳过）。
  - fake client 返回 error → step 返回该 infra 错误。
  - 多 account：各自地址查询、各自 keyID 对账（fake 按 address 返回不同 map）。

## 数据流（本片内，未接线）

后台 `Run` → 每 `interval` → `step` → 对每 account：HL `frontendOpenOrders`+`userFills` →
open→`Reconcile(open)`、filled→`Reconcile(filled)` → 账本状态推进。E3 将把 `Run` 起进 signer。

## 非目标（YAGNI）

- 不接线 signer（=E3）；accounts 来源（config/env）留 E3。
- 不做 canceled/rejected 映射（openOrders+fills 无权威来源；后续可用 `orderStatus` 补）。
- 不做限频预算 / 多 AZ / 指标（=M10）。
- 不改 `internal/hl`；`internal/ledger` **仅**在 reconcile.go 追加 signed→open/signed→filled 两条边
  （及其测试断言），不改其它。不轮询 `orderStatus`（逐单昂贵，暂用 open+fills 批量）。
- 不做部分成交量跟踪（B 已定粗粒度）。

## 错误处理（fail-closed / 稳健）

- HL 查询失败 / 账本 infra 错误 → step 返回错误（`Run` 记录并继续下一轮，不崩溃）。
- 单 cloid 的 `ErrUnknownIntent`/`ErrInvalidTransition` → 跳过（预期/良性）。
- HL 响应坏 JSON / 非数组错误体 → 解码 error 上报（`Run` 记录并继续），不静默吞掉。

## 验收门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./...`（本片无新集成测试，仅保持编译）。
