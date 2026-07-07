# policy 门控 `/v1/sign/l1`（§5.1a 落地）

日期：2026-07-07
状态：已批准，待实现

## 背景

PR #23 交付了纯 reject-first 评估器 `internal/policy.Evaluate(intent, cfg)`；PR #21 让 `cmd/signer` `/v1/sign/l1` 能用 keystore 签名。二者尚未连接——`docs/BACKEND-ARCHITECTURE.md §5.1a` 要求签名器"不接受裸 payload 签名"、护栏绑进签名边界。本片把 policy 门控**接进签名端点**：签名前先 reject-first 评估每 key 的 policy。这是 §5.1a 的落地。仍不接入 TS 运行时（`cmd/signer` 独立、不持生产密钥）。

## 现状

- `internal/policy`（PR #23）：`Intent{Kind,Coin string; NotionalUsdc float64}`；`Config{AllowedKinds map[string]bool; KillSwitch bool; MaxNotionalUsdc float64; PerCoinMaxUsdc map[string]float64}`；`Decision{Allow bool; Reason string}`；`Evaluate(intent, cfg) Decision`（default-deny；负数/NaN notional → `"invalid notional"`；kill-switch/kind 白名单/名义封顶）。
- `cmd/signer/main.go`（PR #21）：`handleSignL1(ks *keystore.Keystore)` —— method(405)/json(400)→`ks.Signer(keyId)`缺失(404)→`hl.ActionFromKind`(400)→`SignL1Action`(500)→200 `{r,s,v}`。`newMux(ks)`、`main()` 建空 keystore。
- `hl.ActionFromKind(kind, params)`；order 的 params 形状 `{asset int64, isBuy bool, px string, sz string, reduceOnly bool, tif string, grouping string, cloid string}`。

## 架构

保持 `keystore` 纯（密钥托管）；新增独立注入的 **`policy.Store`**（keyId → `policy.Config`），**缺失 keyId 返回零值 Config → default-deny**（fail-closed）。签名端点在签名前插入 reject-first 门控。

### 组件 1：`internal/policy` 加 `Store`（`backend/internal/policy/store.go`）

并发安全的 keyId → Config 注册表：

```go
type Store struct {
	mu    sync.RWMutex
	byKey map[string]Config
}

func NewStore() *Store
func (s *Store) Set(keyID string, cfg Config)   // 绑定/替换某 key 的 policy
func (s *Store) Get(keyID string) Config          // 缺失 → 零值 Config（default-deny）
```

- `Get` 对未知 keyId 返回 `Config{}`（零值）——`Evaluate` 对零值 Config 拒一切，故未配置 policy 的 key 无法签名（fail-closed）。

### 组件 2：`cmd/signer` policy 门控

- `newMux(ks *keystore.Keystore, policies *policy.Store) http.Handler`（注入两者）；`/healthz`、`/v1/digest/l1` 不变（keyless）。
- `handleSignL1(ks, policies)` 顺序：
  1. 非 POST → 405；坏 JSON → 400。
  2. `signer, ok := ks.Signer(req.KeyID)`；`!ok` → **404** `"unknown keyId"`。
  3. **policy 门控**：`intent := intentFor(req.Kind, req.Params)`；`d := policy.Evaluate(intent, policies.Get(req.KeyID))`；`!d.Allow` → **403** `{"error": d.Reason}`。
  4. `action, err := hl.ActionFromKind(req.Kind, req.Params)`；err → 400。
  5. `sig, err := signer.SignL1Action(...)`；err → 500 `"sign failed"`。
  6. 200 `{r,s,v}`。
- `intentFor(kind string, params json.RawMessage) policy.Intent`（`cmd/signer` 内的 helper）：
  - `kind == "order"`：解 `{asset int64, px string, sz string}`；`pxF, errP := strconv.ParseFloat(px, 64)`；`szF, errS := strconv.ParseFloat(sz, 64)`；`notional := pxF * szF`；若 `errP != nil || errS != nil` → `notional = math.NaN()`（→ policy 拒 `"invalid notional"`）；返回 `Intent{Kind:"order", Coin: strconv.FormatInt(asset,10), NotionalUsdc: notional}`。
  - 其它 kind：`Intent{Kind: kind, Coin: "", NotionalUsdc: 0}`（非名义类；policy 只按 kind 白名单判）。
  - JSON 解析失败（order 的 params 坏）→ 视为无法计算名义额 → `Intent{Kind:"order", NotionalUsdc: math.NaN()}`（fail-closed 拒）。
- `main()`：`ks := keystore.New(); policies := policy.NewStore(); newMux(ks, policies)`。空 keystore（404）+ 空 policy（default-deny）→ **双重 fail-closed**。

## 数据流

```
POST /v1/sign/l1 {keyId,kind,params,nonce,isTestnet}
  → ks.Signer(keyId)            // 缺失 → 404
  → intentFor(kind, params)     // order: notional=px*sz（坏值→NaN）；coin=asset索引
  → policy.Evaluate(intent, policies.Get(keyId))   // 缺失 policy → 零 Config → deny
       deny → 403 {reason}      |  allow ↓
  → hl.ActionFromKind(...)      // 坏 kind/params → 400
  → signer.SignL1Action(...)    // → 500 on error
  → 200 {r,s,v}
```

## 关键安全性质

- **policy 缺失即拒**：未 `Set` 的 keyId → `Get` 返回零 Config → `Evaluate` 拒 `"kind not allowed"`（fail-closed）。
- **畸形名义额拒绝**：order 的 px/sz 不可解析 → `intentFor` 置 NaN → policy 拒 `"invalid notional"`。
- **reject-first 在签名之前**：policy 门控在 `ActionFromKind`/`SignL1Action` 之前，越界意图不产生签名。
- 响应仍只回 `{r,s,v}`；deny 回 `reason`（不含密钥）；私钥永不入响应/日志。
- 空二进制（空 keystore + 空 policy）签不了任何东西。

## 测试

- `internal/policy/store_test.go`：`Set` 后 `Get` 返回该 Config；未 `Set` 的 keyId `Get` 返回零 Config（`Evaluate` 对它拒）；并发 Set/Get 无 race（`go test -race`）。
- `cmd/signer/main_test.go`：
  - 既有 `newMux(...)` 调用改为 `newMux(ks, policy.NewStore())`（`TestHealthz`/`TestDigestL1*`/`TestSignL1UnknownKey`/`TestSignL1BadKind`）。
  - `TestSignL1Endpoint` 现需为测试 key `policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{golden向量的kind: true}, MaxNotionalUsdc: 1e12})`（宽松，覆盖该向量名义额）→ 仍 200 且 `{r,s,v}` 与 golden 逐字节相等。
  - 新增 **policy 缺失 → 403**：key 已 `Add` 但未 `Set` policy → POST order → 403 `"kind not allowed"`。
  - 新增 **超封顶 → 403**：`Set` 允许 order 但 `MaxNotionalUsdc` 小于向量名义额 → 403 `"over notional cap"`。
  - `TestSignL1BadKind`（key 已 Add，POST `kind:"nope"`）：policy 门控在 `ActionFromKind` 之前，`"nope"` 不在白名单 → **policy 先拒**。把该用例断言从 400 改为 **403 `"kind not allowed"`**（`"nope"` 永不被允许）。
  - 新增 **policy 通过但 params 坏 → 400**（保留 ActionFromKind 400 覆盖）：`policies.Set("k1", policy.Config{AllowedKinds: {"cancel": true}, MaxNotionalUsdc: 1e12})`；POST `kind:"cancel"` 配坏 params（如 `{"cancels": "notarray"}`）→ policy 放行（cancel 非名义、在白名单）→ `ActionFromKind` 解析失败 → **400**。

## 验证门槛

- `cd backend && go test ./... && go vet ./...` 全绿；`go build ./cmd/signer` 成功。
- `go test -race ./internal/policy/ ./cmd/signer/` 通过。
- 端到端 smoke：起服务 → `/v1/sign/l1` 未知 keyId → 404（空 keystore）。

## 范围外（YAGNI）

- per-coin 用**币符号**（需 HL meta；本片 per-coin 键 = asset 索引字符串）。
- 有状态每日封顶、`internal/nonce` 单写者、生产 policy/密钥加载、接入 TS/replace、mTLS。
