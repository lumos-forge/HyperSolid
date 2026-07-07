# nonce 接入 `/v1/sign/l1`（模型 A：签名端生成 nonce）

日期：2026-07-07
状态：已批准，待实现

## 背景

PR #25 交付了 `internal/nonce.Allocator`（进程内每-key 单调递增 ms nonce）。PR #24 让 `/v1/sign/l1` 用 keystore-backed + policy 门控签名，但 **nonce 仍由客户端传入**（`req.Nonce`）。`docs/BACKEND-ARCHITECTURE.md §5.2`：签名器是 nonce **单写者**。本片按**模型 A（生成式）**接入：签名端用 `Allocator.Next(keyId)` 生成 nonce，客户端不再传 nonce、也无法挑/复用/重放；响应返回所用 nonce（供调用方构造 HL wire 请求）。

## 现状

- `cmd/signer/main.go`（PR #24）：`signL1Request{KeyID, Kind string; Params json.RawMessage; Nonce uint64; IsTestnet bool}`；`signL1Response{R,S string; V int}`；`handleSignL1(ks *keystore.Keystore, policies *policy.Store)`——404(未知 key) → 403(policy) → `hl.ActionFromKind` 400 → `SignL1Action(action, req.Nonce, req.IsTestnet)` 500 → 200 `{r,s,v}`。`newMux(ks, policies)`；`main()` 建空 keystore + 空 policy。
- `internal/nonce`（PR #25）：`New(nowMs func() int64) *Allocator`（nil→真实时钟）；`Next(keyID string) uint64`（严格递增 ms nonce）。
- `main_test.go`：`newMux(keystore.New(), policy.NewStore())` 多处；`TestSignL1Endpoint`（`loadFirstGolden` 第一条向量 `order-limit-gtc-mainnet`，`v.Nonce`=1700000000000，`v.Sig`；`ks.Add("k1",key)`；`policies.Set("k1", …AllowedKinds[v.Kind], 1e12)`；POST 含 nonce 的 body；断言 `{r,s,v}`==`v.Sig`）；`TestSignL1UnknownKey`(404)、`TestSignL1BadKind`(403)、`TestSignL1DeniedWithoutPolicy`(403)、`TestSignL1OverNotionalCap`(403)、`TestSignL1BadParamsAfterPolicy`(400)、`TestSignL1ModifyOverNotionalCap`(403)、`TestSignL1BatchModifyOverNotionalCap`(403)、`TestSignL1BatchModifyNegativeLegMasking`(403)、`TestSignL1OrderNegativePriceRejected`(403)。

## 架构

`/v1/sign/l1` 成为 nonce 单写者。`nonce.Allocator` 注入 `newMux`/`handleSignL1`；nonce 在 **policy 与 ActionFromKind 都通过后**才 `Next`（被拒/坏参不消耗 nonce）。digest 端点不变。

### 改动（`cmd/signer/main.go`）

1. import 增加 `.../internal/nonce`。
2. `signL1Request` **删除 `Nonce uint64` 字段**（保留 KeyID/Kind/Params/IsTestnet）。
3. `signL1Response` **增加 `Nonce uint64 \`json:"nonce"\`` 字段**。
4. `handleSignL1(ks *keystore.Keystore, policies *policy.Store, nonces *nonce.Allocator)`：
   - 顺序不变直到 `ActionFromKind`（404 / 403 / 400）。
   - `ActionFromKind` 成功后：`n := nonces.Next(req.KeyID)`；`sig, err := signer.SignL1Action(action, n, req.IsTestnet)`；err → 500。
   - 200 响应 `signL1Response{R, S, V, Nonce: n}`。
5. `newMux(ks *keystore.Keystore, policies *policy.Store, nonces *nonce.Allocator) http.Handler`；`/v1/sign/l1` 挂 `handleSignL1(ks, policies, nonces)`；`/healthz`、`/v1/digest/l1` 不变。
6. `main()`：`nonces := nonce.New(nil)`；`newMux(ks, policies, nonces)`；日志不变或注明 fail-closed。

## 数据流

```
POST /v1/sign/l1 {keyId,kind,params,isTestnet}   // 无 nonce
  → ks.Signer(keyId) 404 → policy.Evaluate 403 → hl.ActionFromKind 400
  → n := nonces.Next(keyId)          // 单写者生成，严格递增
  → signer.SignL1Action(action, n, isTestnet) 500
  → 200 {r,s,v,nonce:n}
```

## 测试（`cmd/signer/main_test.go`）

- import 增加 `.../internal/nonce`。
- 所有 `newMux(ks, policies)` 调用改为三参：不签名的用例（404/403/400）传 `nonce.New(nil)`。请求体里残留的 `"nonce":1` 被 json 解码忽略（`signL1Request` 已无该字段），无需清理。
- `TestSignL1Endpoint` 改为模型 A：
  - 注入固定时钟 allocator：`nonces := nonce.New(func() int64 { return int64(v.Nonce) })`；`newMux(ks, policies, nonces)`。
  - 请求体去掉 nonce（marshal 的匿名 struct 删 `Nonce` 字段）。
  - 断言：200；响应 `{r,s,v}` 与 `v.Sig` 逐字节相等（因 `Next` 首调返回 `v.Nonce`，签名与 golden 一致）；响应 `nonce == v.Nonce`。
- 新增 `TestSignL1GeneratesMonotonicNonce`：
  - `ks.Add("k1", key)`（用 golden 私钥或任意 32 字节）；`policies.Set("k1", policy.Config{AllowedKinds: {"order":true}, MaxNotionalUsdc: 1e12})`；`nonces := nonce.New(func() int64 { return 1700000000000 })`。
  - 同一 order body 连 POST 两次；解析两次响应的 `nonce`；断言 `n1 == 1700000000000` 且 `n2 == n1+1`（严格递增，签名端单写者）。两次都 200。

## 验证门槛

- `cd backend && go test ./... && go vet ./...` 全绿；`go build ./cmd/signer` 成功；`go test -race ./cmd/signer/` 通过。
- 端到端 smoke：起服务 → `/v1/sign/l1` 未知 keyId → 404（空 keystore 先拒，nonce 不生成）。

## 范围外（YAGNI）

- 跨进程租约/fencing 单写者、nonce 持久化。
- 把 nonce 窗口/单调校验加到 `/v1/digest/l1`（该端点为 keyless 影子对拍，须保留客户端固定 nonce）。
- 把签名端接入 TS 运行时（replace 模式）。
