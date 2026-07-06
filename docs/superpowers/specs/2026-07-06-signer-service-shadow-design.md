# M5 签名器落地第一步：cmd/signer digest 服务 + TS 影子校验

日期：2026-07-06
状态：已批准，待实现

## 背景

Go 签名核（`backend/internal/hl`）已 byte-exact 完成并有跨语言 golden 向量，但 `backend/` 仍是**纯库**（无 `cmd/`、无 `main`、无服务）。当前运行时是 TS `server/`（Fastify agent 引擎），下单经 `@nktkas` ExchangeClient（viem）内部签名，agent 私钥在 TS 进程内（`secretBox`/`sqliteAgentStore`）。

`docs/BACKEND-ARCHITECTURE.md` 的目标态是独立信任域的 **M5 签名器服务**（`cmd/signer/`，拒绝优先 policy、按用户 nonce 单写、持钥）。本片是把签名核"落地进运行时"的**第一步**，遵循**零风险**原则：

- 站起一个**可运行、不持钥**的 Go digest 服务（`cmd/signer`）。
- 在 TS `server/` 下单旁路加一个**默认关闭、fire-and-forget、吞异常**的影子校验：用 `@nktkas` 与 Go 核对同一 action 在**固定 nonce** 下的 L1 actionHash 是否逐字节一致，验证 Go 核在真实运行时对服务器产出的真实 action 参数编码一致。

**关键洞察**：`placer.ts` 构造 order tuple 后调 `client.order(...)`，nonce 由 `@nktkas` 内部生成，服务器在构造期看不到真实 nonce。故影子校验用**双方共享的固定 SHADOW_NONCE** 比对 actionHash——nonce 无关地验证编码（漂移高危区：msgpack 字段序、价量精度、asset-id、cloid）。

## 架构

### Go：`internal/hl` 复用重构 + `cmd/signer` 服务

1. **`internal/hl.ActionFromKind(kind string, params json.RawMessage) (Map, error)`（新，生产代码）**：把 `golden_test.go` 里 `actionForVector` 的 switch 抽成生产函数，覆盖现有全部 L1 kind（order/cancel/cancelByCloid/modify/updateLeverage/twapOrder/twapCancel/batchModify/updateIsolatedMargin/scheduleCancel）；未知 kind 或坏 JSON 返回 error。`golden_test.go` 的 `actionForVector` 改为调用它（DRY，去重）。
2. **`internal/hl.DigestL1(kind string, params json.RawMessage, nonce uint64, isTestnet bool) (actionHash, agentDigest [32]byte, err error)`（新）**：`ActionFromKind` → `L1ActionHash(action, nonce, nil, nil)` → `AgentDigest(hash, isTestnet)`。纯函数、可单测。
3. **`cmd/signer/main.go`（新）**：`net/http` 服务，监听 `SIGNER_ADDR`（env，默认 `127.0.0.1:8087`）。
   - `GET /healthz` → `200 {"status":"ok"}`。
   - `POST /v1/digest/l1`：请求体 `{ "kind": string, "params": <object>, "nonce": <uint>, "isTestnet": <bool> }`；调 `DigestL1`，成功→`200 {"actionHash":"0x…","agentDigest":"0x…"}`；`ActionFromKind` 错误→`400 {"error":"…"}`；坏 JSON→`400`。**不持钥、不签名、不落盘**。

服务不引入新依赖（仅标准库 `net/http`/`encoding/json`）。

### TS：`server/` 影子校验模块 + placer 接线

4. **`server/src/agent/signerShadow.ts`（新）**：
   ```
   makeShadowVerifier(opts: { url: string; nonce?: number; fetchImpl?: typeof fetch; logger?: Logger })
     => (kind: string, params: unknown) => void   // fire-and-forget
   ```
   - 内部：用 `createL1ActionHash`（`@nktkas/hyperliquid/signing`）以固定 `nonce`（默认常量 `SHADOW_NONCE = 1`）对 `actionFromKindParams(kind, params)` 重建的 action 算 `localHash`；同参同 nonce POST `${url}/v1/digest/l1`，读 `actionHash`；不区分大小写比对。
   - 不一致 → `logger.warn({kind, localHash, remoteHash}, "signer shadow mismatch")` + 计数；匹配 → `logger.debug`（或计数）。**任何异常（网络、超时、解析）一律 catch 并吞掉，绝不抛给调用方，绝不影响下单。**
   - 仅覆盖本片需要的 `order` kind 的 params 映射（`{asset,isBuy,px,sz,reduceOnly,tif,grouping,cloid}`）；未知 kind 的映射直接 no-op（不报错）。
5. **`server/src/agent/placer.ts`**：`PlacerDeps` 增加**可选** `shadowVerify?: (kind: string, params: unknown) => void`；在构造 `order` 之后、`await client.order(...)` 之前（或之后均可，须在真实调用之外）调用 `deps.shadowVerify?.("order", { asset: assetIndex, isBuy: buy, px: order.p, sz: order.s, reduceOnly: order.r, tif: "Ioc", grouping: "na", cloid: order.c })`。**同步调用但 shadowVerify 自身 fire-and-forget**；不 await、不影响 `place` 返回。
6. **`server/src/index.ts`**：读 `process.env.SIGNER_SHADOW_URL`；仅当非空时 `shadowVerify = makeShadowVerifier({ url, logger })` 并传入 `makeHlPlacer({...})`；未配置 → 不传（`undefined`）→ 零开销零风险。

## 数据流

```
placer 构造 order tuple ──▶ 真实 client.order(...)（不变，签名/下单照旧）
                        └─▶ deps.shadowVerify?.("order", params)   // 可选、旁路
                               │ 本地 createL1ActionHash(action, SHADOW_NONCE) = localHash
                               │ POST Go /v1/digest/l1 {kind,params,nonce:SHADOW_NONCE,isTestnet} → remoteHash
                               └─ localHash === remoteHash ? debug : warn+metric   // 吞所有异常
```

## 测试

- **Go**：
  - `ActionFromKind`：未知 kind → error；一个 happy path（order）返回预期 Map；坏 JSON → error。既有 golden 测试（现改用 ActionFromKind）保持全绿。
  - `DigestL1`：对某条已知 golden 向量的 `params/nonce/isTestnet` 返回的 actionHash/agentDigest 与该向量逐字节相等。
  - `cmd/signer` handler（`httptest`）：`/healthz`→200；`/v1/digest/l1` happy→200 且 actionHash 与 `DigestL1` 一致；坏 kind→400；坏 JSON→400。
- **TS**：
  - `signerShadow.test.ts`（mock `fetchImpl`）：匹配→无 warn；不匹配→warn+计数；fetch reject / 非 200 / 坏 body → 吞掉不抛。
  - `placer.test.ts`：注入 `shadowVerify` spy → place 时被调用一次且入参正确；`shadowVerify` 抛错时 `place` 结果不受影响；不注入时不触发。

## 验证门槛

- Go：`cd backend && go test ./... && go vet ./...` 全绿；`go build ./cmd/signer` 成功；`cmd/signer` 本地起服 + `curl /healthz` 200 + `curl /v1/digest/l1` 返回 hash。
- Server：`cd server && npm run typecheck && npm test` 全绿（≥ 既有基线）。

## 范围外（YAGNI，后续子项目）

- 真正产出**签名**（需持钥；档②KMS）。
- `internal/policy` 拒绝优先引擎、`internal/nonce` 租约单写者。
- user-signed 影子、mTLS、把签名从 TS 迁到 Go（replace 模式）、key 托管迁移。
- 除 `order` 外其它 kind 的 TS 影子映射（Go 服务已支持全部 kind，TS 侧按需扩展）。
