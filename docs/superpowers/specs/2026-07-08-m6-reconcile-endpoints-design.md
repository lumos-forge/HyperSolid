# M6 意图账本 · 对账端点接线 signer（`cmd/signer`）— 子项目 D

日期：2026-07-08
状态：已批准，待实现
所属：M6 意图账本 / cloid 对账（§6.2）；A（#39 幂等核心）+ C（#40 签名接线）+ B（#41 对账状态机）已合并

## 背景

B（PR #41）落地了对账状态机（`Reconcile`）与孤儿单侦测（`Orphans`），但只在库层——
signer 服务里持有的账本仍以 `ledger.Authorizer` 暴露，调用方无法上报订单状态或查询孤儿单。
本子项目 D 把 `Reconcile`/`Orphans` 接上 signer 的 HTTP 端点，让 B 真正可用，正如 C 把 A 的
`Authorize` 接上 `/v1/sign/l1`。

## 目标

- signer 持有的账本从 `ledger.Authorizer` 拓宽为 `ledger.Ledger`（= Authorizer + Reconciler；
  `Mem` 与 `pg.Store` 已实现），签名路径与字节完全不变。
- 新增 `POST /v1/reconcile`：上报 (keyID, cloid) 的状态转移。
- 新增 `GET /v1/orphans?olderThanMs=N`：查询非终态且陈旧的孤儿单。

## 非目标（YAGNI）

- 不接 HL 回执源/poller 自动喂 `Reconcile`（= 后续 E）。
- 不加鉴权层（内部服务，与现有 `/v1/*` 端点一致——无 auth）。
- 不对孤儿单采取动作（撤单等）——仅查询返回。
- 不改 `internal/ledger` 核心与 `internal/hl`；不动 `/v1/sign/l1` 逻辑与 `/v1/digest/l1`。
- reconcile/orphans **不加 fencer/leader 门**：状态转移由行锁 + forward-only DAG 天然安全，
  陈旧实例上报旧状态会被 `ErrInvalidTransition` 拒绝；孤儿查询是只读。二者不分配 nonce。

## 架构与改动（仅 `backend/cmd/signer/`）

### 1. `newMux` 账本类型拓宽

`newMux(ks, policies, led ledger.Ledger, fencer Fencer, nowMs func() int64)`（原 `auth ledger.Authorizer`）。
`handleSignL1` 签名不变（仍 `auth ledger.Authorizer`）——`newMux` 传入的 `led` 满足 `Authorizer`。
新增两条路由：

```go
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks, policies, led, fencer, nowMs))
	mux.HandleFunc("/v1/reconcile", handleReconcile(led))
	mux.HandleFunc("/v1/orphans", handleOrphans(led))
```

`buildHandler` 构造不变（`ledger.NewMem()` 与 `ledgerpg.New(pool)` 已是 `ledger.Ledger`）。

### 2. `POST /v1/reconcile`

请求/响应：

```go
type reconcileRequest struct {
	KeyID  string `json:"keyId"`
	Cloid  string `json:"cloid"`
	Status string `json:"status"`
}
type reconcileResponse struct {
	Status string `json:"status"`
}
```

`handleReconcile(led ledger.Reconciler) http.HandlerFunc`：
1. 非 `POST` → 405。
2. 解码失败 → 400 `invalid json`。
3. 校验 `Status` ∈ 六态 `{signed,submitted,open,filled,rejected,canceled}`（否则 400 `invalid status`）——
   fail-closed，拒绝垃圾状态串。
4. `st, err := led.Reconcile(r.Context(), req.KeyID, req.Cloid, ledger.Status(req.Status))`。
5. 错误映射：`ledger.ErrUnknownIntent`→404 `unknown intent`；`ledger.ErrInvalidTransition`→409
   `invalid transition`；其它（基础设施）→500 `reconcile failed`。
6. 成功 → 200 `{status: string(st)}`。

> 校验第 3 步用一个 `validStatus(s string) bool`（六态集合）判定。注意允许 target=`signed`
> 通过校验（合法状态串），但 `Transition` 会把任意 `X→signed` 判为非法 → 409（除非本就是 signed
> 的幂等自身，那也是合法的 no-op），行为正确。

### 3. `GET /v1/orphans?olderThanMs=N`

`handleOrphans(led ledger.Reconciler) http.HandlerFunc`：
1. 非 `GET` → 405。
2. `olderThanMs` 缺失或非法（`strconv.ParseInt` 失败）→ 400 `invalid olderThanMs`。
3. `orphs, err := led.Orphans(r.Context(), n)`；错误 → 500 `orphans failed`。
4. 成功 → 200 `{orphans: [...]}`，元素形如：

```go
type orphanDTO struct {
	KeyID       string `json:"keyId"`
	Cloid       string `json:"cloid"`
	Nonce       uint64 `json:"nonce"`
	Status      string `json:"status"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}
type orphansResponse struct {
	Orphans []orphanDTO `json:"orphans"`
}
```

（`led.Orphans` 返回 `nil` 时响应 `{"orphans":[]}`——初始化为 `[]orphanDTO{}` 避免 JSON `null`。）

## 数据流

M4（对账侧）：
- 提交订单后 → `POST /v1/reconcile {keyId,cloid,status:"submitted"}`；收到 HL 回执 →
  `.../reconcile {status:"open"|"filled"|"rejected"|"canceled"}`。
- 后台 job → `GET /v1/orphans?olderThanMs=<now-ttl>` → 得到签了但久未确认的候选，进一步处置（撤单等，后续）。

## 错误处理（fail-closed）

| 情形 | HTTP |
|---|---|
| 非 POST/GET | 405 |
| 坏 JSON / 缺 olderThanMs / 非法数字 | 400 |
| 未知 status 串 | 400 |
| 未知 (keyID,cloid) | 404 |
| 非法转移 | 409 |
| 基础设施（DB） | 500 |

## 测试（`cmd/signer/main_test.go`）

httptest + `ledger.NewMem()`，直接 `Authorize` 播种 signed 记录（不经 sign 端点）。用例：
- reconcile happy：播种 signed → `POST /v1/reconcile {status:submitted}` → 200 `{status:"submitted"}`。
- reconcile 未知意图：未播种 → 404。
- reconcile 非法转移：播种 signed → 上报 `open`（跳态）→ 409；另：先到 filled 再上报 rejected → 409。
- reconcile 坏 status 串（如 `"bogus"`）→ 400；坏 JSON → 400；非 POST（GET）→ 405。
- orphans：播种 2 个非终态 + 1 个（submitted→filled 终态）→ `GET /v1/orphans?olderThanMs=4000000000000`
  返回 2 个非终态（不含 filled）；`?olderThanMs=1000000000` → 空数组；缺 param → 400；非 GET（POST）→ 405。
- 既有测试（golden/sign/fenced 等）不受影响（newMux 传 `ledger.NewMem()`/`led` 仍满足 Authorizer）。

## 验收门

- `cd backend && go test ./... && go vet ./...`
- `cd backend && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
- 集成编译校验：`cd backend && go test -c -tags=integration -o /dev/null ./...`
