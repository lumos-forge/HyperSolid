# Go 签名引擎：进程内 keystore + cmd/signer /v1/sign/l1（不接入生产）

日期：2026-07-06
状态：已批准，待实现

## 背景

`cmd/signer`（PR #20）已站起一个**不持钥**的 digest 服务（`/healthz`、`/v1/digest/l1`）。本片是 M5 签名器路线的下一步：让 Go 侧**真正产出签名**——新增一个进程内 keystore（复用既有 tier-① `hl.Signer`）+ `/v1/sign/l1` 端点。

**关键安全边界**：
- 本片交付的是签名**引擎**，**不接入 TS 运行时**、不改变生产签名路径。
- 可运行二进制启动时 keystore **为空**（fail-closed）；**没有任何加载私钥的 HTTP 或 env 路径**——私钥仅在测试里程序化注入。生产密钥加载/托管迁移是**独立的下一子项目**。
- 私钥属于 HL **trade-only agent key**（可交易、不可提现，HL 保证）；主钱包私钥永不离设备（红线不受影响）。
- `docs/BACKEND-ARCHITECTURE.md §5.1a`：签名器最终须是**拒绝优先 policy 引擎**（"不接受裸 payload 签名"）。本片是其底层签名引擎；**生产 cutover 前必须先由 policy 层（下一子项目）包裹**。此约束在本 spec 显式记录，防止误将裸 `/v1/sign/l1` 直接接入生产。

## 现状复用

- `hl.Signer`（`backend/internal/hl/signer.go`）：`NewSigner(priv []byte) (*Signer, error)`；`SignL1Action(action Map, nonce uint64, isTestnet bool) (Sig, error)`；`Close()`（归零 key；Close 后再签返回 error）。`Sig{R,S [32]byte; V byte}`。
- `hl.ActionFromKind(kind string, params json.RawMessage) (Map, error)`（PR #20）。
- `cmd/signer/main.go`（PR #20）：`newMux() http.Handler`（`/healthz` + `/v1/digest/l1`）+ `main()`。
- golden 向量（`testdata/golden.json`）每条含 `privKey`（0x-hex）、`kind`、`params`、`nonce`、`isTestnet`、`sig{r,s,v}`——用作签名端点的 byte-exact 断言（所有向量同一 PK `0x1111…1111`）。

## 架构（纯增量 Go）

### 组件 1：`backend/internal/keystore/keystore.go`（新包）

并发安全地按**不透明 keyId** 管理多个 `*hl.Signer`：

```go
package keystore

type Keystore struct {
	mu   sync.RWMutex
	byID map[string]*hl.Signer
}

func New() *Keystore
func (k *Keystore) Add(keyID string, priv []byte) error   // NewSigner(priv); 若已存在同 keyId 先 Close 旧的再替换
func (k *Keystore) Signer(keyID string) (*hl.Signer, bool) // 查找
func (k *Keystore) Remove(keyID string)                    // Close(归零) + delete
func (k *Keystore) Close()                                 // Close 全部 + 清空
```

- `Add` 对非法私钥（`NewSigner` 报错，如长度≠32）返回 error，不写入。
- `Remove`/`Close` 必须调用底层 `Signer.Close()` 以归零 key 材料。
- keyId 是不透明字符串，与 owner 地址解耦（签名层不感知托管映射）。

### 组件 2：`cmd/signer` 新增 `/v1/sign/l1`

- `newMux` 改为 `newMux(ks *keystore.Keystore) http.Handler`（注入 keystore）；`/healthz`、`/v1/digest/l1` 逻辑不变（digest 仍 keyless，不碰 keystore）。
- `handleSignL1(ks)`：
  - 仅 `POST`；否则 405。
  - 解 `{ "keyId": string, "kind": string, "params": <object>, "nonce": <uint>, "isTestnet": <bool> }`；坏 JSON → 400。
  - `signer, ok := ks.Signer(req.KeyId)`；`!ok` → **404** `{"error":"unknown keyId"}`（fail-closed，不泄露是否曾存在）。
  - `action, err := hl.ActionFromKind(req.Kind, req.Params)`；err → 400。
  - `sig, err := signer.SignL1Action(action, req.Nonce, req.IsTestnet)`；err（如 signer 已 Close）→ 500 `{"error":"sign failed"}`。
  - 200 `{ "r": "0x"+hex(R), "s": "0x"+hex(S), "v": <int> }`。
  - **绝不**在响应或日志中包含私钥或 keyId 之外的密钥材料。
- `main()`：`ks := keystore.New()`（**空**）→ `newMux(ks)`。运行态无法签任何东西（未知 keyId → 404），直到未来子项目引入受控密钥加载。

## 数据流

```
POST /v1/sign/l1 {keyId,kind,params,nonce,isTestnet}
  → ks.Signer(keyId)         // 缺失 → 404 fail-closed
  → hl.ActionFromKind(...)   // 坏 kind/params → 400
  → signer.SignL1Action(action,nonce,isTestnet)  // Close 后 → 500
  → 200 {r,s,v}
```

## 测试

- `internal/keystore/keystore_test.go`：
  - `Add` 后 `Signer(keyId)` 返回可用 signer（能 `SignL1Action` 成功）。
  - 非法私钥（如 16 字节）`Add` 返回 error 且不可查到。
  - `Remove` 后 `Signer(keyId)` 返回 `false`，且被移除的 signer 已归零（对其 `SignL1Action` 返回 error）。
  - 用同 keyId 重复 `Add` 会 Close 旧 signer（旧 signer 引用签名失败）并以新 key 生效。
  - `Close()` 后所有 keyId 查不到。
- `cmd/signer/main_test.go`（新增用例，`newMux(ks)` + `httptest`）：
  - **签名 happy path**：取一条 golden 向量，`ks.Add("k1", 该向量 privKey 字节)`；POST `{keyId:"k1", kind,params,nonce,isTestnet}`；断言 200 且响应 `{r,s,v}` 与该向量 `sig` **逐字节相等**（证明 Go 引擎产出的签名 = @nktkas = HL 可接受）。
  - 未知 keyId → 404。
  - 已知 keyId + 坏 kind → 400。
  - 既有 `/healthz`、`/v1/digest/l1` 用例改用 `newMux(keystore.New())`，保持通过。

## 验证门槛

- `cd backend && go test ./... && go vet ./...` 全绿。
- `go build ./cmd/signer` 成功。
- 端到端 smoke（可选人工）：起服务 → `/healthz` 200；`/v1/sign/l1` 用未知 keyId → 404（fail-closed，因运行态 keystore 为空）。

## 范围外（YAGNI，后续子项目）

- **生产密钥加载/托管迁移**（keystore 如何在生产被受控填充：从加密存储 / KMS / provision 流程；含鉴权）。
- `internal/policy` 拒绝优先引擎（§5.1a，cutover 前置）。
- `internal/nonce` 租约/fencing 单写者。
- 接入 TS/replace 模式、user-signed 签名端点、mTLS/鉴权、KMS（档②）。
