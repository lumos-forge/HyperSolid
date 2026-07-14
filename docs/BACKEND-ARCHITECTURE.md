# HyperSolid 后端架构（Go · 评审稿）

> **状态**：评审稿（draft）。后端语言 = **Go**（ADR-013）。本文把 spec《2026-06-17-hypersolid-design.md》的后端职责拆成可落地的模块边界 + polyglot 决策 + 签名核分档。
> **权威来源**：架构/安全/agentic 决策仍以 spec 为单一事实来源；本文是其后端落地视图，不引入新产品决策。
> **红线（不可违背）**：用户主资金私钥永不离设备；后端绝不托管主钱包私钥；提现只能主钱包签；Postgres 绝不存私钥。（spec §22 红线 / §5.1a / §5.4）

---

## 1. 设计原则（继承自 spec）

1. **后端不在手动下单关键路径上**（spec §4.1）：设备始终能"本地签名 → 直发 HL `/exchange`"；后端只做数据加速 / 推送 / agentic 执行；后端降级时 App 自动回退直连 HL。→ **后端整挂，核心交易仍可用**。
2. **唯一安全攸关面是签名器**（spec §5.1a）：trade-only 被攻破仍可经恶意成交耗尽账户价值，故签名器必须是**拒绝优先策略引擎**，policy 绑进签名边界、按用户隔离。
3. **私有数据扇出不可规模化集中**（spec §4.8）：HL 限 ≤10 唯一用户/IP；公共行情集中订阅+扇出，用户私有数据默认客户端直连，仅离线 agentic 用户由后端分片订阅。
4. **agentic 是后端关键路径**（spec §6.2）：需持久意图账本（cloid 先于签名）+ 租约 fencing 单写 nonce + leader 选举 + 背压 + SLO。
5. **默认单语言（Go）主体**，仅在两处例外引入第二语言，且每处有明确触发条件（见 §4）。

---

## 2. 模块清单

> 「持钥」=是否在进程内持有 agent 私钥材料；「爆炸半径」=该模块被攻陷 / 故障的最坏后果。

| # | 模块 | 职责（spec 出处） | 持钥 | 爆炸半径 | 语言 |
|---|------|------|:---:|------|------|
| **M1** | API Gateway / BFF | 客户端入口、鉴权、聚合、限流、配置下发 | 否 | 数据泄露 / DoS | **Go** |
| **M2** | 公共行情 Connector 池 + 扇出 | 集中订阅 allMids/fastAssetCtxs/l2Book/trades/candle → NATS/Redis 扇出 + 快照缓存（§4.8）| 否 | 行情延迟（客户端可降级直连）| **Go** |
| **M3** | 私有数据分片订阅器 | 仅为离线 agentic 用户按「≤10 用户/IP」分片订阅私有流 + 准入控制 + 超限回退轮询（§4.8）| 否 | 离线策略数据滞后 | **Go** |
| **M4** | Agentic 执行引擎 | L1 规则（TP/SL、移动止损【落地：`kind:"trailing"`，params `{coin,trailPct}`，持久化 `trailPeak` water-mark，回撤 trailPct% 触发 reduce-only 平仓，mobile 建仓 UI 落地（AgentScreen trailing 模板 + coin/trailPct 表单 + `createTrailing`）】、DCA、网格、条件单【落地：`kind:"conditional"`，params `{coin,side,sizeUsdc,triggerPrice,triggerDirection}`，mark 越过触发价市价开仓（经风控 caps、一次性完成），mobile 建仓 UI 落地（AgentScreen conditional 模板 + coin/side/size/触发价/方向 表单 + `createConditional`）】/定时单【落地：`kind:"scheduled"`，params `{coin,side,sizeUsdc,runAt}`，`now>=runAt` 市价开仓（经风控 caps、稳定 cloid、一次性完成），mobile 建仓 UI 落地（AgentScreen scheduled 模板 + coin/side/size/延时小时→runAt 表单 + `createScheduled`）】）、护栏网关、kill-switch、scheduleCancel 心跳、策略健康（§6.x）**【签名器托管切换：代码侧落地 —— 引擎→签名器 provisioning + 签名委托（sign-then-submit）全部落地，位于 `SIGNER_DELEGATION` flag 后（默认 OFF，零行为变更）：设计基线 #102；签名器持久化加密 keystore #103 + provisioning 端点（`POST/DELETE /v1/keys`）#104；server 端 `SignerClient`（`/v1/keys`·`/v1/sign/l1`·`/v1/reconcile`，`SignerError.retryable`）#105；provisioning 委托（`AgentManager` 双托管 privateKey|keyId + 异步 `provision` 走 `signer.createKey`，SQLite 加 `key_id` 迁移，绑 reject-first caps）#106；签名器托管交易客户端（`makeSignerBackedExchangeClient`：canonical L1 action `l1Action.ts` → `signer.sign` → HL `/exchange` 提交 → `reconcile`，keyId 记录经 `makeClientFor` 路由，本地 privateKey 记录不变）#107。**运维待做**：ops 在 testnet 端到端验证（provision→approve→下单→shadow 匹配→reconcile 推进）后单独 PR 翻转默认为 ON；Phase 4 清理（移除本地 keygen + `enc_private_key` 列）待翻转后做。详见 `docs/SIGNER-DELEGATION-ROLLOUT.md`】** | 否（调用 M5）| 策略误触发（受 M5 policy 边界兜底）| **Go**（Temporal）|
| **M5** | **签名器（拒绝优先策略引擎）** | 持 agent key、policy 绑定签名边界、msgpack+EIP-712 签名、按用户隔离 nonce（§5.1a/§5.2）| **是（唯一）** | **资金被恶意成交耗尽（最高危）** | **Go → KMS/Enclave（见 §5）** |
| **M6** | 意图账本 / nonce 单写者 | cloid 先于签名持久化、租约 fencing 单写 nonce、按 cloid 对账状态机（§6.2）**【状态：端到端落地 —— 跨主机单写者 #28–#33（core/pg-writer/lease/leader/endpoint/main）+ cloid 幂等意图账本 #39 + 签名接线 #40 + 对账状态机+孤儿侦测 #41 + 对账端点 `/v1/reconcile`·`/v1/orphans` #42 + HL 回执源自动对账循环（leader-gated）#43–#44（`internal/{ledger,hlinfo,reconciler}`，`SIGNER_HL_INFO_URL`/`SIGNER_RECONCILE_ACCOUNTS` 起停）；多 AZ/指标 待做】** | 否 | 重复单 / 孤儿单 / nonce 冲突 | **Go**（Temporal + Postgres）|
| **M7** | 推送服务 | APNs/FCM；自动交易/触发/熔断、授权健康告警（§5.3/§6）**【状态：起步 —— 落 server/(TS) + Expo Push Service（非原生 APNs/FCM，Expo 官方路径、与事件源同位）；P1 设备令牌注册表落地：authed `/push/register`·`/push/unregister`，owner 取自钱包会话，Expo token 主键 upsert 重绑（`server/src/push/pushTokenStore.ts`）；P2 通知核心+Expo 传输落地：fail-safe `Notifier.notify(owner, notification)`（注入 Expo 客户端、批量 chunk 发送、即时 ticket DeviceNotRegistered 令牌剪枝、不外抛，`server/src/push/notifier.ts`）；P4 事件接线落地：成交经 `NotifyingActivityStore` 装饰器发通知、dead-man `onHealthEvent` alert/recovered 发通知，通知目录 `server/src/push/notifications.ts`；P3a mobile 注册管道落地：`StrategyApi.registerPush`/`unregisterPush` + fail-safe `registerDeviceForPush`（注入 PushEnv，`mobile/src/services/pushRegistration.ts`）；P3b 落地：通知设置 toggle（SettingsScreen）+ `pushPrefsStore`（持久化开关+token）+ `applyPushPreference`（建会话+注册/反注册，fail-safe）+ `expoPushEnv` 适配器 + 启动 hydrate + i18n —— **M7 端到端跑通**；P3c 登出反注册（`unregisterForSignOut`，登出时反注册设备 token + 清 pushPrefs，best-effort）落地；P5a-server 本地化推送落地：`push_tokens.locale` 列 + `/push/register` 记录 locale（en/zh 否则 null），通知目录改为按 `PushLocale` 本地化（`server/src/push/messages.ts` en/zh 文案），`Notifier.notify(owner, render)` 按每个 token 的 locale 渲染（同 locale 缓存、缺失→en 零回归，`server/src/push/notifier.ts`）；P5a-mobile 注册上报 locale 落地：`StrategyApi.registerPush(token, platform, locale)` + `PushEnv.locale` 快照 + `registerDeviceForPush` 透传 + `expoPushEnv()` 读 `useLocaleStore`（切语言后需重开推送才更新，YAGNI）；P5b-server 分类开关落地：`push_prefs(owner,category,enabled)` 偏好存储（缺省全开）+ `Notifier.notify(owner, category, render)` 按 owner 类别拦截（禁用→跳过、prefs 抛错 fail-open）+ `GET/POST /push/prefs` 路由，类别 fills/alerts；P5b-mobile 子开关 UI 落地：设置页推送开启时显示「成交通知/保护告警」两行（`StrategyApi.getPushPrefs/setPushPrefs` + fail-safe `pushCategoryPrefs` 服务 + 进入拉取/乐观写/失败回滚，服务器为唯一来源）；P5c-server 免打扰时段落地：`push_quiet_hours(owner,enabled,start,end,tz)` 存储 + tz 感知 `isWithinQuietHours`（Intl 计算 minute-of-day）+ `Notifier` 仅静音 fills（alerts 穿透、fail-open）+ `GET/POST /push/quiet-hours` 路由（P5c-mobile 时段 UI 落地：设置页推送开启时可开关免打扰并选整点开始/结束（`StrategyApi.getQuietHours/setQuietHours` + fail-safe `pushQuietHours` 服务 + `deviceTimeZone` + SheetSelect 整点选择器，乐观写/失败回滚，保存带设备 tz））、P2.5 延迟回执轮询落地：`push_receipts(receipt_id,token,created_at)` 存储 + `Notifier` 记录 ok ticket 的 receipt id + `pollPushReceipts` 每 15min 拉回执，仅 DeviceNotRegistered 剪枝 token（其余记日志），24h 超期清理、P4.5-server 策略完成推送落地：新增 lifecycle 类别（默认开）+ `strategyCompletedNotification` + `NotifyingStrategyStore` 装饰器（twap 末片/tpsl 触发→completed 跃迁发通知，fail-safe）+ 免打扰覆盖 fills/lifecycle（alerts 穿透）+ `/push/prefs` 含 lifecycle（P4.5-mobile 开关 UI 落地：设置页第三个类别开关「策略完成」（`PushCategoryPrefs.lifecycle` + `StrategyApi` get/set 含 lifecycle + SettingRow，复用乐观写/失败回滚））、P3c 启动再注册（YAGNI 暂缓）待做】** | 否 | 通知缺失 | **TS（server/，改自原 Go 规划）** |
| **M8** | 中国智能路由代理 | 20+ 出口 IP 池、流量分离、429 降级（§4.1 / `docs/CHINA-ACCESS-ANALYSIS.md`）**【状态：代码侧落地 —— 客户端智能路由 + Cloudflare Worker 本体全部落地（PR #93–#100）：路由偏好 store + 设置 UI（Auto/Direct/Proxy，`mobile/src/state/routingStore.ts`）#93；纯选路核心（一致性哈希 `pickProxy` + 流量分离：签名单/私有 WS 恒直连、读查询/公共行情可代理，`mobile/src/lib/routing/selectRoute.ts`）#94；网络环境探测（复用 server 下发 geo + 直连可达性探测 → `proxyRecommended`，仅中国探测，`services/routingEnv.ts`+`lib/routing/detectEnv.ts`）#95；HL HTTP 接线（server 下发 `proxyPool` + `resolveApiUrl` → 8 个 `/info` 工厂经 `HttpTransport.apiUrl` 走代理、`/exchange` 恒直连）#96；公共 WS 路由（`resolveWsUrl` → `WebSocketTransport.url`，allMids/l2Book/trades 可代理、twap 私有恒直连）#97；HTTP 自动降级（`proxyCooldown` 30s 冷却 + `routedBase` 降级 + `RoutingHttpTransport` 失败→冷却→直连重试一次，仅 429/网关5xx/网络超时触发、HL 业务错误不误伤）#98；Cloudflare Worker 本体（新 `workers/` 包，仅转发 `POST /info` + `/ws` upgrade、`/exchange` 及其他 404，mainnet/testnet 上游选择，+ 独立 CI job）#99；公共 WS 失败触发（`RoutingWsTransport` 订阅 failureSignal abort → 冷却代理）#100。空池时全部回退直连、安全无副作用。**运维待做**：Cloudflare 账号部署 20 实例池 + 回填服务端 `app-config.proxyPool`；client 发送 `X-Hl-Network` 头（YAGNI 暂缓）】** | 否 | 中国用户行情可达性下降 | **JS（Cloudflare Workers，保留）** |
| **M9** | 存储层 | Postgres（**绝不存私钥**）+ Redis 缓存（§3）| 否 | 数据泄露（无私钥）| Go 接入 |
| **M10** | 可观测 / 限频预算 | OTel 指标·追踪·日志、SLO、每用户速率预算 + 撤单合并 + 挂单上限 + scheduleCancel 计数（§6.3/§12）**【状态：核心落地 —— signer(Go)：HTTP Prometheus 指标+`/metrics` #48、reconciler 领域指标 #49、按 key 令牌桶限流 `/v1/sign/l1`（429，fail-closed）#50（`internal/{metrics,ratelimit}`，专用 registry）；agentic 引擎(server/ TS)：撤单合并+挂单上限 #51、scheduleCancel 死手开关（心跳+≤10/日预算）#52、死手失败过渡式告警 #53（`engine/deadMan`、`agent/{deadManExecutor,restingExecutor,openOrdersReader}`）。用 Prometheus（非 OTel）；OTel 边界追踪（signer：HTTP server span + HL /info client span + reconciler step span，OTLP 导出、opt-in fail-safe，`internal/tracing`）落地；signer 结构化日志（slog JSON + trace_id/span_id 关联 + 业务路由访问日志，`internal/logging`）落地；signer SLO（sign 可用 99.9%/延迟<500ms 99%/reconciler 99%，归一化燃烧率 recording + 多窗口多燃烧率告警 + promtool CI 验证，`backend/ops/slo`）落地；signer IP/地址级额度统管（per-user IP bucket + address daily cap）落地；WS 分片配额（`internal/wsshard`：离线 agentic 用户私有流按「≤N 唯一用户/IP」least-loaded 分配 + 幂等准入 + 显式释放 + 全满拒绝→回退轮询，fail-closed，纯记账供 M3 privatefeed 消费）#65 落地；signer 崩溃上报（sentry-go：opt-in fail-safe，panic 恢复中间件带 route+trace_id + BeforeSend 剔除 Request，`internal/obs`）#66 落地；OTLP 日志管道（待 OTel Logs 信号稳定）、临界统一降级并告警（signer 按预算维度 hypersolid_budget_denials_total{budget=key_rate|ip_rate|address_cap|key_daily_cap} 计数 + budget_saturation 多窗口告警 High/Critical，`ops/slo`）落地】** | 否 | 盲飞 / 触发 HL 限频 | **Go（signer）+ TS（server/ 引擎）** |
| **M11** | 入金引导 / Builder 返佣（后续）| approveBuilderFee、入金桥引导（与上架同期，§2 Phase 6）| 否 | — | **Go** |

**关键观察**：11 模块中仅 **M5 持钥且安全攸关**；M4/M6 是分布式正确性攸关；其余 8 个 I/O 密集且「最坏只丢数据/降级」，被非托管红线兜底。

---

## 3. 信任 / 进程隔离边界

```
                    ┌────────────────────────── 普通后端区（被攻陷≠丢资金）──────────────────────────┐
   客户端 ──TLS──▶  │  M1 BFF   M2 行情扇出   M3 私有分片   M7 推送   M9 存储   M10 可观测           │
        │           │     │          │            │                                                  │
        │           │     └──────────┴──── M4 Agentic 执行引擎（Temporal 编排）──┐                   │
        │           │                                  │ 仅传「已校验意图+cloid」 │                   │
        │           └──────────────────────────────────┼──────────────────────────┘                   │
        │                                               ▼  （mTLS，最小接口）                          │
        │                              ┌──────────── 签名边界（硬化，最小 TCB）─────────────┐          │
        │                              │  M5 签名器：policy 校验 ⇒ msgpack+EIP-712 签名     │          │
        │                              │  持 agent key（KMS/Enclave）· 按用户 nonce 单写    │          │
        │                              └───────────────────────────────────────────────────┘          │
        │  关键路径(不经后端): 本地签名 → HL /exchange         M8 中国代理(Cloudflare Workers, 边缘)    │
        ▼                                                                                              │
   Hyperliquid HyperCore  ◀──────────────────────────────────────────────────────────────────────────┘
```

- **M4 与 M5 必须跨进程/跨信任域**（spec §5.1a：护栏在签名边界**内**强制，而非上游"建议"）。M4 被攻陷也只能提交"意图"，越界意图被 M5 policy 拒绝。
- M5 暴露**最小接口**：`Sign(intent, userPolicyRef) -> {signed | rejected(reason)}`；不接受裸 payload 签名。

---

## 4. Polyglot 决策

**默认全 Go 主体**，仅两处例外：

| 模块 | 语言 | 触发条件 / 理由 |
|------|------|------|
| M1–M4, M6, M7, M9–M11 | **Go** | goroutine 契合 connector 池/WS 扇出；Temporal-Go 编排 M4/M6；NATS（Go 写）/Redis(go-redis)/Postgres(pgx) 一流；单语言主体 = 低运维复杂度 |
| **M8 中国代理** | **JS（Cloudflare Workers）** | 边缘转发与后端语言无关；Workers 免费多 IP 池是 spec 既定方案。**改 Go 的唯一触发**：将代理收回自管 VPS |
| **M5 签名核** | **Go（默认）→ 视保证等级升级（§5）** | 唯一真正值得 polyglot 纠结处 |

**避免的反模式**：① 为"安全感"整体上 Rust（放大逻辑 bug、丢 Go 生态与人才）；② 把 M8 改写 Go（丢 Workers 免费 IP 池红利）；③ M4 业务逻辑与 M5 签名核塞同进程（爆炸半径放大，违反 §5.1a）。

---

## 5. M5 签名核：三档方案（按安全保证递增）

| 档 | 方案 | 密钥位置 | 保证 | 适用阶段 |
|---|------|---------|------|---------|
| **①** | **Go in-process** | Go 堆（`defer` 清零 + `mlock`）| 基础；GC 不可靠擦除是已知短板 | MVP / testnet |
| **②** | **Go + KMS/HSM**（**推荐生产**）| **AWS KMS / HSM**（签 secp256k1 摘要）| 密钥**永不进进程**，语言短板消失；性价比最高 | 公开发布默认 |
| **③** | **Go/Rust in Nitro Enclave** | Enclave 内 | policy 校验 + 签名**同处边界**（满足 §5.1a），远程证明，最小 TCB | 合规/审计要求最高保证时 |

- **签名实现**：Hyperliquid **官方无 Go SDK**（仅 Python 官方；Rust/TS 社区，ADR-013）→ **自写最小 Go 签名核**：`go-ethereum` crypto（secp256k1 / keccak256 / EIP-712 apitypes）+ `vmihailenco/msgpack`。
  - 两套签名 domain 必须分别实现（spec §5.2）：L1 action（phantom-agent，domain `Exchange` / chainId 1337，**msgpack 字段顺序敏感**）；user-signed（domain `HyperliquidSignTransaction`，**`hyperliquidChain` 防主网/测试网重放**）。
- **正确性保险（必做）**：用客户端 `@nktkas/hyperliquid`(TS) 对同一订单产出 hash/签名作为**跨语言黄金测试向量**，Go 实现逐字节对拍；以官方 Python SDK / 社区 Rust SDK(`infinitefield/hypersdk`) 为权威参照（守住「精度/asset-id/cloid 三件套」零漂移）。
- **nonce**（spec §5.2/§5.3/§6.2）：ms 时间戳，窗口 (T-2d, T+1d)，每签名者保留最高 100、严格递增不复用；**按私钥而非账户**；每 agent key 配租约/fencing 单写者；每次授权生成全新 key，绝不复用过期/注销 key。

**M5 推荐落地路径**：档①（MVP/testnet 跑通黄金向量）→ 档②（公开发布默认，KMS）→ 仅在合规要求时升档③，enclave 核可用 **Rust** 写以求最小 TCB（这是唯一值得引入第二门系统语言之处）。

---

## 6. 横切关注点

- **HA / 幂等**（§6.2/§12）：M4/M6 用 **Temporal(Go)** 落地持久意图账本、定时单、scheduleCancel 心跳、重试幂等；无状态多 AZ + leader 选举 + 背压 + 熔断；手动交易降级直连 HL。
- **限频预算**（§4.7/§6.3）：M10 统一管理 IP 1200 weight/min、地址级额度、WS ≤10 用户/IP；每用户速率预算 + 撤单合并 + 挂单上限 + scheduleCancel 计数，临界进降级并告警。**【已落地：signer 按 key 令牌桶限流（#50，429 fail-closed，`internal/ratelimit`）；agentic 引擎撤单合并+挂单上限（#51）+ scheduleCancel 死手（心跳+≤10/日预算 #52 + 失败告警 #53）。signer IP/地址级额度统管（per-(OwnerAddress, RemoteAddr) 令牌桶 + per-OwnerAddress 日 notional 额度，叠加现有 per-key 预算，cloid replay 不重复扣）落地；WS 分片配额（`internal/wsshard`：离线 agentic 私有流按「≤N 唯一用户/IP」least-loaded 分配 + 准入 + 全满回退轮询信号，fail-closed，纯记账，M3 privatefeed 消费 #65）落地；临界统一降级并告警（signer 配额拒绝按预算计数 + Prometheus 多窗口饱和告警，reject-first 无状态、零签名行为变更，`internal/metrics`+`ops/slo`）落地】**
- **离线语义诚实**（§6.1）：scheduleCancel 只撤单不平仓 → 策略须预置 reduce-only 止损/止盈（驻留 HL 侧）+ 最大离线敞口 TTL + 显式风险揭示。
- **可观测**（§12）：OpenTelemetry-Go 指标/追踪/日志 + SLO；sentry-go 崩溃；签名意图全量留痕供审计。**【已落地：signer Prometheus 指标（HTTP #48 + reconciler 领域 #49）经专用 registry + `/metrics` 暴露；死手开关失败过渡式告警（#53）。OTel 边界追踪（HTTP/HL/reconciler step span，OTLP，opt-in fail-safe）落地；结构化日志（slog + trace 关联 + 访问日志）落地；SLO（3 个 + 多窗口多燃烧率告警 + promtool 验证，`backend/ops/slo`）落地；signer 崩溃上报（sentry-go：opt-in fail-safe，panic 恢复中间件带 route+trace_id + BeforeSend 剔除 Request，仅 panic，`internal/obs` #66）落地；OTLP 日志管道 待做】**
- **供应链安全**：M5 依赖面最小化；`go mod` 校验 + `govulncheck` + 固定版本；KMS/Vault 管密钥，绝不入库（仓库 `.gitignore` 仅为底线）。

---

## 7. 建议的 `backend/` 目录骨架（Go module）

```
backend/
├── go.mod
├── cmd/                      # 各可独立部署的服务入口
│   ├── gateway/             # M1
│   ├── marketfeed/          # M2 公共行情扇出
│   ├── privatefeed/         # M3 离线 agentic 私有分片
│   ├── agent/               # M4 Agentic 执行引擎（Temporal worker）
│   ├── signer/              # M5 签名器（独立信任域，最小依赖）
│   └── pusher/              # M7 推送
├── internal/
│   ├── hl/                  # HL action 编码 + EIP-712 签名（自写最小核）+ 黄金向量测试
│   ├── policy/              # 拒绝优先 policy 引擎（§5.1a）
│   ├── ledger/              # M6 意图账本 + cloid 对账
│   ├── nonce/              # 租约 fencing 单写者
│   ├── ratelimit/           # M10 限频预算（按 key 令牌桶 #50 ✅）
│   ├── wsshard/             # M10 私有 WS 分片配额（≤N 用户/IP 分配+准入，纯记账 #65 ✅）
│   ├── metrics/             # M10 Prometheus 指标（HTTP #48 + reconciler 领域 #49 ✅，专用 registry + /metrics）+ 配额拒绝 hypersolid_budget_denials_total{budget}
│   ├── store/               # M9 Postgres(pgx)/Redis
│   └── obs/                 # M10 sentry-go 崩溃/panic 上报（opt-in fail-safe，Setup+panic 中间件+Recover，scrub Request #66 ✅）
└── proto/ (或 openapi/)      # 客户端 TS ↔ 后端 Go 契约，生成双端类型
```

> M5 `signer/` **单独部署、单独信任域、最小依赖**；与 M4 `agent/` 跨进程（mTLS）。

---

## 8. 待决项（spec 仍未定，需后续 ADR / spike）

1. **M5 升档时机**：档② KMS 是否满足合规，还是直接上档③ enclave（§5.4 Turnkey/TEE/KMS 模型未定）。
2. **Go HL 签名核 testnet spike**：先验证 L1 + user-signed 两套 domain 的字节级正确性（ADR-013 先决）。
3. **私有分片容量测算**（§4.8）：IP 池规模 vs 离线 agentic 活跃用户数的准入与回退轮询阈值。
4. **客户端↔后端契约**：protobuf 还是 OpenAPI（替代原 Node/TS 的同源类型复用）。
