# API 参考

[English](#english)

本文列出集成与自动化常用的 HTTP 接口、认证方式、核心请求字段与错误码。

## 目录

- [认证与会话](#认证与会话)
- [初始化数据库契约](#初始化数据库契约)
- [公开接口](#公开接口)
- [展示与主题](#展示与主题)
- [监控与 Push](#监控与-push)
- [AI 渠道与模型](#ai-渠道与模型)
- [Worker Queue](#worker-queue)
- [Agent 管理](#agent-管理)
- [统一分组管理](#统一分组管理)
- [外部订阅](#外部订阅)
- [通知、设置与运维](#通知设置与运维)
- [错误码说明](#错误码说明)

## 认证与会话

管理接口支持已登录会话 Cookie 或 Bearer Token（Worker 为 `ADMIN_TOKEN`，Go 为 `POLARIS_ADMIN_TOKEN`）：

```http
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

Cookie 按域名隔离（跨展示域名访问 `/admin` 需分别登录）。监控 `id` 为管理用 UUID，`num_id` 为公开路径数字 ID；Push 与 Agent Token 为各对象独立凭据。

- `GET /api/auth/session`、`POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/auth/setup`（不开放公开注册）。
- **外部认证**（Go 与 Worker 均支持）：`/api/auth/session` 另返回 `authentication`（`local`、`bearer`、`trusted-header`、`cloudflare-access`、`null`）和 `externalAuth`（`{ mode }` 或 `null`）；`POST /api/auth/external` 在退出后重新验证上游凭据并恢复外部登录（禁用返回 `404`，无效凭据 `401`，跨源 `403`）；外部会话改本地密码返回 `403 external_account_managed`。`/setup` 完成前外部身份一律不生效，管理路由返回 `401`。详见[外部认证](external-auth.md)。

## 初始化数据库契约

`needsSetup: true` 时，`GET /api/auth/session` 返回 `setupDatabase`（永不暴露连接串）；Worker 另返回 `setupRequirements`（`{ key, required, ok }`：`database`、`config`、`adminToken`、`themes`、`analytics`、`analyticsSql`）。

| `setupDatabase` 字段 | 类型 | 含义 |
| --- | --- | --- |
| `types` | `("d1" \| "sqlite" \| "postgres")[]` | 当前后端可用数据库类型 |
| `defaultType` | `"d1" \| "sqlite" \| "postgres"` | 默认数据库类型 |
| `postgresConfigured` | `boolean` | 是否有可复用 PostgreSQL 连接 |
| `postgresUrlEditable` | `boolean` | 是否允许提交新 PostgreSQL URL（写账号后锁定） |
| `configurationId` | `string?` | KV 配置同步标识 |

初始化调用顺序：
1. **Worker 数据库配置** `POST /api/auth/setup/database`：提交 `{ credential, database: { type, url? } }`，返回 `{ ok: true, type, configurationId? }`（不建账号）。若返回 `configurationId`，需轮询 `/api/auth/session` 直到一致再进入下一步。
2. **创建管理员** `POST /api/auth/setup`：提交 `credential`、`username`、`password` 及可选 `database`（省略或留空 `url` 沿用已验证连接）。写账号开始后锁定数据库类型与 URL（租约最长 10 分钟），中断需用原账号密码续接。

初始化错误码：`400`（`invalid_database_type`、`invalid_database_url`）、`409`（`setup_in_progress`、`setup_complete`）、`503`（`deployment_incomplete`、`credential_unconfigured`、`database_connection_failed`、`database_initialization_failed`、`database_configuration_failed`）。

## 公开接口

匿名 `GET /api/capabilities` 返回 `runtime`、`probeSource`、支持的监控类型、间隔/超时边界与主题存储支持。

公开 GET 端点（机器页关闭时机器接口返回 `404`；维护状态 `no-store`，其余符合条件的 Worker 响应缓存 15 秒）：
- `/api/public/health`、`/api/public/status`、`/api/public/status/detail`、`/api/public/config`、`/api/public/maintenance`
- `/api/public/monitors`、`/api/public/monitors/:numId`、`/api/public/agent/detail/:numId`
- `/api/public/servers`、`/api/public/servers/:id`、`/api/public/theme`、`/api/public/icon`、`/api/public/monitor-icon?id=:numId`
- `/api/public/ai/models`、`/api/public/ai/models/:id`、`/api/public/subscriptions/items`、`/api/public/subscriptions/items/:id`

```sh
curl --fail-with-body 'https://status.example.com/api/public/status'
```

- 心跳状态：`0` DOWN、`1` UP、`2` WARN、`4` PENDING（无延迟 `ping: null`）。`monitorGroups` 仅包含有公开监控的分组；未分组置于末尾（`id: 0`、`name: null`、`isUngrouped: true`）。
- Agent 上报中的 `load.*`、`connections.*`、`process` 无法采集时传 `null`（`0` 表示实测为零）。
- Worker 历史响应带 `history_status`（`ready`、`unconfigured`、`unavailable`）和 `history_sampled`；`/api/admin/agents/:id/detail` 另含数据库归档 `history_daily` 与 `history_daily_sampled`。

## 展示与主题

- `GET / PUT /api/admin/presentation`：读写生效配置（`agentEnabled`、`aiEnabled`、`aiOnMonitorPage`、`workerService`、`domains`、`pages`）与并发 `revision`（冲突返回 `409 presentation_conflict`）。
- 页面可配 `theme`（`null` 或 `{ short, version, theme }`）、`themeOptions`、`headCode`（≤16 KiB UTF-8）和 `contentHtml`（≤32 KiB UTF-8）。预览请求（`?preview=monitor|agent|ai`）需认证且不走缓存。
- 主题包管理：`GET /api/themes`、`POST /api/themes/install`（JSON `url` 或 `Content-Type: application/zip`）、`GET /api/themes/:short/preview`、`GET /api/themes/:short/update-check`、`DELETE /api/themes/:short`。

## 监控与 Push

| 方法与路径 | 用途 |
| --- | --- |
| `GET / POST /api/monitors` | 列表 / 创建（返回 201 `id`，Push 另返回 `push_token`） |
| `GET /api/monitors/:numId/icon` | 管理端读取同步图标（不受公开范围限制） |
| `POST /api/monitors/push-credentials` | 预生成 Push UUID v4 `id` 与 48 位小写十六进制 `push_token` |
| `PUT / DELETE /api/monitors/:id` | 修改 / 删除监控 |
| `POST /api/monitors/:id/check` & `.../check` | 立即检查（拒绝暂停、Push、Agent 主机/来源） / 测试请求体配置 |
| `POST /api/monitors/visibility` | 批量切换公开状态 `{ "ids": ["..."], "is_public": false }`（`1–500` 条） |

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/monitors' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"网站健康","type":"http","target":"https://example.com/health","method":"GET","expected_status":"200-299","interval_sec":60,"timeout_ms":10000}'
```

- 常用字段：`name`、`type`、`target`、`method`、`expected_status`、`keyword`、`interval_sec`、`timeout_ms`、`check_ssl`、`check_domain`、`check_dns`、`agent_id`、`is_public`（默认 `true`）、`warn_days`（`1–365`）、`options_json`、`group_id`、`tag_ids`。
- `options_json` 可配置 `headers`、`auth`、`jsonPath`、`jsonExpected`、`maxLatencyMs`、`check_source`（`worker`、`server` 或 `{ "type": "agent", "agent_id": "UUID" }`）、UDP/TCP `send`/`expect`/`encoding`、`dns`、或 Agent `alerts`（`cpu`/`memory`/`disk`/`load`，`duration_sec` `1–86400`，`recovery_pct` `1–99`）。Go 原生配置示例见 [Go 后端说明](../backends/go/README.md#原生探测与-api)。
- **Push 上报**：`POST /api/public/push/:id`（Header `Authorization: Bearer <push_token>`，`Content-Type: application/json`，体长 ≤4096 字节），Body 为 `{"status":1,"message":"..."}`（`status` 为 `0|1|2`，默认 `1`；`message` ≤200 Unicode 字符）。`GET` 返回 `405`；认证或类型错误返回 `401`。

## AI 渠道与模型

Cookie 写请求要求同源，AI 功能关闭时手动调用返回 `409 ai_disabled`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET / POST /api/admin/ai/channels` | 列表 / 创建（`{ name, baseUrl, protocol, apiKey }`） |
| `GET / PUT / DELETE /api/admin/ai/channels/:id` | 读取（含解密 `headers`，不含 `apiKey`）/ 更新（带 `revision`）/ 删除（`{ revision }`） |
| `POST /api/admin/ai/channels/:id/test` & `GET .../models` | 检查连接 / 拉取模型（≤15 s、10 页、10000 项、2 MiB；失败 `502 ai_models_unavailable`） |
| `GET / POST /api/admin/ai/models` | 列表（含 `live` 状态）/ 创建 |
| `GET / PUT / DELETE /api/admin/ai/models/:id` | 读取 / 更新（完整配置 + `revision`）/ 删除（`{ revision }`） |
| `POST /api/admin/ai/models/:id/check` & `GET .../history?days=7` | 手动检查（`{ revision, channelRevision, confirmPaid: true }`）/ 历史（`days` `1–90`） |
| `GET /api/public/ai/models` / `/:id` / `/:id/history` | 公开读取（未启用或私有返回 `404`） |

约束：`protocol` 支持 `openai`、`openai_responses`、`anthropic`、`gemini`（不兼容模型名返回 `400 invalid_ai_model_id`）；`headers` JSON ≤64 KiB（受保护头返回 `400 invalid_ai_headers`）；`notificationChannelIds` 设在渠道上（最多 32 个）；`request` 含 `prompt`（≤2000 字符）、`maxOutputTokens`（`1–4096`）、`expectedText`（≤200 字符）及可选 `body`（≤64 KiB、嵌套 ≤32 层）。变更必须使用 `revision`（冲突 `409 revision_conflict`），勿提交 `live.revision`。

## Worker Queue

仅 Worker 提供（返回 `CheckQueueStatus`）：`GET /api/admin/check-queue`、`POST /api/admin/check-queue/probe`（`{ revision }`，返回 `202` 后轮询至 `passed`）、`PUT /api/admin/check-queue`（`{ revision, enabled }`，仅 `canEnable=true` 可开启）。

## Agent 管理

公开端点：`/api/public/agent/manifest`、`/download/:file`、`/capabilities`。Agent 上报、任务和配置接口强制校验机器 Token。

| 方法与路径 | 用途 |
| --- | --- |
| `GET / POST /api/admin/agents` | 列表 / 登记（`name`、可选 `probe_enabled`、`is_public`，返回 201 `{ id, token }`） |
| `POST /api/admin/agents/check-update` | 查最新稳定版（缓存 5 分钟；失败 `502 agent_update_unavailable`） |
| `POST /api/admin/agents/visibility` | 批量公开控制（≤500 条；机器页关闭返回 `409 agent_page_disabled`） |
| `POST /api/admin/agents/:id/rename` / `/active` / `/probe` | 改名 / 启停 / 开关探测 |
| `DELETE /api/admin/agents/:id` | 删除机器及采样（仍被监控引用返回 `409 agent_in_use`） |
| `GET /api/admin/agents/:id/detail` | 管理详情（Worker 含 `history_daily`） |
| `GET / PUT /api/admin/agents/:id/config` | 读写 7 字段运行配置（提交 `expected_revision`，冲突 `409 agent_config_conflict`） |
| `POST / GET /api/admin/agents/:id/commands` | 下发指令（`re_report`、`restart`、`upgrade`；Worker 202 / Go 200）/ 查记录 |
| `POST /api/admin/agents/batch-commands` | 批量指令（Worker 上限 100，Go 上限 500） |
| `/api/admin/agent-groups`、`/api/admin/agent-tags` | `GET` 列表；`POST` 新建；`PUT /:id` 修改；`DELETE /:id` 删除（机器页关闭返回 `409 agent_page_disabled`，重名 `409 name_exists`） |
| `PUT /api/admin/agents/:id/taxonomy` | 绑定分组与标签（`{ group_id, tag_ids }`，标签 ≤50 个） |

## 统一分组管理

`GET /api/admin/groups`、`POST /api/admin/groups`（`{ name, weight, type }`，`type` 为 `monitor`/`agent`/`common`）、`PUT /api/admin/groups/:key`（`:key` 为 `monitor:UUID` 或 `agent:UUID`；有损改型须带 `confirm_membership_reset: true`）、`DELETE /api/admin/groups/:key?scope=all`、`PUT /api/admin/groups/:key/members`（`≤500` 个未归属 ID，已归属返回 `409 group_members_assigned`）。

## 外部订阅

列表分页参数 `offset`、`limit`（默认 50，最大 200），`category` 为 `website` 或 `model`：
- 目录与仓库：`GET / POST /api/admin/subscription-catalog` (`/refresh`)、`POST / DELETE /api/admin/subscription-repositories` (`/:id`，最多 8 个)、`POST / DELETE /api/admin/subscription-configs/import` (`/:configId`)、`POST .../preview` + `GET .../subscription-previews/:previewId`（202 轮询，10 分钟有效）。
- 订阅管理：`GET / POST /api/admin/subscriptions`（支持幂等 `requestId`）、`GET / PATCH / DELETE /:id`（带 `revision`）、`GET / PATCH /:id/items`（最多 100 项）、`POST /:id/sync` + `GET .../subscription-runs/:runId`、`GET /:id/runs` / `/config` / `/config/export`、`POST .../config/check-update` & `.../preview`（`rollback:true`） & `PUT .../config`（ID 变更须带 `confirmIdentityChange:true`）。
- 公开读取：`GET /api/public/subscriptions/items`、`/:id/history`、`/icons/:id`。

## 通知、设置与运维

- **通知**：`GET / POST /api/notifications`、`PUT / DELETE /:id`、`POST /:id/test`（校验返回体 `ok` 与 `error`；不存在时 Worker 返回 200 `ok:false`，Go 返回 404）、`POST /api/notifications/resolve`、`/stats`、`/deliveries`。
- **设置与运维**：`GET / PUT /api/admin/settings`、`DELETE /:key`、`GET /api/admin/usage`、`GET /api/admin/version`（Worker，缓存 6 小时，`?refresh=1` 1 分钟）、`POST /api/cron/tick`、`/api/cron/sync`（执行实际任务，非健康检查）。

## 错误码说明

错误响应格式为 `{ "error": "<code>", ... }`：`400` 参数无效、`401` 凭据无效/未登录、`403` 权限或开关限制、`404` 不存在或未公开、`405` 方法错误、`409` 版本/状态冲突、`413`/`415` 体积或类型错误、`429` 限流（看 `Retry-After`）、`5xx` 后端或上游故障（失败的写请求勿盲目重放）。

## English

Reference for primary HTTP endpoints, authentication, payload fields, and error codes.

### Authentication and setup

Management endpoints accept a session cookie or Bearer token (`ADMIN_TOKEN` on Worker; `POLARIS_ADMIN_TOKEN` on Go). Sessions are per-hostname. Monitor `id` is a UUID for admin writes; `num_id` is the numeric public ID.

- Auth routes: `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/setup` (no open registration). With external auth enabled (Go or Worker), `POST /api/auth/external` restores external sign-in (`404` disabled, `401` invalid, `403` cross-origin; local edits return `403 external_account_managed`). External identities stay inactive until `/setup` completes and management routes return `401` before then. See [External authentication](external-auth.md#english).
- **Setup contract**: when `needsSetup: true`, `/api/auth/session` includes `setupDatabase` (never exposing URLs) and, on Worker, `setupRequirements`. Worker runs `POST /api/auth/setup/database` (poll `/api/auth/session` until `configurationId` matches) before `POST /api/auth/setup` (10-minute max lease). Errors: `400` (`invalid_database_type`, `invalid_database_url`), `409` (`setup_in_progress`, `setup_complete`), `503` (`deployment_incomplete`, `credential_unconfigured`, `database_connection_failed`, `database_initialization_failed`, `database_configuration_failed`).

### Public, presentation, and themes

- `GET /api/capabilities` exposes runtime, probe sources, monitor types, limits, and theme support.
- Public GET routes: `/api/public/health`, `/api/public/status`, `/api/public/status/detail`, `/api/public/config`, `/api/public/maintenance` (`no-store`), `/api/public/monitors`, `/api/public/monitors/:numId`, `/api/public/agent/detail/:numId`, `/api/public/servers`, `/api/public/servers/:id` (`404` when machine page disabled), `/api/public/theme`, `/api/public/icon`, `/api/public/monitor-icon?id=:numId`, `/api/public/ai/models`, `/api/public/ai/models/:id`, `/api/public/subscriptions/items`, `/api/public/subscriptions/items/:id`. Status codes: `0` DOWN, `1` UP, `2` WARN, `4` PENDING (`ping: null` when absent). Uncollected Agent metrics (`load.*`, `connections.*`, `process`) are `null`. Worker history carries `history_status` and `history_sampled`.
- Presentation & themes: `GET / PUT /api/admin/presentation` (`revision` concurrency, `409 presentation_conflict`; `headCode` ≤16 KiB, `contentHtml` ≤32 KiB); `GET /api/themes`, `POST /api/themes/install`, `GET /api/themes/:short/preview`, `GET /api/themes/:short/update-check`, `DELETE /api/themes/:short`.

### Monitors, Push, and AI

- Monitors: `GET / POST /api/monitors`, `GET /api/monitors/:numId/icon`, `POST /api/monitors/push-credentials`, `PUT / DELETE /api/monitors/:id`, `POST /api/monitors/:id/check`, `POST /api/monitors/check`, `POST /api/monitors/visibility` (`1–500` IDs).
- Push: `POST /api/public/push/:id` with `Authorization: Bearer <push_token>`, `Content-Type: application/json`, ≤4096 bytes, `{"status":1,"message":"..."}` (`GET` → `405`; auth/type errors → `401`).
- AI (`409 ai_disabled` when off): `GET / POST /api/admin/ai/channels`, `GET / PUT / DELETE /api/admin/ai/channels/:id`, `POST .../test`, `GET .../models`; `GET / POST /api/admin/ai/models`, `GET / PUT / DELETE /api/admin/ai/models/:id`, `POST .../check` (`{ revision, channelRevision, confirmPaid: true }`), `GET .../history?days=7` (`1–90`); public `GET /api/public/ai/models`, `/:id`, `/:id/history`. Use `revision` for writes (never `live.revision`).

### Queue, Agents, groups, and subscriptions

- **Worker Queue**: `GET /api/admin/check-queue`, `POST .../probe` (`202`), `PUT /api/admin/check-queue` (`{ revision, enabled }`).
- **Agents**: public `/api/public/agent/manifest`, `/api/public/agent/download/:file`, `/api/public/agent/capabilities`; admin `GET / POST /api/admin/agents`, `POST /api/admin/agents/check-update`, `POST /api/admin/agents/visibility` (≤500), `POST /api/admin/agents/:id/rename`, `/active`, `/probe`, `DELETE /api/admin/agents/:id` (`409 agent_in_use`), `GET /api/admin/agents/:id/detail`, `GET / PUT /api/admin/agents/:id/config` (`expected_revision`), `POST` / `GET /api/admin/agents/:id/commands` (Worker `202` / Go `200`), `POST /api/admin/agents/batch-commands` (100 Worker / 500 Go), `/api/admin/agent-groups`, `/api/admin/agent-tags`, `PUT /api/admin/agents/:id/taxonomy`.
- **Groups**: `GET / POST /api/admin/groups`, `PUT /api/admin/groups/:key` (`confirm_membership_reset: true` on destructive conversions), `DELETE /api/admin/groups/:key?scope=all`, `PUT /api/admin/groups/:key/members` (`≤500`).
- **Subscriptions** (`offset`, `limit` max 200; `website` | `model`): `/api/admin/subscription-catalog` (`/refresh`), `/subscription-repositories`, `/subscription-configs/import`, `/preview` (`202` + poll), `/api/admin/subscriptions` (`/:id`, `/:id/items`, `/:id/sync`, `/:id/runs`, `/:id/config`, `/export`, `/check-update`, `/preview`, `PUT .../config`), public `/api/public/subscriptions/items`, `/:id/history`, `/icons/:id`.

### Notifications, settings, ops, and errors

- Notifications: `GET / POST /api/notifications`, `PUT / DELETE /:id`, `POST /:id/test` (check `ok` and `error`), `POST /api/notifications/resolve`, `/stats`, `/deliveries`.
- Settings & ops: `GET / PUT /api/admin/settings`, `DELETE /:key`, `GET /api/admin/usage`, `GET /api/admin/version` (Worker), `POST /api/cron/tick`, `/api/cron/sync`.
- Error codes (`{ "error": "<code>" }`): `400` bad input, `401` auth error, `403` forbidden/disabled, `404` missing/private, `405` wrong method, `409` conflict, `413`/`415` size/type, `429` rate limit, `5xx` server error.
