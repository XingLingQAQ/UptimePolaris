# API 参考

[English](#api-reference)

本文列出集成和自动化会用到的接口、认证方式和请求字段。

## 目录

- [认证与标识](#认证与标识)
- [公开读取](#公开读取)
- [公开展示设置](#公开展示设置)
- [管理监控](#管理监控)
- [AI 渠道和模型](#ai-渠道和模型)
- [外部订阅](#外部订阅)
- [Worker Queue](#worker-queue)
- [Push 接入](#push-接入)
- [Agent 接入](#agent-接入)
- [通知与设置](#通知与设置)
- [主题管理](#主题管理)
- [运维触发](#运维触发)
- [错误处理](#错误处理)

## 认证与标识

管理接口接受已登录的会话 Cookie，或配置好的管理 Token。Worker 用 `ADMIN_TOKEN`，Go 用 `POLARIS_ADMIN_TOKEN`：

```http
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

浏览器登录用会话，不要把管理密钥打进前端。自动化脚本从受保护的环境变量或凭据文件读取密钥。下面的 Shell 示例假定 `$ADMIN_TOKEN` 已经安全设置。

两个展示域名上的 `/admin` 是同一套后台，登录和 API 请求留在当前域名。会话 Cookie 按域名保存；跨域名访问后台时要分别登录。

| 标识 | 用途 |
| --- | --- |
| 监控 `id` | UUID；管理写操作、分组关联、主题监控选项 |
| 监控 `num_id` | 公开详情路径里的数字 ID |
| Push Token | 某个 Push 监控的心跳写凭据 |
| Agent Token | 某台机器的采集、任务和配置协议凭据 |

`GET /api/auth/session` 读取登录和初始化状态；`POST /api/auth/login`、`POST /api/auth/logout` 管理会话。`POST /api/auth/setup` 只用于还没初始化的环境，实际操作建议走 `/setup`。没有开放用户注册接口。

### 初始化数据库契约

`GET /api/auth/session` 在 `needsSetup` 为 `true` 时返回 `setupDatabase`（Worker 未绑定 D1 时，`types` 为 `["postgres"]`，默认类型为 `postgres`）；初始化完成后该字段为 `null`。响应从不包含数据库连接 URL。

Worker 在 `needsSetup` 为 `true` 时还会返回 `setupRequirements` 数组（初始化完成后为 `null`，Go 后端不返回该字段），每项为 `{ key, required, ok }`：

| `key` | `required` | 含义 |
| --- | --- | --- |
| `database` | `false` | 已绑定 `DB`（D1）；未绑定不阻止进入初始化，数据库选择和连接在初始化表单中校验 |
| `config` | `true` | 已绑定 `CONFIG`（KV）；保存数据库选择和加密连接地址 |
| `adminToken` | `true` | 已配置 `ADMIN_TOKEN` |
| `themes` | `false` | 已绑定 `THEMES`（R2 主题存储） |
| `analytics` | `true` | 已绑定 `UPTIME`（Analytics Engine） |
| `analyticsSql` | `false` | 已绑定 `ANALYTICS_SQL`（历史查询）；缺少时不影响实时监控，但无法读取 AE 历史或执行每日归档 |

Worker 尚未配置数据库时，仍返回选库选项并允许进入初始化表单；其他页面请求重定向到 `/setup`，业务 API 返回 503 `setup_required`，若部署必需项未通过则返回 `deployment_incomplete`。`POST /api/auth/setup` 在缺少 `UPTIME` 时返回 503 `deployment_incomplete`；没有可用的 PostgreSQL 连接时返回 400 `invalid_database_url`，选择未绑定的 D1 时返回 400 `invalid_database_type`。补绑后重新读取会话即可更新检查结果和数据库选项。

| `setupDatabase` 字段 | 类型 | 含义 |
| --- | --- | --- |
| `types` | `("d1" \| "sqlite" \| "postgres")[]` | 当前可选的初始化数据库类型；Worker 绑定 D1 时为 D1 / PostgreSQL，未绑定时只有 PostgreSQL；Go 为 SQLite / PostgreSQL |
| `defaultType` | `"d1" \| "sqlite" \| "postgres"` | 初始化页面的默认类型 |
| `postgresConfigured` | `boolean` | 当前 PostgreSQL 连接是否可供复用，不包含连接地址 |
| `postgresUrlEditable` | `boolean` | 是否允许提交新的 PostgreSQL URL；Worker 绑定 `CONFIG` KV 时可编辑，账号写入开始后锁定；Go 为 `true` |
| `configurationId` | `string`，可选 | 当前可读的 KV 配置标识，用于确认配置同步；不含连接地址 |

`POST /api/auth/setup/database` 仅用于 Worker 的第二步，接受 `{ credential, database: { type, url? } }`，验证连接、初始化空库并保存配置，返回 `{ ok: true, type, configurationId? }`，不创建账号。页面填写的 PostgreSQL 连接加密保存在 `CONFIG` KV；初始化租约和账号写入状态保存在目标数据库。返回 `configurationId` 时，客户端应等会话中的同名字段与其一致后，再进入账号步骤；同步期间只需重读会话，不重复写入配置。

`POST /api/auth/setup` 接受 `credential`、`username`、`password` 和可选的 `database` 对象。最后一步可只提交已验证的数据库类型，服务端复用保存的连接；也可按 `postgresUrlEditable` 提交新 URL。省略 `database` 沿用当前配置。成功后在目标库创建管理员和会话，后续请求和重启继续使用已保存的选择。

数据库验证通过、账号尚未写入时，用户可以返回第二步更换连接。账号写入开始后锁定已选类型和 URL，`postgresUrlEditable` 为 `false`；续接时需使用原账号和密码。其他业务在 pending 期间停用。进程中断后，租约最多持续 10 分钟。

| HTTP | 初始化错误码 | 处理方式 |
| --- | --- | --- |
| 400 | `invalid_database_type` | 按当前后端支持的类型重新选择 |
| 400 | `invalid_database_url` | 检查 PostgreSQL URL |
| 503 | `deployment_incomplete` | Worker 缺少 `UPTIME`，先在控制台添加 Analytics Engine 绑定 |
| 503 | `credential_unconfigured` | 尚未配置初始化凭据（Worker 的 `ADMIN_TOKEN` 或 Go 的 `POLARIS_SETUP_KEY`） |
| 503 | `database_connection_failed` | 检查数据库连接与访问条件 |
| 503 | `database_initialization_failed` | 检查目标数据库初始化条件 |
| 503 | `database_configuration_failed` | 检查部署侧数据库配置 |
| 409 | `setup_in_progress` | 等待当前初始化完成，再读取状态 |
| 409 | `setup_complete` | 环境已初始化，使用登录入口 |

错误不包含底层连接错误或 URL。连接地址和初始化凭据属于敏感信息，不要写进公开日志或截图。

## 公开读取

匿名 `GET /api/capabilities` 返回后端 `runtime`、探测来源 `probeSource`、可用类型、间隔和超时范围，以及主题存储能力。客户端按这个结果展示功能，并以当前服务实际返回的能力为准。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/public/health` | 请求服务健康，返回 `ok` 和时间戳；不代表所有监控正常 |
| `GET /api/public/status` | 公共状态摘要 |
| `GET /api/public/status/detail` | 公共状态详情 |
| `GET /api/public/config` | 当前公开站点与主题配置 |
| `GET /api/public/maintenance` | 当前维护状态与接下来的维护窗口 |
| `GET /api/public/monitors` | 公共监控列表 |
| `GET /api/public/monitors/:numId` | 单个监控的公开详情 |
| `GET /api/public/agent/detail/:numId` | Agent 公开指标详情 |
| `GET /api/public/servers` | 机器页中选中的机器列表 |
| `GET /api/public/servers/:id` | 机器页中选中的单台机器与已启用的历史数据 |
| `GET /api/public/theme` | 当前激活主题版本 |
| `GET /api/public/icon` | 当前站点图标 |
| `GET /api/public/monitor-icon?id=:numId` | 所选 HTTP 监控的站点图标，须启用图标同步 |

```sh
curl --fail-with-body 'https://status.example.com/api/public/status'
```

这些读取不需要管理凭据。监控类接口只在监控页域名返回所选且标记为公开的监控；机器类接口只在启用的机器页域名返回所选且启用的机器。未选中对象的详情返回 404。机器页默认关闭，关闭时机器列表和详情接口返回 404，Agent 通信不受影响。部分公开 GET 使用 15 秒缓存；带 Cookie、Authorization 的请求、写操作和错误响应不按相同规则缓存。脱敏范围见[使用手册](usage.md#公开数据)。

`/api/public/monitors` 的 `monitorGroups` 包含监控列表，监控的 `id` 是数字 ID。共享类型为 `http`、`tcp`、`udp`、`icmp`、`push` 和 `agent`；Go 还支持 `dns`、`tls` 和 `websocket`。实际可用类型和执行源以 `/api/capabilities` 为准，Worker 不提供 Go 的三种独立类型。`data.heartbeatList` 以数字 ID 的字符串为键，每个心跳用 `status` 表示状态：`0` 为 DOWN，`1` 为 UP，`2` 为 WARN，`4` 为 PENDING。`time` 是 UTC 时间，`ping` 没有延迟数据时为 `null`。

`/api/public/maintenance` 返回 `active`、`source`、`serverNow`、统一配置的 `title` 和 `description`、当前窗口的 `startsAt` 和 `endsAt`，以及按开始时间排序的 `scheduled` 列表。`source` 为 `manual`、`scheduled` 或 `null`。手动维护优先于计划维护，一直持续到管理员关闭；手动维护或没有进行中的窗口时，当前窗口时间为 `null`。时间使用 UTC ISO 8601 字符串。响应使用 `no-store`。`/api/public/config` 也提供 `maintenance` 和 `maintenanceList`。维护期间 API 正常服务；公开页面的展示行为见[维护窗口](usage.md#维护窗口)。

### Worker 历史响应

Agent 上报中的 `load.load1`、`load.load5`、`load.load15`、`connections.tcp`、`connections.udp` 和 `process` 字段必须保留。无法采集时传 `null`；`0` 仅表示实际观测为零。Worker 与 Go 使用相同规则。

`GET /api/public/monitors/:numId` 的 `ring` 是近期实际检查状态，`history` 是从 AE 读取的延迟明细。`GET /api/public/agent/detail/:numId` 的 `buckets` 和 `GET /api/public/servers/:id` 的 `history` 也来自 AE；后者仅在页面启用历史时返回历史状态。

这些响应中的 `history_status` 为 `ready`、`unconfigured` 或 `unavailable`，分别表示查询成功、缺少 `ANALYTICS_SQL` 绑定、暂时读取失败。`history_sampled` 表示查询结果是否包含采样；`ready` 和空数组表示查询成功但该窗口没有记录。历史读取失败不会丢弃实时数据。缺失延迟、CPU 和内存读数保持 `null`。

`GET /api/admin/agents/:id/detail` 还返回 `history_daily`，用于读取已归档的资源日汇总；`history_daily_sampled` 标记其中是否含采样结果。日汇总来自业务数据库，可在 AE 查询不可用时继续读取。

## 公开展示设置

以下接口需要管理认证：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/presentation` | 读取生效配置 `config` 和并发控制用的 `revision` |
| `PUT /api/admin/presentation` | 提交完整 `config` 和读取到的 `revision`，保存后立即生效 |

展示设置只有一份生效配置。`revision` 变了会返回 409 `presentation_conflict`，这时重新读取并合并修改。配置包含 `agentEnabled`、`aiEnabled`、`aiOnMonitorPage`、`workerService`、`domains` 和 `pages`；域名项为 `{ hostname, page }`，`page` 为 `monitor`、`agent` 或 `ai`。添加后立即生效，没有逐项开关。每个页面保存 `theme`、`themeOptions`，以及可选的 `headCode` 和 `contentHtml`，约束见[主题页面自定义内容](#主题页面自定义内容--theme-page-custom-content)。域名映射由管理员手动填写。先在部署侧完成 DNS 配置和 Worker 或服务器的域名绑定，再保存映射。

`agentEnabled` 控制机器独立展示，`aiEnabled` 控制 AI 监控及公开读取。关闭 AI 时停止定时、Queue 和手动 AI 调用，保留配置与历史；手动调用返回 409 `ai_disabled`。`aiOnMonitorPage` 控制 AI 模型是否出现在主监控页，不影响独立 AI 页。机器和 AI 功能都关闭时，域名映射停止生效，默认显示监控页；已保存的配置不删除。

主题预览请求带 `preview=monitor`、`preview=agent` 或 `preview=ai` 时，需要管理会话或 `ADMIN_TOKEN`，并使用当前配置里对象的公开状态。预览响应不进共享缓存；匿名请求预览返回 401。各页面的主题和选项分别保存在 `pages.monitor`、`pages.agent` 和 `pages.ai`。公开的 `/ai` 页面请求 API 时附带 `view=ai`；已绑定的 AI 域名直接使用对应页面范围。安装、配置和预览方法见[主题指南](themes.md)。

## 管理监控

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/monitors` | 管理监控列表，含管理所需配置 |
| `POST /api/monitors` | 创建监控 |
| `POST /api/monitors/push-credentials` | 预先生成 Push 上报凭据，不创建监控 |
| `PUT /api/monitors/:id` | 修改监控 |
| `DELETE /api/monitors/:id` | 删除监控及相关数据 |
| `POST /api/monitors/:id/check` | 立即检查由当前后端直接执行的主动监控 |
| `POST /api/monitors/check` | 测试请求体中的监控配置，不保存监控 |

创建 HTTP 监控：

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/monitors' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"网站健康","type":"http","target":"https://example.com/health","method":"GET","expected_status":"200-299","interval_sec":60,"timeout_ms":10000}'
```

创建成功返回 201 和 `id`。Push 类型还会返回 `push_token`，按凭据保存，不要写进公共日志。Agent 类型监控必须通过 `agent_id` 选择已登记的机器，不会创建机器，也不会生成机器凭据。

常用请求字段：

| 字段 | 说明 |
| --- | --- |
| `name`、`type`、`target` | 名称、类型、目标；Go 还支持 `dns/tls/websocket`，完整类型从能力接口读取 |
| `method`、`expected_status` | HTTP 方法与状态规格 |
| `keyword` | HTTP 关键词检查 |
| `interval_sec`、`timeout_ms` | Worker：60–86400 秒、1000–60000 毫秒；Go：5–86400 秒、100–120000 毫秒 |
| `check_ssl`、`check_domain`、`check_dns` | SSL 监控、域名到期和 DNS 附加检查开关 |
| `agent_id` | Agent 类型监控选择的机器 UUID |
| `is_public` | 是否允许公开，布尔值，默认 `true`；公开展示还须匹配监控页选择，`false` 时公开接口无法读取这个监控及其历史 |
| `warn_days` | 到期预警天数，默认 14，1–365 |
| `options_json` | 类型对应的 JSON 选项 |
| `group_id`、`tag_ids` | 现存分组 UUID 与标签 UUID 列表 |

批量切换公开状态用 `POST /api/monitors/visibility`，提交 `{ "ids": ["监控 UUID"], "is_public": false }`。一次可选 1–500 条监控，成功返回 `{ "ok": true, "updated": 1, "is_public": false }`。任一 ID 不存在，本次变更就不执行。

`options_json` 接受对象，或能解析成对象的 JSON 字符串，保存后读取为 JSON 字符串；不能是数组。HTTP 选项对象示例：

```json
{
  "headers": { "Accept": "application/json" },
  "auth": { "type": "bearer", "token": "replace-with-target-api-token" },
  "jsonPath": "status",
  "jsonExpected": "ok",
  "maxLatencyMs": 2000,
  "check_source": { "type": "worker" }
}
```

TCP 可用 `send`、`expect` 和 `check_source`。DNS 选项放在 `dns` 里，包含 `recordType`、`expected`、`resolver`。Agent 类型监控的选项只接受 `alerts`；告警规则名为 `cpu`、`memory`、`disk`、`load`，每条包含 `enabled`、`threshold`、`duration_sec`、`recovery_pct`。持续时间为 1–86400 秒，恢复比例大于 0 且小于 100，百分比指标阈值大于 0 且不超过 100，负载阈值最大 10000。机器的 `probe_enabled` 通过 Agent 管理接口设置。

检查来源在选项里指定：Worker 原生来源为 `{ "check_source": { "type": "worker" } }`，Go 原生来源为 `{ "check_source": { "type": "server" } }`，Agent 来源为 `{ "check_source": { "type": "agent", "agent_id": "UUID" } }`。选择 Agent 后，主检查和所选附加检查都由这台机器执行，需要它上报对应能力。SSL 附加检查每天执行一次；Go 独立 TLS 监控按配置的间隔执行。

Worker 上的 `udp` 和 `icmp` 必须显式选择 Agent 来源，机器要在线并上报 `probe_udp` 或 `probe_icmp`。缺少来源或设成 Worker 来源都会被拒绝。Go 可以直接执行 UDP，ICMP 是否可用取决于启动时的实际权限检测。UDP 选项为 `send`、可选的 `expect`、`encoding`（`text` 或 `hex`）及 `check_source`；ICMP 选项只用 `check_source`。Go 新增类型的请求示例见 [Go 后端说明](../backends/go/README.md#原生探测与-api)。

同步立即检查会拒绝暂停条目、Push、Agent 主机和 Agent 来源监控。表单配置测试也不会把 Agent 来源改成 Worker 探测；应等待实际任务结果。

## AI 渠道和模型

AI 管理接口使用相同的管理员会话或 Bearer Token。写请求来自 Cookie 会话时要求同源。API Key 只在创建或替换时提交，读取响应仅包含 `hasApiKey`，不返回原密钥或密文。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/ai/channels` | 渠道列表，返回 `{ channels }` |
| `POST /api/admin/ai/channels` | 添加渠道：`{ name, baseUrl, protocol: "openai", apiKey }` |
| `GET /api/admin/ai/channels/:id` | 读取渠道，返回 `{ channel }` |
| `PUT /api/admin/ai/channels/:id` | 修改渠道，提交 `name`、`baseUrl`、`protocol`、当前 `revision`；省略 `apiKey` 保留原密钥 |
| `DELETE /api/admin/ai/channels/:id` | 提交 `{ revision }`，删除渠道及其模型 |
| `POST /api/admin/ai/channels/:id/test` | 提交 `{ revision }`，检查模型列表接口 |
| `GET /api/admin/ai/channels/:id/models` | 读取渠道提供的模型，返回 `{ models: [{ id, name }], fetchedAt }` |
| `GET /api/admin/ai/models` | 模型列表，包含各模型的 `live` 定时状态，返回 `{ models }` |
| `POST /api/admin/ai/models` | 添加模型，字段见下方示例 |
| `GET /api/admin/ai/models/:id` | 读取模型，返回 `{ model }` |
| `PUT /api/admin/ai/models/:id` | 提交完整配置和当前 `revision` |
| `DELETE /api/admin/ai/models/:id` | 提交 `{ revision }`，删除模型 |
| `POST /api/admin/ai/models/:id/check` | 提交 `{ revision, channelRevision, confirmPaid: true }`，执行可能收费的手动检查 |
| `GET /api/admin/ai/models/:id/history?days=7` | 历史汇总和明细；`days` 范围为 1～90 |

渠道的 `protocol` 必填，可选值为 `openai`（Chat Completions）、`openai_responses`、`anthropic` 和 `gemini`。`baseUrl` 填写含版本路径的接口前缀，生成路径由所选协议追加。Gemini 的 `modelId` 使用不含 `models/` 的模型名称，仅支持英文字母、数字、点、下划线和连字符，且必须以字母或数字开头。无效名称或向 Gemini 切换时已有模型名称不合要求，返回 400 `invalid_ai_model_id`。地址和模型示例见 [AI 模型监控](ai-monitoring.md#添加渠道和模型)。

渠道写入可带 `headers` 字符串键值对象，不限制条数，编码后的 JSON 不超过 64 KiB。头名称忽略大小写，不可重复；值不超过 2048 个可打印 ASCII 字符。认证、路由、Cookie 和连接控制类请求头不能覆盖，非法内容返回 400 `invalid_ai_headers`。更新时省略 `headers` 保留原值，`{}` 清除。列表和写入响应只返回 `headerNames`；管理员读取 `GET /api/admin/ai/channels/:id` 时另返回解密后的 `headers`，用于再次编辑。API Key 和密文始终不返回。

渠道写入可带 `notificationChannelIds`，最多选择 32 个已有通知渠道 ID，适用于该 AI 渠道下的所有模型。更新时省略则保留；`[]` 使用全局规则，向未限定分组的已启用渠道发送。非空数组只向指定渠道发送。渠道读取返回该字段，模型不包含该字段。普通监控通过 `options_json.notificationChannelIds` 使用相同选择规则；留空时按原有通知分组范围匹配。

`baseUrl` 支持 HTTP、HTTPS、本机、容器服务名和内网地址，仍拒绝 URL 凭据、查询参数、片段及云元数据地址。云端 Worker 能否连接取决于其网络环境，不能将 `localhost` 解释为用户电脑。

添加模型的请求体示例，其中 `channelId` 换成创建渠道后得到的 ID：

```json
{
  "channelId": "CHANNEL_ID",
  "name": "主力对话模型",
  "modelId": "example-chat",
  "intervalSec": 300,
  "timeoutMs": 30000,
  "request": {
    "prompt": "Reply OK.",
    "maxOutputTokens": 64,
    "expectedText": ""
  },
  "enabled": true,
  "isPublic": false
}
```

修改或删除必须使用最新读取的 `revision`。渠道密钥、地址、协议或模型配置变更会更新版本；409 `revision_conflict` 时重新读取，不覆盖其他人的修改。手动模型检查同时校验渠道版本；配置在调用中变更时也可能返回 409，而上游请求可能已经收费。手动结果不写入定时历史和可用率。

每次编辑都会更新并发控制用的 `revision`。探测版本单独保存：修改名称、公开设置、通知渠道或暂停状态不清空最近结果和状态条；修改地址、协议、密钥、请求头、模型 ID、检查间隔、超时或请求内容后，等待新配置的实际检查。`live.revision` 和 `live.channelRevision` 是探测版本，不能用于修改或删除请求。

后台模型列表、单个模型和对应的公开响应包含 `recent`。每项为 `{ checkedAt, outcome, latencyMs, statusCode }`，按时间从旧到新，最多 60 项，仅包含实际执行的定时检查。手动检查、预算不足和其他未执行轮次不会加入。暂无记录时返回 `[]`，不会补造历史。

渠道模型列表使用渠道的认证和自定义请求头，不发起文本生成。支持四种协议及游标分页，合并重复 ID；Gemini 去除 `models/` 前缀，排除明确不支持 `generateContent` 的模型。单次读取总超时 15 秒，最多 10 页、10000 个模型和 2 MiB 响应。上游失败或超限返回 502 `{ error: "ai_models_unavailable", outcome }`，不将未读完的列表作为完整结果返回。渠道不存在返回 404，读取期间渠道被修改返回 409。

`request` 在创建时可省略，使用示例中的默认值；更新时省略会保留原设置。提供时须包含 `prompt`、`maxOutputTokens` 和 `expectedText`：提示词最多 2000 个字符，token 上限为 1～4096 的整数，期望文本最多 200 个字符。匹配使用区分大小写的包含判断，留空只校验有效文本；不匹配的检查结果为 `response_mismatch`，非法设置返回 400 `invalid_ai_request`。

可选的 `request.body` 是最多 64 KiB、嵌套不超过 32 层的 JSON 对象，与协议默认请求体递归合并；数组整体替换，`{}` 清除自定义内容。模型 ID、非流式和输出上限由表单字段控制，Responses 固定 `store: false`。OpenAI 自定义体包含 `max_completion_tokens` 时使用该参数承载表单的输出上限，不再同时发送 `max_tokens`。请求头、提示词和自定义请求体不进入公开响应。

公开读取使用 `GET /api/public/ai/models`、`GET /api/public/ai/models/:id` 和 `GET /api/public/ai/models/:id/history?days=7`，仅返回启用且公开的模型；其余模型返回 404。公开响应不包含渠道地址、密钥、请求或供应商响应正文。

公开模型包含 `channel: { id, name }`，用于按渠道分组和搜索；后台模型另包含 `channelName`。渠道名称属于公开信息，不应包含敏感内容。只返回当前可公开模型的渠道分组信息，不提供匿名读取所有渠道的接口。

历史响应为 `{ modelId, days, points, detailStatus, sampled }`。每日汇总含实际总次数、成功次数、可用率和平均耗时；`sampled` 仅描述明细，不能据此重新计算精确次数。`detailStatus` 为 `unconfigured` 或 `unavailable` 时仍可能有可读的每日汇总。使用方式与密钥恢复见 [AI 模型监控](ai-monitoring.md)。

历史范围包含当前 UTC 日期在内的 `days` 个自然日，与前端的 7、30、90 天切换一致；明细最多返回范围内最近 100 次实际检查。

## Worker Queue

以下接口仅用于 Worker，要求管理员认证，同源写入规则与 AI 管理接口一致。Go 不提供 Queue 功能。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/check-queue` | 返回 Queue 状态，包括 `bound`、`enabled`、`canEnable`、`schema`、`revision`、`verification`、积压和处理时间 |
| `POST /api/admin/check-queue/probe` | 提交 `{ revision }`，发送往返探测消息；202 响应仅表示已接受，不代表消费者已确认 |
| `PUT /api/admin/check-queue` | 提交 `{ revision, enabled }`，显式启用或关闭分批检查 |

三个接口直接返回 `CheckQueueStatus` 对象，不套 `status` 字段。`verification.state` 为 `never`、`pending`、`passed`、`timed_out` 或 `failed`；探测不调用监控目标。客户端读取状态，直到消费者确认或到达 `verification.expiresAt`，不要把 POST 返回成功当成检测通过。

只有 `canEnable=true` 才能启用；已通过的检测超过有效期后需重新检测。修改携带最新 `revision`，409 `revision_conflict` 时重新读取。`schema` 为 `missing` 或 `unavailable` 时不能修改 Queue 配置，普通未启用 Queue 的监控不因此新增部署前提。

`pendingTasks` 为程序记录的待处理任务数，`oldestPendingAt`、`lastEnqueuedAt`、`lastProcessedAt` 为 Unix 秒或 `null`，不等同于 Cloudflare 控制台的消息总数。绑定与运维步骤见 [Worker Queue](queue.md)。

## Push 接入

新建表单通过 `POST /api/monitors/push-credentials` 预先获取 `id` 和 `push_token`，保存前即可查看地址、复制密钥。此接口需要管理凭据，不创建监控；保存监控后才能接收上报。

创建 Push 监控时，可将返回的对象放入 `push_credentials` 字段，保存时沿用其中的 ID 和密钥。不传该字段时，由创建接口生成凭据。ID 必须为小写 UUID v4，密钥为 48 位小写十六进制字符；重复 ID 返回 409，不会覆盖已有监控。将其他类型改为 Push 时，`push_credentials.id` 使用原监控 ID。

上报地址使用监控 ID，密钥通过 `Authorization: Bearer <push_token>` 发送。普通编辑保留并返回当前密钥，不接受替换凭据的 `push_credentials` 字段；改为其他监控类型会撤销密钥，切回 Push 时生成新密钥。

先将密钥存入环境变量 `PUSH_TOKEN`，再用监控 ID 替换 `MONITOR_ID`：

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/public/push/MONITOR_ID' \
  -H "Authorization: Bearer $PUSH_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"status":1,"message":"job-ok"}'
```

- `status` 仅接受 JSON 整数 `0`、`1`、`2`，分别表示故障、正常、警告。省略请求体或 `status` 时，按正常心跳处理。
- `message` 是可选字符串，最多 200 个 Unicode 字符。无效 JSON、非法状态、超长消息及未定义字段会返回 400。
- 成功返回 200 和 `{"ok":true}`。密钥缺失、错误，或监控不存在、已暂停、不是 Push 类型时，统一返回 401，不写入心跳。
- 非空请求体须使用 `Content-Type: application/json`，否则返回 415；请求体最多 4096 字节，超限返回 413。
- GET 返回 405，不记录心跳。该接口不接受 URL 查询参数，状态和说明通过 JSON 传入。
- Push 不测量延迟。要让正常调度持续运行，才能在停报后判断超时。

完整场景见[使用手册](usage.md#push-监控)。

## Agent 接入

通常使用官方 Agent，不建议手写采集协议。下载和能力端点：

| 路径 | 用途 |
| --- | --- |
| `/api/public/agent/manifest` | 已验证的最新 GitHub Release 清单 |
| `/api/public/agent/download/:file` | 到 GitHub Release 二进制资产的重定向 |
| `/api/public/agent/capabilities` | 最新 Release 的平台清单 |

安装与重新安装从 Agent 的 GitHub 仓库获取脚本，通过参数传入站点地址。脚本在目标机器上查询 GitHub 最新稳定版并下载、校验二进制，不调用站点的清单、平台或二进制下载接口。上表的发布查询接口可独立使用，不是安装的前置条件。

Agent 协议用独立的机器 Token，涉及上报、WebSocket、带租约的探测任务、结果和配置交换。路径里有 `public` 不代表写操作不用认证。

管理侧常用路由：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/agents` | 机器列表 |
| `POST /api/admin/agents` | 登记机器，接收 `name` 和可选布尔值 `probe_enabled`、`is_public`（均默认 `true`），返回 201 `{ id, token }`，不创建监控 |
| `POST /api/admin/agents/visibility` | `{ ids, is_public }` 批量设置机器公开状态；最多 500 个 ID，要求机器页已启用 |
| `POST /api/admin/agents/:id/rename` | 使用 `{ name }` 修改名称 |
| `POST /api/admin/agents/:id/active` | 使用布尔值 `{ active }` 启用或停用机器 |
| `POST /api/admin/agents/:id/probe` | 使用布尔值 `{ enabled }` 修改机器的探测开关 |
| `DELETE /api/admin/agents/:id` | 删除未被监控引用的机器及其采样历史；仍被引用时返回 409 `agent_in_use` |
| `GET /api/admin/agents/:id/detail` | 管理详情 |
| `GET /api/admin/agents/:id/config` | 运行配置与同步状态 |
| `PUT /api/admin/agents/:id/config` | 更新受支持的运行配置 |
| `POST /api/admin/agents/:id/commands` | 下发白名单动作 |
| `GET /api/admin/agents/:id/commands` | 指令执行记录 |
| `POST /api/admin/agents/batch-commands` | 批量指令 |
| `GET /api/admin/agent-groups`、`GET /api/admin/agent-tags` | 读取独立的 Agent 分组和标签 |
| `POST /api/admin/agent-groups`、`POST /api/admin/agent-tags` | 创建 Agent 分组或标签 |
| `PUT /api/admin/agent-groups/:id`、`PUT /api/admin/agent-tags/:id` | 修改 Agent 分组或标签 |
| `DELETE /api/admin/agent-groups/:id`、`DELETE /api/admin/agent-tags/:id` | 删除 Agent 分组或标签 |
| `PUT /api/admin/agents/:id/taxonomy` | 设置机器 `group_id` 和 `tag_ids` |

下发远程指令要同时满足功能开关、机器能力和在线状态。动作只有 `re_report`、`check_update`、`restart`、`upgrade`。单机请求体为 `{ "action": "re_report" }`，返回的 `id` 是指令 ID；接受入队不代表执行成功。Worker 返回 202，Go 返回 200。批量请求用 `{ "ids": ["机器 UUID"], "action": "re_report" }`；Worker 最多接受 100 个去重后的 ID，Go 最多接受 500 个。检查 `results` 里每台机器的结果。字段和限制见 [Agent 手册](agents.md#远程配置与指令)。

读到运行配置后，保存时提交 `{ "expected_revision": "读取到的 desired_revision", "config": { ... } }`。首次版本可能为 `null`；`config` 必须包含七个运行字段。响应里的 `revision` 是期望版本，只有 Agent 上报匹配结果后才代表已经应用。状态为 `unreported`、`pending`、`synced` 或 `error`。关闭远程功能返回 403 `commands_disabled`；配置未上报或版本冲突分别返回 409 `agent_config_unsupported` 和 `agent_config_conflict`。

Agent 创建时可以带 `is_public` 布尔值，默认 `true`；显式传 `false` 时保持隐藏。机器页关闭时仍可省略这个字段登记机器，公开展示须等机器页启用。Worker 传这个字段时要求机器页已启用；Go 在设成 `true` 时要求启用。关闭机器页后，批量公开状态写入返回 409 `agent_page_disabled`，已保存状态保留。Agent 分组和标签的管理写操作也要求机器页启用；分类和监控分类独立。

统一分组管理接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/groups` | 返回 `groups` 与 `agentEnabled`；同名两类分组合并为 `common` |
| `POST /api/admin/groups` | 创建 `{ name, weight, type }`，`type` 为 `monitor`、`agent` 或 `common` |
| `PUT /api/admin/groups/:key` | 原子更新名称、权重和类型；移除含成员的一侧须传 `confirm_membership_reset: true` |
| `DELETE /api/admin/groups/:key?scope=all` | 删除全部或 `monitor`、`agent` 单侧，成员保留并取消归组 |
| `PUT /api/admin/groups/:key/members` | `{ kind, action, ids }` 添加或移出成员；`kind` 为 `monitor` 或 `agent`，`action` 为 `add` 或 `remove`，最多 500 个 ID |

`key` 是返回值里的 `monitor:UUID` 或 `agent:UUID`，作为路径段时要编码。通用分组的两侧变更在同一个事务里完成。添加操作只接受未分组成员，已归组会返回 409 `group_members_assigned`，不会自动转移；移出操作只影响当前分组成员。未确认的有损类型转换返回 409 `group_members_reset_required`。机器页关闭时，只能管理监控分组。

## 通知与设置

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/notifications` | 渠道配置，管理权限可见敏感字段 |
| `POST /api/notifications` | 创建渠道 |
| `PUT /api/notifications/:id` | 修改渠道 |
| `DELETE /api/notifications/:id` | 删除渠道 |
| `POST /api/notifications/:id/test` | 发送真实测试通知 |
| `GET /api/notifications/stats` | 渠道投递统计 |
| `GET /api/notifications/deliveries` | 投递记录 |
| `GET /api/admin/settings` | 设置及元数据 |
| `PUT /api/admin/settings` | 提交设置键值对象 |
| `DELETE /api/admin/settings/:key` | 恢复某键默认值 |
| `GET /api/admin/usage` | 当前用量视图 |

创建通知渠道的主要字段是 `name`、`type`、`config`、`active`、`group_ids`。`config` 里的字段见[通知指南](notifications.md#渠道字段)，设置更新示例见[配置参考](configuration.md#通过-api-修改设置)。

`alerts.maintenanceWindows` 最多 32 个窗口，由 `maintenance.scheduleEnabled` 控制是否生效。每周窗口为 `{ kind: "weekly", day, start, end }`；单次窗口为 `{ kind: "once", startsAt, endsAt }`，使用完整 UTC 时间且不重复。`maintenance.enabled` 控制优先级更高的手动维护。`maintenance.announcementTitle`、`maintenance.announcementDescription` 配置开始前的公告；`maintenance.title`、`maintenance.description` 配置维护页面。标题最多 120 字符，正文最多 1000 字符；留空用默认文案，关开关会保留内容。时间格式见[配置参考](configuration.md#维护窗口格式)。

`config.language` 指定该渠道的消息语言，例如 `zh-CN`；省略时默认 `en-US`。取值和消息范围见[消息语言](notifications.md#消息语言)。测试通知和自动通知使用同一套语言设置；更新 `config` 时要提交完整配置。

测试发送要看响应体里的 `ok` 和 `error`，不能只看 HTTP 200 就判定投递成功。渠道不存在时，Worker 返回 HTTP 200 和 `{ "ok": false, "error": "not_found" }`，Go 返回 404 `not_found`。测试会真实外发，并写入投递记录。

## 主题管理

安装、预览和删除的端点见[主题指南](themes.md)。已安装主题可以直接应用到它声明的页面类型，顶部看板显示当前主题；选项在对应看板里配置，保存后立即生效。管理接口需要认证。

## 运维触发

Worker 的 `GET /api/admin/version` 需要管理认证，返回 `{ tag, checkedAt }`：`tag` 是最新正式版本标签或 `null`，`checkedAt` 是实际查询时间的 Unix 毫秒数。默认复用 6 小时内的结果；传 `?refresh=1` 时，仅复用最近 1 分钟的结果。限流返回 429 `version_rate_limited` 及 `Retry-After`；查询超时返回 502 `version_timeout`，其他上游故障返回 502 `version_unavailable` 或 `version_invalid_response`。此接口只检查版本，不部署更新。

`POST /api/cron/tick` 请求常规检查，`POST /api/cron/sync` 请求汇总与清理；两者都需要管理认证。

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/cron/tick' \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

这些请求可能执行真实探测和通知，不是没有副作用的健康检查。调度出故障时先查原因，不要用高频外部调用绕过系统检查间隔和并发控制。

## 错误处理

错误通常以 JSON 返回稳定的业务码：

```json
{ "error": "invalid_settings", "failures": [{ "key": "unknown", "error": "unknown_key" }] }
```

| HTTP 状态 | 常见含义 | 调用方处理 |
| --- | --- | --- |
| 400 | 请求体或字段不合法 | 检查业务码与字段，修改请求 |
| 401 | 未登录、凭据错误或过期 | 重新登录或核对管理密钥 |
| 403 | 功能或权限条件不满足 | 核对操作条件 |
| 404 | 对象或 Token 不存在 | 核对当前环境和标识 |
| 405 | HTTP 方法错误 | 按端点要求切换方法 |
| 409 | 当前资源状态冲突 | 检查版本、能力或运行状态 |
| 413 | 请求或包过大 | 减小上传体积 |
| 429 | 触发限制 | 稍后重试，避免并发重放 |
| 5xx | 数据库、部署依赖、制品或外部服务异常 | 查业务码和服务端日志 |

不要只看状态码猜结果，也不要在解析 JSON 前忽略实际的 `Content-Type`。接口返回 HTML，通常是代理、路径或 SPA 回退配置的问题。

写请求失败不要无条件重放，尤其是创建、立即检查、测试通知、主题安装和远程指令。先确认服务端有没有已经接受操作。用户界面应把业务码映射到对应翻译，不要直接显示 HTML、堆栈或原始敏感异常。

## 外部订阅

以下管理接口需要管理员认证。列表使用 `offset`、`limit` 分页，默认 50、最多 200，返回 `items`、`total` 和 `nextOffset`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/subscription-catalog` | 官方与本地配置目录 |
| `POST /api/admin/subscription-catalog/refresh` | 刷新官方目录，受限频保护 |
| `GET /api/admin/subscription-catalog/:templateId` | 读取配置描述 |
| `POST /api/admin/subscription-configs/import` | 传 `{url}` 或 `{descriptor}` 导入本地配置 |
| `DELETE /api/admin/subscription-configs/:configId` | 移除本地库条目 |
| `POST /api/admin/subscription-configs/preview` | 传 `{templateId,parameters}` 或 `{descriptor,parameters,sourceUrl?}` 读取预览 |
| `GET /api/admin/subscription-previews/:previewId` | 轮询预览结果；有效期 10 分钟 |
| `GET /api/admin/subscriptions` | 按 `category`、`q`、`health`、`archived` 筛选 |
| `POST /api/admin/subscriptions` | 从预览创建，传 `requestId`、`previewId`、`name`、`category`、`selectedIds` |
| `GET/PATCH/DELETE /api/admin/subscriptions/:id` | 读取、编辑、删除；写入携带 `revision` |
| `GET /api/admin/subscriptions/:id/icon` | 读取订阅来源的网站图标，须启用站点图标同步 |
| `GET/PATCH /api/admin/subscriptions/:id/items` | 读取、批量编辑条目；写入 `{items:[{id,revision,…}]}`，最多 100 项，返回逐项结果 |
| `POST /api/admin/subscriptions/:id/sync` | 立即同步，返回任务 ID |
| `GET /api/admin/subscription-runs/:runId` | 轮询同步状态与阶段 |
| `GET /api/admin/subscriptions/:id/runs` | 读取近期同步记录 |
| `GET /api/admin/subscriptions/:id/config` | 读取已保存描述及非敏感参数 |
| `GET /api/admin/subscriptions/:id/config/export` | 导出 JSON 描述 |
| `POST /api/admin/subscriptions/:id/config/check-update` | 检查配置更新 |
| `POST /api/admin/subscriptions/:id/config/preview` | 传 `revision`、描述、参数生成更新预览；`rollback:true` 预览上一版 |
| `PUT /api/admin/subscriptions/:id/config` | 传 `revision`、`previewId` 应用预览 |

`category` 是 `website` 或 `model`。创建还可传 `intervalSec`、`staleAfterSec`、`isPublic`、`autoSubscribe`、网站 `groupId` 和 `notifications`。预览和同步返回 202，需轮询到状态不再为 `running`。预览不修改历史和通知；同步会更新状态。重复创建使用相同 `requestId` 可避免产生两个订阅。

订阅列表另返回 `summary`，包含 `total`、`items`、`healthy`、`partial`、`failed`、`paused`、`archived`。汇总遵循 `category` 和 `archived`，不受搜索、状态筛选或分页影响；`items` 是已订阅且未移除的条目数。列表与详情都返回当前 `statusCounts`。

条目身份变化时，应用请求还需 `confirmIdentityChange:true`。`identityMappings:[{itemId,sourceItemId}]` 显式关联旧条目和新 ID；未关联的旧条目归档。更新预览必须属于当前订阅和 `revision`。

`notifications` 包含 `monitor`、`sync`，每项有 `notificationEnabled`、`notificationChannelIds`，`sync` 另有 `afterSec`。新订阅默认均关闭。普通监控在 `options_json`、AI 渠道在本体上使用相同的通知开关和渠道字段。`POST /api/notifications/resolve` 接受事件来源、类型、对象及通知策略，返回有效渠道、排除原因和静默状态，不会发送消息。

公开接口为 `GET /api/public/subscriptions/items?category=website` 和 `GET /api/public/subscriptions/items/:id/history`；支持 `pageId` 页面范围。模型类别使用 `model`。响应只包含公开条目、来源、有效性、观测及可用率，不能从中读取接口配置或凭据。使用与备份方法见[订阅指南](subscriptions.md)。

`GET /api/public/subscriptions/icons/:id` 返回订阅来源图标。订阅必须公开、未归档，并至少包含一个公开且已订阅的条目；类别须符合当前页面范围。图标接口不接受任意目标地址，且遵循 `site.syncMonitorIcons`。服务端缓存成功结果 7 天、未找到结果 1 小时，每次读取仍会检查权限。

## API reference

This reference describes endpoints, authentication and request fields for integrations and automation.

### Authentication and identifiers

Management endpoints accept a signed-in session cookie or a bearer token: Worker uses `ADMIN_TOKEN`; Go uses `POLARIS_ADMIN_TOKEN`. Keep tokens in protected storage, not browser bundles or logs. Sessions are scoped to the current hostname. Monitor `id` is a UUID for management, while `num_id` identifies public details. Push and Agent tokens are separate per-object credentials. `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout` and the initial `POST /api/auth/setup` handle access; there is no open registration endpoint.

### Setup database contract

`GET /api/auth/session` returns `setupDatabase` when `needsSetup` is `true` (a Worker without D1 offers only `postgres` and defaults to it), and `null` after setup. It never returns a database URL.

While `needsSetup` is `true`, the Worker also returns `setupRequirements` (an array; `null` after setup, and absent on the Go backend). Each entry is `{ key, required, ok }`:

| `key` | `required` | Meaning |
| --- | --- | --- |
| `database` | `false` | `DB` (D1) is bound; a missing binding does not block the next step. The setup form validates database selection and connection configuration |
| `config` | `true` | `CONFIG` (KV) is bound; stores the database selection and encrypted connection URL |
| `adminToken` | `true` | `ADMIN_TOKEN` is configured |
| `themes` | `false` | `THEMES` (R2 theme storage) is bound |
| `analytics` | `true` | `UPTIME` (Analytics Engine) is bound |
| `analyticsSql` | `false` | `ANALYTICS_SQL` is bound for history queries; missing it leaves live monitoring available but disables AE history reads and daily archives |

Without a configured database, the Worker still returns database options and allows the setup form to open. Other pages redirect to `/setup`; business APIs return 503 `setup_required`, or `deployment_incomplete` if required deployment items are missing. `POST /api/auth/setup` returns 503 `deployment_incomplete` without `UPTIME`, 400 `invalid_database_url` without a usable PostgreSQL connection, or 400 `invalid_database_type` when selecting an unbound D1 database. Read the session again after adding a binding to update both the check and database options.

| `setupDatabase` field | Type | Meaning |
| --- | --- | --- |
| `types` | `("d1" \| "sqlite" \| "postgres")[]` | Database types supported by this backend: D1 / PostgreSQL for Worker, SQLite / PostgreSQL for Go |
| `defaultType` | `"d1" \| "sqlite" \| "postgres"` | Default selection for setup |
| `postgresConfigured` | `boolean` | Whether the current PostgreSQL connection can be reused; no connection address is exposed |
| `postgresUrlEditable` | `boolean` | Whether a new PostgreSQL URL may be submitted: editable on Worker with `CONFIG` KV bound, locked once account writing starts; always `true` on Go |
| `configurationId` | `string`, optional | Currently readable KV configuration identifier for confirming propagation; contains no URL |

`POST /api/auth/setup/database` is the Worker-only database step. It accepts `{ credential, database: { type, url? } }`, verifies the connection, initializes an empty database, and saves the configuration. It returns `{ ok: true, type, configurationId? }` without creating an account. Page-entered PostgreSQL URLs are encrypted in `CONFIG` KV; setup leases and account-write state remain in the target database. When an identifier is returned, wait until the session reports the same `configurationId` before opening the account step. Poll the session during propagation rather than rewriting the configuration.

`POST /api/auth/setup` accepts `credential`, `username`, `password` and an optional `database` selection. The final step can submit only the verified type to reuse the saved connection, or a new URL when `postgresUrlEditable` permits it. Omitting the selection retains the current configuration. Success creates the administrator and session in the target database; subsequent requests and restarts use the saved selection.

A verified database can be changed until account creation starts. Once account writing begins, the type and URL are locked and `postgresUrlEditable` is `false`. Resume with the original username and password. Business APIs remain blocked while setup is pending; a lease expires after at most ten minutes.

| HTTP | Setup error | Action |
| --- | --- | --- |
| 400 | `invalid_database_type` | Select a type supported by the backend |
| 400 | `invalid_database_url` | Check the PostgreSQL URL |
| 503 | `deployment_incomplete` | The Worker is missing `UPTIME`; add the Analytics Engine binding in the dashboard first |
| 503 | `credential_unconfigured` | No setup credential is configured (Worker `ADMIN_TOKEN` or Go `POLARIS_SETUP_KEY`) |
| 503 | `database_connection_failed` | Check database connectivity and access |
| 503 | `database_initialization_failed` | Check target database initialization requirements |
| 503 | `database_configuration_failed` | Check deployment database configuration |
| 409 | `setup_in_progress` | Wait for the current setup and read the status again |
| 409 | `setup_complete` | The instance is initialized; use login |

Errors omit underlying connection details and URLs. Keep database URLs and setup credentials out of public logs and screenshots.

### Public reads and presentation

`GET /api/capabilities` describes the runtime, probe types, intervals and theme storage. Public reads include `/api/public/health`, `/status`, `/status/detail`, `/config`, `/maintenance`, `/monitors`, `/monitors/:numId`, `/agent/detail/:numId`, `/servers`, `/servers/:id`, `/theme`, `/icon` and `/monitor-icon?id=:numId` under `/api/public`. Visibility and the current presentation domain restrict the objects returned; disabled machine pages return 404 for server reads. Anonymous eligible Worker responses can be cached for 15 seconds. Maintenance is `no-store`; its `source` is `manual`, `scheduled` or `null`, with UTC ISO 8601 window times.

Worker history responses include `history_status` (`ready`, `unconfigured` or `unavailable`) and `history_sampled`. Monitor detail separates the exact recent check `ring` from AE latency `history`. Agent `buckets` and enabled server `history` also read from AE. A successful empty result is `ready`. `unconfigured` means the `ANALYTICS_SQL` binding is missing, and `unavailable` means the read failed temporarily; failed history reads retain live data. Missing metrics remain `null`. Agent management detail additionally returns database-backed `history_daily` and `history_daily_sampled` for archived resource summaries. These fields do not change Go's database-backed history contract.

Agent reports must retain `load.load1`, `load.load5`, `load.load15`, `connections.tcp`, `connections.udp` and `process`. Send `null` when a metric cannot be collected; `0` represents a measured zero. Worker and Go apply the same rule.

Public heartbeat states are `0` DOWN, `1` UP, `2` WARN and `4` PENDING; missing latency is `null`. Worker supports HTTP, TCP, UDP, ICMP, Push and Agent monitors; Go also supports DNS, TLS and WebSocket. Consult capabilities for the current runtime and probe availability.

`GET` and `PUT /api/admin/presentation` read and replace the presentation configuration using `revision` for concurrency. A stale revision returns 409 `presentation_conflict`. `agentEnabled` controls machine-page routing. `aiEnabled` controls AI checks, calls and public access; disabling preserves configuration and history. `aiOnMonitorPage` controls main-page inclusion independently of the AI page. Page and domain kinds include `monitor`, `agent` and `ai`. Enter domain mappings manually after configuring DNS and binding the domain to the Worker or server. Authenticated `preview=monitor`, `preview=agent` or `preview=ai` does not use shared cache. Theme installation, configuration and preview are covered in [the theme guide](themes.md#english).

### Monitors and Push

Management uses `GET` and `POST /api/monitors`, `PUT` and `DELETE /api/monitors/:id`, `POST /api/monitors/:id/check`, and `POST /api/monitors/check`. Creation returns 201 and `id`; a Push monitor also returns `push_token`. An Agent monitor references an existing `agent_id` and does not create a machine. Common fields include `name`, `type`, `target`, `interval_sec`, `timeout_ms`, `is_public`, `group_id`, `tag_ids` and type-specific `options_json`. Worker intervals are 60–86400 seconds and timeouts 1000–60000 ms; Go intervals are 5–86400 seconds and timeouts 100–120000 ms. Query capabilities before presenting choices.

`POST /api/monitors/visibility` accepts `{ "ids": ["UUID"], "is_public": false }` for 1–500 monitors. Any missing ID rejects the change. HTTP options can include headers, authentication, JSON matching and `check_source`. Native source types are `worker` and `server` for the respective runtime; an Agent source uses `{ "type": "agent", "agent_id": "UUID" }`. Worker UDP and ICMP require an online Agent with the relevant capability. Immediate checks reject paused, Push, Agent-host and Agent-source monitors.

Creating a Push monitor returns `id` and `push_token`; ordinary edits preserve and return the current key. Switching away from Push revokes the key, and switching back generates a new one. Send heartbeats with `POST /api/public/push/:id`, an `Authorization: Bearer <push_token>` header, and JSON such as `{"status":1,"message":"job-ok"}`. Status must be the integer `0` (down), `1` (up), or `2` (warning); omitted status or an empty body defaults to `1`. The optional `message` accepts up to 200 Unicode characters. Invalid JSON, invalid status, oversized messages, unknown fields, and URL query parameters are rejected. Success returns 200 and `{"ok":true}`. Missing or invalid keys, unknown monitors, paused monitors, and non-Push monitors return 401. Non-empty bodies require `Content-Type: application/json` (415 otherwise), with a 4096-byte limit (413 when exceeded). GET returns 405 without recording a heartbeat. Keep the key private and the scheduler running to detect missed heartbeats. Push does not measure latency.

### AI channels and models

Authenticated AI management uses `/api/admin/ai/channels` and `/api/admin/ai/models`: `GET` lists, `POST` creates, and `GET`, `PUT`, `DELETE` on `/:id` read, update and delete. Channel writes use `{ name, baseUrl, protocol: "openai", apiKey? }`; creation requires the key, while omitting it on update preserves it. Reads return `hasApiKey`, never the key or ciphertext. Deleting a channel also deletes its models.

The required `protocol` accepts `openai` (Chat Completions), `openai_responses`, `anthropic` or `gemini`. `baseUrl` includes the version prefix, without a generation path. Gemini model IDs must be bare names without `models/`, beginning with a letter or digit and containing only ASCII letters, digits, dots, underscores and hyphens. Invalid IDs, including existing IDs incompatible with a switch to Gemini, return 400 `invalid_ai_model_id`. Protocol changes update the channel revision. See [protocol and address examples](ai-monitoring.md#add-a-channel-and-model).

Channel writes may include string-valued `headers`, without an entry-count limit and with a 64 KiB encoded JSON limit. Values are encrypted. List and write responses expose only `headerNames`; authenticated `GET /api/admin/ai/channels/:id` also returns decrypted `headers` for editing. API keys and ciphertext are never returned. Omitting headers preserves them; an empty object clears them. Protocol-managed authentication, routing, cookies and connection-control headers cannot be overridden. Invalid headers return 400 `invalid_ai_headers`.

Base URLs accept HTTP, HTTPS, localhost, container service names and private hosts, while rejecting URL credentials, queries, fragments and cloud metadata endpoints. Reachability depends on the backend network; a cloud Worker's localhost is not the user's computer.

Model writes use the fields in the JSON example above. The optional `request` contains `prompt` (up to 2000 characters), `maxOutputTokens` (integer 1–4096) and `expectedText` (up to 200 characters). Creation defaults to Reply OK., 64 tokens and no expected text. Omitting it on update preserves the saved options. Expected text uses a case-sensitive substring match; mismatches produce `response_mismatch`, invalid options return 400 `invalid_ai_request`. Disabled AI monitoring rejects manual calls with 409 `ai_disabled`. Public access is available on the independent AI page (`view=ai`) or the main page when enabled by presentation settings. Updates send the full configuration and the current `revision`. AI channel writes accept `notificationChannelIds`, up to 32 existing notification channel IDs, shared by all models in that channel. Omitting it on update preserves the selection; `[]` uses enabled global channels with no group restriction. A nonempty selection overrides group scope. The field is returned on channels, not models. Ordinary monitors use `options_json.notificationChannelIds`; an empty selection follows the global group rules. Deletions send `{ revision }`. Model list entries include `live` scheduled state.

Optional `request.body` is a JSON object of up to 64 KiB and 32 nesting levels. It merges recursively into the protocol defaults; arrays replace their defaults and `{}` clears overrides. The form controls model ID, non-streaming mode and output limits; Responses always sets `store: false`. If OpenAI overrides contain `max_completion_tokens`, that parameter carries the form's output limit instead of `max_tokens`. Public responses exclude headers, prompts and custom bodies.

`POST /api/admin/ai/channels/:id/test` accepts `{ revision }` and tests model listing without text generation. `POST /api/admin/ai/models/:id/check` requires `{ revision, channelRevision, confirmPaid: true }`. Manual checks may incur charges and do not update scheduled history or availability. On a 409 `revision_conflict`, reread the configuration rather than overwriting it. A revision change during an upstream call can produce a conflict after the call has already incurred a charge.

Every edit updates the concurrency `revision`. Probe versions are separate: name, visibility, notification selection and pause changes preserve the latest result and recent checks. Endpoint, protocol, credentials, custom headers, model ID, interval, timeout and request changes require a new observation. `live.revision` and `live.channelRevision` identify probe configuration; do not submit them as edit or delete revisions.

Admin and public model responses include `recent`: up to 60 scheduled observations, oldest first, each containing `{ checkedAt, outcome, latencyMs, statusCode }`. Manual and skipped checks are excluded. No observations yields `[]`; missing checks are not invented.

`GET /api/admin/ai/channels/:id/models` returns `{ models: [{ id, name }], fetchedAt }` using the channel's authentication and custom headers without generating text. It handles all four protocols, follows cursor pagination and deduplicates IDs. Gemini IDs omit `models/`; models explicitly lacking `generateContent` are excluded. The complete read is bounded to 15 seconds, 10 pages, 10000 models and 2 MiB. Upstream failures and exceeded limits return 502 `{ error: "ai_models_unavailable", outcome }`, never a partial list presented as complete. Missing channels return 404; concurrent channel edits return 409.

`GET /api/admin/ai/models/:id/history?days=7` returns `{ modelId, days, points, detailStatus, sampled }`, accepting 1–90 days. Daily summaries use exact check counts; sampling applies only to details. `unconfigured` or `unavailable` details do not invalidate readable daily summaries.

The range covers `days` UTC calendar dates including today, matching the 7/30/90-day selector. Details contain at most the latest 100 observations in that range.

Anonymous reads use `/api/public/ai/models`, `/api/public/ai/models/:id` and `/api/public/ai/models/:id/history?days=7`. Only enabled public models are readable; other models return 404. Public responses exclude channel URLs, credentials, requests and provider response bodies. See [AI monitoring](ai-monitoring.md#english).

Public models include `channel: { id, name }` for grouping and search; admin models also include `channelName`. Channel names are public and must not contain sensitive information. Only channels belonging to readable models appear; no anonymous channel-directory endpoint is provided.

### Worker Queue

Worker-only authenticated endpoints are `GET /api/admin/check-queue`, `POST /api/admin/check-queue/probe` with `{ revision }`, and `PUT /api/admin/check-queue` with `{ revision, enabled }`. They return the status object directly. `bound`, `enabled`, `canEnable`, `schema`, `revision`, `verification` and processing/backlog fields describe the current state.

A 202 probe response means accepted, not verified. Poll until `verification.state` becomes `passed`, `timed_out` or `failed`, respecting `verification.expiresAt`. Probes do not call monitoring targets. Enable only when `canEnable=true`; expired verification requires another probe. On revision conflict, reread rather than overwriting. Pending tasks are application records, not the Cloudflare message count. Go does not provide this feature. See [Worker Queue](queue.md#english).

### Agent management

Create a machine with `POST /api/admin/agents`; the 201 response contains `id` and its secret `token`. The optional `is_public` boolean defaults to `true`; set it to `false` to keep the machine hidden. Public display also requires the machine page to be enabled. `GET /api/admin/agents` lists machines; `GET /api/admin/agents/:id/detail` reads details. The `rename`, `active` and `probe` subroutes accept `{ name }`, `{ active }` and `{ enabled }` respectively. `POST /api/admin/agents/visibility` changes public visibility for up to 500 IDs when the machine page is enabled. Deleting an Agent still referenced by a monitor returns 409 `agent_in_use`.

`GET` and `PUT /api/admin/agents/:id/config` read and submit the complete seven-field runtime configuration. Submit `expected_revision` from `desired_revision`; a saved revision is not applied until the Agent acknowledges it. States are `unreported`, `pending`, `synced` and `error`. A conflict returns 409 `agent_config_conflict`; reload before merging changes.

`POST /api/admin/agents/:id/commands` accepts `{ "action": "re_report" }`; supported actions are `re_report`, `check_update`, `restart` and `upgrade`. Worker returns 202 and Go 200 when queued. Query `GET /api/admin/agents/:id/commands` for the outcome. Batch requests use `ids` and `action`; inspect each result. The Worker limit is 100 deduplicated IDs and the Go limit is 500. The feature switch, Agent capability and online status gate commands; the Agent also checks whether restart or upgrade is safe. Installation, rollback and configuration details are in [the Agent guide](agents.md#agent-guide).

Agent installation downloads `install.sh` or `install.ps1` from the Agent GitHub repository and passes the site endpoint as an argument. The script queries GitHub and downloads the latest stable binary on the target machine. The separate `/api/public/agent/manifest`, `/api/public/agent/download/:file` and `/api/public/agent/capabilities` release endpoints are not prerequisites for installation or reinstallation. Agent reporting, jobs and configuration use a machine token even though their paths contain `public`; never log those URLs. Agent groups and tags are separate from monitor groups and tags. Unified group management is under `/api/admin/groups`; destructive membership changes require `confirm_membership_reset: true`.

### External subscriptions

The subscription management endpoints in the table above require administrator authentication. List responses use `items`, `total`, `nextOffset`, with `offset` and `limit` (default 50, maximum 200). Categories are `website` and `model`.

Subscription lists also return `summary` with `total`, `items`, `healthy`, `partial`, `failed`, `paused`, and `archived`. Counts respect category and archive scope, independently of search, health filters, and pagination. `items` counts selected, nonremoved items. List and detail responses include current `statusCounts`.

Import an HTTPS JSON URL or descriptor, create a preview, and poll its ID until it leaves `running`. Create with `requestId`, `previewId`, `name`, `category`, and source `selectedIds`. Reusing `requestId` makes creation idempotent. Updates and deletion require the current `revision`. Item batches carry each item's `id` and `revision` and return individual results.

Configuration changes require a preview bound to the subscription and revision. Identity changes also require `confirmIdentityChange:true`; `identityMappings:[{itemId,sourceItemId}]` explicitly preserves associations. Unlinked old items are archived. `rollback:true` previews the previous descriptor.

Public lists use `GET /api/public/subscriptions/items?category=website` (or `model`), with optional `pageId`. Public history uses `/api/public/subscriptions/items/:id/history`. Visibility and page scope apply to both endpoints. Responses exclude descriptors and credentials.

Source icons use `/api/admin/subscriptions/:id/icon` or `/api/public/subscriptions/icons/:id`. Both require `site.syncMonitorIcons`. Public icons additionally require an unarchived public subscription with a selected public item in the current page's category. Targets come from the saved source, never a request parameter. Server caches last seven days for icons and one hour for misses; access is checked on every request.

### Notifications and operations

Worker administrators can read `GET /api/admin/version` for `{ tag, checkedAt }`, where `tag` is the latest stable tag or `null` and `checkedAt` is the upstream check time in Unix milliseconds. The cache lasts six hours; `?refresh=1` reuses only results from the last minute. Rate limits return 429 `version_rate_limited` with `Retry-After`. Timeouts return 502 `version_timeout`; other upstream failures return 502 `version_unavailable` or `version_invalid_response`. This read does not deploy an update.

`GET` and `POST /api/notifications`, `PUT` and `DELETE /api/notifications/:id`, `POST /api/notifications/:id/test`, and the `/stats` and `/deliveries` reads manage channels. Channel `config.language` defaults to `en-US`; its supported values and provider fields are in [the notification guide](notifications.md#notification-guide). Updating `config` replaces the object. A test sends a real message: inspect response `ok` and `error`, not HTTP 200 alone. A missing test channel returns HTTP 200 with `ok: false` on Worker and 404 on Go.

Settings use `GET` and `PUT /api/admin/settings` and `DELETE /api/admin/settings/:key`. Manual `POST /api/cron/tick` and `/api/cron/sync` need management authentication and can perform real work; they are not health checks. The [operations guide](operations.md#operations-guide) covers backup, upgrades and recovery.

Errors normally contain an `error` code. Handle 400 by correcting the input, 401 by checking authentication, 403 by checking permissions or feature switches, 404 by checking the object, 409 by resolving state conflicts, 413 by reducing request size, and 429 by retrying later. Investigate 5xx responses in server logs. Do not blindly replay writes; first determine whether the server accepted them.

### 主题页面自定义内容 / Theme page custom content

管理员通过 `GET /api/admin/presentation` 和 `PUT /api/admin/presentation` 读取和保存完整配置与 `revision`。各页面的 `headCode`（最多 16 KiB UTF-8）插入公开页面的 head；内置页面通过公开配置的 `theme_head_code` 读取，安装主题由服务端注入入口 HTML。`contentHtml`（最多 32 KiB UTF-8）通过 `theme_content_html` 提供，内置页面显示在正文下方，安装主题由内容插槽渲染。`theme: null` 使用内置主题，`themeOptions` 支持强调色、圆角、宽度、布局等选项，详见[主题指南](themes.md#配置选项)。配置属于当前页面和主题版本，手动切换或删除主题时清空；更新同一主题包会将页面切换至新版，并保留仍有效的选项、头部代码和自定义 HTML。代码和内容对访客公开，代码可在本站执行，请勿填写凭据，仅使用可信代码。

Authenticated administrators use `GET /api/admin/presentation` and `PUT /api/admin/presentation` with the complete configuration and `revision`. Per-page `headCode` (16 KiB UTF-8 maximum) is inserted into the public page head. Built-in pages read it from `theme_head_code`; installed themes receive it in their entry HTML. `contentHtml` (32 KiB UTF-8 maximum) is exposed as `theme_content_html`, rendered below the main content on built-in pages or in the installed theme’s content slot. `theme: null` selects the built-in theme, with `themeOptions` for accent color, radius, width, layout and other options described in the [theme guide](themes.md#english). Values belong to the exact applied page and theme version and are cleared on switching or deletion. Both are public; code can execute on the site. Never include credentials and use trusted code only.
