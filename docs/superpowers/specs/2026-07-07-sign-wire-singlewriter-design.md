# 接线 /v1/sign/l1 → singlewriter.Authorize + Fencer 设计

> M6 单写者「接线 /v1/sign/l1」的**第 2 部分（端点接线）**。承接单写者核（PR #28/#29）、租约（PR #30）、leader 心跳（PR #31）。把签名端点从进程内的 `nonce.Allocator`+`policy.SpendTracker` 切换到统一的 `singlewriter.Writer.Authorize`（fence+每日额度+nonce 原子），并引入 `Fencer` 领导权闸门。

## 背景与目标

当前 `handleSignL1` 管线：`Signer(404) → Evaluate(403) → ActionFromKind(400) → spend.Charge(403 daily) → nonces.Next → sign(200)`。其中 `spend.Charge`（每日额度）与 `nonces.Next`（nonce 高水位）是**两个独立的进程内组件**。M6 已提供把三者合一的 `singlewriter.Writer.Authorize`（fence + 每日额度 + nonce 原子）。

本切片：用 `writer.Authorize` **替换** `spend.Charge`+`nonces.Next`，并在其前加一道**领导权闸门**（非 leader → 503）。fence 由 `Fencer` 提供（本片 `main()` 用静态 always-leader；真正接入 `leader.Leader` + Postgres 是 part 3）。`Evaluate`（allowlist / kill-switch / 每单名义额上限 / 拒绝 NaN·负额度）**保持不变**在 Authorize 之前。

## 范围（本切片）

- 端点重写：`handleSignL1`/`newMux`/`main` 用 `singlewriter.Writer` + `Fencer` + 注入时钟，替换 `nonce`+`spend`。
- `main()` 单实例内存默认：`singlewriter.NewMem()` + 静态 always-leader `Fencer`。
- 全量测试适配 + 新增领导权/fence 用例。

**非目标（part 3）**：把 `leader.Leader`（over `lease/pg` 或 `lease.Mem`）接入 `main()`、env-gated `DATABASE_URL` → `pgxpool` + `singlewriter/pg.PgWriter` + `lease/pg` + `EnsureSchema` + 启动恢复 + 优雅关停。`main()` 无法单测，这些基础设施 glue 单独成片评审更稳。

## 自主设计决策（记录备查）

- **`Fencer` 接口**定义在 `cmd/signer`（消费方）：`Fence() (epoch uint64, isLeader bool)`。`leader.Leader.Fence()` 结构上满足它（part 3 直接注入）；本片 `main()` 用 `staticFencer{epoch:1}`（恒为 leader）。
- **注入时钟** `nowMs func() int64`：`handleSignL1` 用它填 `singlewriter.Request.NowMs`（Authorize 据此算 nonce 与 UTC 日分桶）。默认 `time.Now().UnixMilli()`；golden/单调 nonce 测试注入固定时钟以保证确定性与字节级黄金向量。
- **保留 `Evaluate`**：每单名义额上限、allowlist、kill-switch、NaN/负额度拒绝仍在 Authorize 之前；Authorize 只管 fence + 每日额度 + nonce。二者不重叠。
- **HTTP 映射**：`ErrFenced`→409 `"fenced"`；`ErrDailyCap`→403 `"daily cap exceeded"`；`ErrInvalidNotional`→403 `"invalid notional"`（防御性，Evaluate 已先拦）；`ErrInvalidClock`→500；其它（PgWriter 基础设施错误）→500 `"authorize failed"`；非 leader→503 `"not leader"`。

## 新管线（handleSignL1）

```
POST /v1/sign/l1
  method != POST            → 405
  decode                    → 400
  ks.Signer(keyId)          → 404 unknown keyId
  intent = intentFor(kind, params); cfg = policies.Get(keyId)
  Evaluate(intent, cfg)     → 403 (kind not allowed / kill-switch / over notional cap / invalid notional)
  ActionFromKind(kind,params) → 400
  fence, isLeader := fencer.Fence()
  !isLeader                 → 503 "not leader"
  grant, err := writer.Authorize(ctx, Request{
      KeyID: keyId, Fence: fence, Notional: intent.NotionalUsdc,
      DailyCap: cfg.DailyMaxNotionalUsdc, NowMs: nowMs()})
      ErrFenced            → 409 "fenced"
      ErrDailyCap          → 403 "daily cap exceeded"
      ErrInvalidNotional   → 403 "invalid notional"
      ErrInvalidClock      → 500 "invalid clock"
      other (infra)        → 500 "authorize failed"
  signer.SignL1Action(action, grant.Nonce, isTestnet) → 500 on error
  200 {r,s,v, nonce: grant.Nonce}
```

`Authorize` 在 `ActionFromKind` 之后、被拒（fence/额度）不消耗 nonce（`singlewriter.Decide` 保证）。领导权检查在 Authorize 之前——非 leader 不触碰单写者。

## 签名变更

```go
type Fencer interface { Fence() (epoch uint64, isLeader bool) }

func handleSignL1(ks *keystore.Keystore, policies *policy.Store, writer singlewriter.Writer, fencer Fencer, nowMs func() int64) http.HandlerFunc
func newMux(ks *keystore.Keystore, policies *policy.Store, writer singlewriter.Writer, fencer Fencer, nowMs func() int64) http.Handler
```

`main()`：`writer := singlewriter.NewMem()`；`fencer := staticFencer{epoch: 1}`（`Fence()` 恒返回 `(1, true)`）；`nowMs := func() int64 { return time.Now().UnixMilli() }`。移除 `nonce`/`policy.SpendTracker` 的使用与 `nonce` import。

## 测试

- **既有 15 用例适配**：新增测试助手 `leaderMux(ks, policies, nowMs)` = `newMux(ks, policies, singlewriter.NewMem(), constFencer{1,true}, nowMs)`；把各处 `newMux(ks, policies, nonce.New(nil), policy.NewSpendTracker(nil))` 换成 `leaderMux(ks, policies, nil)`；golden 用 `nowMs=func(){return int64(v.Nonce)}`（保黄金向量字节级）、单调 nonce 与每日额度用 `nowMs=func(){return 1700000000000}`。行为保持：Evaluate 相关的 403/400/404 不变；每日额度经 Authorize 仍 403 "daily cap exceeded"；nonce 经 Authorize 仍严格递增。
- **新增**：
  - `TestSignL1NonLeader503`：`constFencer{1,false}` → 合法 order → 503 "not leader"。
  - `TestSignL1FencedConflict`：预先 `writer.Authorize(Fence:5)` 把该 key 的 fence 抬到 5，端点用 `constFencer{1,true}`（被废黜的旧 leader）→ 409 "fenced"。

## 验证门

- `cd backend && go test ./... && go vet ./... && go build ./...` 全绿（纯 Go、无 Docker）。
- golden 向量 `TestSignL1Endpoint` 字节级不变。
- `go build ./cmd/signer && rm -f signer` 成功。
- `git diff --stat main...HEAD` 仅改 `cmd/signer/{main.go,main_test.go}` + 两份 docs。不改 `singlewriter`/`lease`/`leader`/`policy`/`nonce`。

## 备注

- 本片把端点接到统一单写者 + 建立 `Fencer` 接缝；`main()` 仍单实例内存（行为等价于今日的进程内 nonce+额度，另加 fence 闸门）。part 3 注入 `leader.Leader`+Postgres 后，fence 即变为真实租约 epoch，实现端到端跨主机单写者。
- `nonce.Allocator` 与 `policy.SpendTracker` 包本身保留（未删除）——仅 `cmd/signer` 不再直接使用；shadow/其它用途不受影响。
