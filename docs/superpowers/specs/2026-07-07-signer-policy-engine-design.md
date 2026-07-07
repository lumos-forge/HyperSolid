# M5 签名器：`internal/policy` 拒绝优先策略引擎（纯评估器，不接入）

日期：2026-07-07
状态：已批准，待实现

## 背景

`docs/BACKEND-ARCHITECTURE.md §5.1a`：签名器最终须是**拒绝优先策略引擎**——护栏绑进签名边界内、按用户隔离，"不接受裸 payload 签名"。当前护栏（`server/src/risk/guards.ts` 的 `withinCaps`：kill-switch + 单笔 notional 封顶，per-coin 覆盖 global；另有有状态每日封顶由 scheduler 强制）都在 TS scheduler 里、**上游于**签名。PR #21 已让 Go 侧能签名（`cmd/signer` `/v1/sign/l1`，keystore-backed），但**没有 policy 层**——包注释与 spec 已注明：生产 cutover 前必须先由拒绝优先 policy 层包裹。

本片是这层的**第一步**：一个自包含、纯函数、reject-first 的策略评估器 `internal/policy`。**不接入 `/v1/sign/l1`**（接线是后续子项目，需签名端点从 action 权威计算 intent 上下文并携带每用户 policy）。

## 架构

单个纯 Go 包 `backend/internal/policy`：无状态、无副作用、无外部依赖。**default-deny**：只有"未 kill + kind 在白名单 + 名义额在封顶内"的 intent 才放行。镜像并强化 TS `withinCaps`（新增 reject-first 的 kind 白名单）。

### 类型（`backend/internal/policy/policy.go`）

```go
package policy

// Intent is the semantic view of a signing request that the policy evaluates.
// The wiring layer (future signer integration) MUST populate these fields
// authoritatively from the action + context — the policy trusts them as given.
type Intent struct {
	Kind         string  // "order" / "cancel" / "cancelByCloid" / "scheduleCancel" / …
	Coin         string  // symbol for per-coin caps; "" when not applicable
	NotionalUsdc float64 // order notional (px*sz); 0 for non-notional kinds
}

// Config is the per-user policy bound at the signing boundary.
type Config struct {
	AllowedKinds    map[string]bool    // reject-first allowlist; a kind absent/false is denied
	KillSwitch      bool               // when true, every intent is rejected
	MaxNotionalUsdc float64            // global per-order notional cap
	PerCoinMaxUsdc  map[string]float64 // optional tighter per-coin cap (overrides global)
}

// Decision is the policy verdict. Allow is false unless every rule passes.
type Decision struct {
	Allow  bool
	Reason string // set when Allow is false
}
```

### 评估（同文件）

```go
func deny(reason string) Decision { return Decision{Allow: false, Reason: reason} }

// Evaluate applies the reject-first policy: default-deny, allowing only a
// recognized, non-killed, within-cap intent. Rule order is deterministic so the
// returned reason is stable.
func Evaluate(intent Intent, cfg Config) Decision {
	if cfg.KillSwitch {
		return deny("kill-switch active")
	}
	if !cfg.AllowedKinds[intent.Kind] {
		return deny("kind not allowed")
	}
	if intent.NotionalUsdc > 0 {
		limit := cfg.MaxNotionalUsdc
		if c, ok := cfg.PerCoinMaxUsdc[intent.Coin]; ok {
			limit = c
		}
		if intent.NotionalUsdc > limit {
			return deny("over notional cap")
		}
	}
	return Decision{Allow: true}
}
```

## 关键性质

- **零值 `Config` 拒绝一切**：`AllowedKinds` 为 nil → 任何 kind 读出 false → deny（最安全默认）。
- **名义封顶 fail-closed**：`MaxNotionalUsdc = 0` 且 `NotionalUsdc > 0`（无 per-coin）→ `limit = 0` → 超封顶 deny。
- **非名义类 kind**（`NotionalUsdc == 0`，如 cancel/cancelByCloid/scheduleCancel）→ 跳过封顶（`0 > limit` 恒 false）。
- **per-coin 覆盖 global**：`PerCoinMaxUsdc[coin]` 存在即用它（即便比 global 更松/更严）；显式 `0` = 封禁该币的名义单。
- **规则优先序确定**：kill-switch > kind 白名单 > 名义封顶；reason 稳定可断言。
- policy 只评估传入的 `Intent`；wiring 层须从 action 权威计算 `Kind/Coin/NotionalUsdc`（本片注明，留待接线）。

## 测试（`backend/internal/policy/policy_test.go`，table-driven）

覆盖：
1. `KillSwitch=true` → 无论 kind/notional 一律 deny "kill-switch active"（含 kind 在白名单的情形，验证优先序）。
2. 零值 `Config`（nil AllowedKinds）+ 任意 kind → deny "kind not allowed"（默认拒）。
3. kind 不在白名单 → deny "kind not allowed"。
4. 允许 kind + `NotionalUsdc` ≤ `MaxNotionalUsdc` → allow。
5. 允许 kind + `NotionalUsdc` > `MaxNotionalUsdc`（无 per-coin）→ deny "over notional cap"。
6. per-coin 更严：notional 介于 per-coin 与 global 之间 → deny（per-coin 生效）；notional ≤ per-coin → allow。
7. per-coin 显式 `0` + notional > 0 → deny（封该币）。
8. 非名义类 kind（`NotionalUsdc = 0`）+ 允许 kind → allow（跳过封顶，即便 MaxNotionalUsdc=0）。
9. 名义额恰等于封顶（`NotionalUsdc == MaxNotionalUsdc`）→ allow（`>` 严格，边界包含）。

## 验证门槛

- `cd backend && go test ./internal/policy/ && go vet ./internal/policy/` 全绿。
- `cd backend && go test ./...` 全绿（新包不影响既有）。

## 范围外（YAGNI，后续子项目）

- 有状态**每日** notional 封顶（需 spend 存储 / nonce 单写者协调）。
- **reduce-only-only** 安全模式、其它 per-kind 规则。
- 每用户 policy **store**（user → Config 映射 + 加载）。
- 接入 `cmd/signer` `/v1/sign/l1`（policy 门控签名；需端点携带 intent 上下文 + 每用户 policy，wiring 时端点须从 action 权威计算 notional/coin）。
