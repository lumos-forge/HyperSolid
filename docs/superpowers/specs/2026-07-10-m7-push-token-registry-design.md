# M7 推送 · P1 —— 设备推送令牌注册表（server/ TS）

- 日期：2026-07-10
- 里程碑：M7 推送服务（子项目 P1，共 P1–P4）
- 语言：TypeScript（`server/`，Fastify + better-sqlite3）
- 状态：设计已批准，待实现

## 1. 背景与 M7 分解

M7 推送为「自动成交 / 触发 / 熔断(kill-switch) / 授权健康」等 agentic 事件向用户设备发通知。M7 是多子系统，拆为独立的 spec→plan→PR：

- **P1（本文）设备令牌注册表**：mobile 上报的 Expo push token 在 server 端持久化，authed，owner 取自会话。**基础，其余都依赖它**。
- **P2 通知核心 + Expo 传输**：`notify(owner, notification)` —— 查令牌、经 `expo-server-sdk` 批量发送、处理回执、剪枝无效令牌、重试。依赖 P1。
- **P3 mobile 端注册**：`expo-notifications` 申请权限 + 取 Expo push token + 登录/变更时调用注册端点 + 设置开关。依赖 P1。
- **P4 事件接线 + 偏好**：引擎事件源接到 `notify`；通知分类/免打扰偏好。依赖 P2/P3。

### 1.1 架构决策（对路线图的偏离，须记录）

`docs/BACKEND-ARCHITECTURE.md` 原将 M7 标注为 **Go（`backend/internal/pusher`）+ 原生 APNs/FCM**。本设计改为 **TypeScript（`server/`）+ Expo Push Service（EPS，`expo-server-sdk`）**，理由：

- App 是 Expo RN，EPS 是 Expo 官方推荐推送路径：一枚 Expo push token 由 EPS 统一转发 APNs/FCM，免自管证书/密钥轮换/双端 payload 差异；EPS 为 production-grade（非临时捷径）。
- 全部通知事件源已在 `server/`(TS) 的 agentic 引擎（`userFillsReader`/`deadMan`/`restingExecutor`/agent 健康）。同位可去掉跨语言 HTTP 跳与一个新服务。
- 与现有 `server/` 栈（Fastify、better-sqlite3、钱包签名会话鉴权）一致。
- ADR-013（后端 Go）与「agentic 引擎为 TS」本就并存；M7 归 TS 引擎侧不违背该 polyglot 边界。

（实现落地时，`docs/BACKEND-ARCHITECTURE.md` 的 M7 行需同步注明此偏离。）

## 2. P1 范围与非目标

**在范围内**

- `PushTokenStore` 接口 + `SqlitePushTokenStore`（better-sqlite3）持久化令牌注册表。
- 两条 authed HTTP 路由：`POST /push/register`、`POST /push/unregister`。
- Expo push token 格式校验（fail-closed）。
- owner 取自验证过的 bearer 会话；令牌以 token 为主键 upsert，重注册**重绑到当前 owner**。
- 供 P2 使用的读取（`tokensForOwner`）与剪枝（`deleteToken`）方法。

**非目标（明确排除，属后续子项目）**

- 不发送任何推送、不引入 `expo-server-sdk`（P2）。
- 不改 mobile（`expo-notifications`、权限、注册调用属 P3）。
- 不接引擎事件源（P4）。
- 不做通知分类/免打扰偏好（P4）。
- 不做多设备去重之外的偏好或分组逻辑。

## 3. 数据模型

`SqlitePushTokenStore`（仿 `server/src/strategies/sqliteStore.ts`：`better-sqlite3`、`journal_mode=WAL`、`migrate()` 幂等建表）。

表 `push_tokens`：

| 列 | 类型 | 说明 |
|---|---|---|
| `token` | TEXT PRIMARY KEY | Expo push token（如 `ExponentPushToken[xxx]`） |
| `owner` | TEXT NOT NULL | 归属地址，**小写化**（对齐 `auth/token.ts`） |
| `platform` | TEXT | `"ios"` / `"android"`（来自请求；仅诊断/未来 payload 调优，可空） |
| `created_at` | INTEGER NOT NULL | 首次注册毫秒时间戳 |
| `updated_at` | INTEGER NOT NULL | 最近注册/重绑毫秒时间戳 |

索引：`CREATE INDEX IF NOT EXISTS push_tokens_owner ON push_tokens(owner)`（供 `tokensForOwner` 与 P2 批量发送）。

## 4. Store 接口

```ts
// server/src/push/pushTokenStore.ts
export interface PushTokenRow {
  token: string;
  owner: string;
  platform: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PushTokenStore {
  // Upsert by token. On conflict, rebind owner + refresh platform/updatedAt so a
  // device that switched wallet stops belonging to the previous owner.
  register(owner: string, token: string, platform: string | null, now: number): void;
  // Delete only if the token belongs to owner (can't remove someone else's).
  // Returns true when a row was deleted.
  unregister(owner: string, token: string): boolean;
  // All tokens currently bound to owner (for P2 fan-out).
  tokensForOwner(owner: string): PushTokenRow[];
  // Unconditional delete by token (for P2 invalid-token pruning on receipts).
  deleteToken(token: string): void;
}
```

`SqlitePushTokenStore implements PushTokenStore`，`static open(path, now?)`；owner 在所有方法内小写化（`owner.toLowerCase()`）以保证大小写无关，和会话 token 的 `sub` 已小写一致。

### 4.1 register 语义（upsert 重绑）

```sql
INSERT INTO push_tokens (token, owner, platform, created_at, updated_at)
VALUES (@token, @owner, @platform, @now, @now)
ON CONFLICT(token) DO UPDATE SET
  owner = excluded.owner,
  platform = excluded.platform,
  updated_at = excluded.updated_at;
```

`created_at` 在冲突时保持首次值（不出现在 UPDATE SET 中）。

## 5. HTTP 路由（`server/src/http/app.ts`）

复用现有 `ownerOf(req, reply)` helper（bearer→`auth.verify`→owner；失败发 401）。owner **只来自会话**，绝不取自 body。`pushTokens` 作为可选 `AppDeps` 依赖（对齐 `activity?` 的可选注入）；未配置时相关路由返回 503。

### 5.1 `POST /push/register`

- body：`{ token: string; platform?: "ios" | "android" }`。
- 流程：`ownerOf` → 校验 `token` 为合法 Expo push token（正则 `^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$`，不匹配 → 400 `{error:"invalid push token"}`）→ `pushTokens.register(owner, token, platform ?? null, now())` → `reply.code(204)`。
- `platform` 非 `"ios"|"android"` 时存 `null`（宽松，不 400；仅诊断字段）。

### 5.2 `POST /push/unregister`

- body：`{ token: string }`。
- 流程：`ownerOf` → `pushTokens.unregister(owner, token)` → `reply.code(204)`（幂等：删 0 行也 204；只能删自己的）。

### 5.3 鉴权/错误

| 情形 | 响应 |
|---|---|
| 无/失效 bearer | 401 `{error:"unauthorized"}`（`ownerOf`） |
| 非法 Expo token（register） | 400 `{error:"invalid push token"}` |
| `pushTokens` 未配置 | 503 `{error:"push not configured"}` |
| 正常 register/unregister | 204 无 body |

## 6. 依赖注入与装配

- `AppDeps` 增加可选 `pushTokens?: PushTokenStore`。
- 生产装配（`server/src/index.ts`）：`SqlitePushTokenStore.open(dbPath)` 注入，复用现有 `dbPath`（`process.env.DB_PATH ?? "strategies.db"`，与 agents/strategies/activity 同一 sqlite 文件——遵循现有约定）。
- 未注入时路由 503——保证既有测试/装配不因新依赖而破。

## 7. 测试计划（对齐 `sqliteStore.test.ts` + `app.test.ts`）

**Store（`pushTokenStore.test.ts`，`:memory:`）**
1. `register` 首次插入：`tokensForOwner` 返回该行，`created_at==updated_at`。
2. `register` 同 token 换 owner：归属变为新 owner、旧 owner `tokensForOwner` 不再含它、`created_at` 不变、`updated_at` 前进。
3. 一个 owner 多 token：`tokensForOwner` 返回全部。
4. `unregister(owner, token)` 删自己的返回 true；`unregister(otherOwner, token)` 返回 false 且不删。
5. `deleteToken` 无条件删除。
6. owner 大小写无关（`0xAbc…` 与 `0xabc…` 视为同一 owner）。

**路由（`app.test.ts` 追加，用真实 `Auth` + `:memory:` store）**
7. `POST /push/register` 无 bearer → 401。
8. 合法 bearer + 合法 token → 204，且 store 中该 owner 持有该 token。
9. 非法 token 格式 → 400，未入库。
10. owner A 无法 `unregister` owner B 的 token（用各自会话；A 删 B 的 token 返回 204 但 B 仍持有）。
11. 同一 token 由 owner B 重注册后，`tokensForOwner(A)` 不再含它、`tokensForOwner(B)` 含它（端到端重绑）。
12. `pushTokens` 未注入时 register/unregister → 503。

## 8. 验证命令

```bash
cd server && npm run typecheck && npx jest src/push/pushTokenStore.test.ts src/http/app.test.ts
```

（`npm run typecheck` = `tsc --noEmit`；`npm test` = `jest`。）

## 9. 与现有代码的关系

- Store 形态对齐 `server/src/strategies/{store.ts 接口, sqliteStore.ts 实现}`（interface + Sqlite 实现 + `migrate` 幂等 + WAL + owner 大小写无关）。
- 路由/鉴权对齐 `server/src/http/app.ts`（`ownerOf` helper、204 无 body、可选依赖注入如 `activity?`）。
- owner 小写化对齐 `server/src/auth/token.ts`（`sub` 已小写）。

## 10. 后续（P2–P4，本次不做）

- P2：`expo-server-sdk` 批量发送 + 回执处理 + 用 `deleteToken` 剪枝 `DeviceNotRegistered`；`notify(owner, notification)`。
- P3：mobile `expo-notifications` 权限 + 取 token + 登录/变更注册 + 设置开关。
- P4：引擎事件源接线（自动成交/kill-switch/触发/授权健康）+ 通知分类/免打扰偏好。
