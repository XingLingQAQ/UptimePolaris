# API 参考

[English](#api-reference)

本文列出集成和自动化会用到的接口、认证方式和请求字段。

## 目录

- [认证与标识](#认证与标识)
- [公开读取](#公开读取)
- [公开展示设置](#公开展示设置)
- [管理监控](#管理监控)
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
| `adminToken` | `true` | 已配置 `ADMIN_TOKEN` |
| `themes` | `false` | 已绑定 `THEMES`（R2 主题存储） |
| `analytics` | `true` | 已绑定 `UPTIME`（Analytics Engine） |

Worker 尚未配置数据库时，仍返回选库选项并允许进入初始化表单；其他页面请求重定向到 `/setup`，业务 API 返回 503 `setup_required`，若部署必需项未通过则返回 `deployment_incomplete`。`POST /api/auth/setup` 在缺少 `UPTIME` 时返回 503 `deployment_incomplete`；没有可用的 PostgreSQL 连接时返回 400 `invalid_database_url`，选择未绑定的 D1 时返回 400 `invalid_database_type`。补绑后重新读取会话即可更新检查结果和数据库选项。

| `setupDatabase` 字段 | 类型 | 含义 |
| --- | --- | --- |
| `types` | `("d1" \| "sqlite" \| "postgres")[]` | 当前可选的初始化数据库类型；Worker 绑定 D1 时为 D1 / PostgreSQL，未绑定时只有 PostgreSQL；Go 为 SQLite / PostgreSQL |
| `defaultType` | `"d1" \| "sqlite" \| "postgres"` | 初始化页面的默认类型 |
| `postgresConfigured` | `boolean` | 当前 PostgreSQL 连接是否可供复用，不包含连接地址 |
| `postgresUrlEditable` | `boolean` | 是否允许提交新的 PostgreSQL URL；Worker 有 D1 或配置存储时可编辑，账号写入开始后锁定；Go 为 `true` |

`POST /api/auth/setup/database` 仅用于 Worker 的第二步，接受 `{ credential, database: { type, url? } }`，验证连接、初始化空库并保存加密配置，返回 `{ ok: true, type }`，不创建账号。未绑定 D1 时使用 `SETUP_CONFIG` Durable Object；已绑定 D1 时使用 D1 控制记录。

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

## 公开展示设置

以下接口需要管理认证：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/presentation` | 读取生效配置 `config` 和并发控制用的 `revision` |
| `PUT /api/admin/presentation` | 提交完整 `config` 和读取到的 `revision`，保存后立即生效 |
| `GET /api/admin/presentation/domains?service=服务名` | Worker 查询指定服务已绑定的域名；需要 Cloudflare 凭据。Go 返回 `runtime_unsupported` |

展示设置只有一份生效配置。`revision` 变了会返回 409 `presentation_conflict`，这时重新读取并合并修改。配置包含 `agentEnabled`、`workerService`、`domains` 和 `pages`；域名项为 `{ hostname, page }`，添加后立即生效，没有逐项开关。每个页面保存 `theme`、`themeOptions`，以及可选的 `headCode` 和 `contentHtml`，约束见[主题页面自定义内容](#主题页面自定义内容--theme-page-custom-content)。域名查询只读 Cloudflare 绑定，DNS 和 Worker 域名绑定要先在部署侧完成。

`agentEnabled` 为 `false` 时，独立页面设置和 Agent 公开控制隐藏，所有域名映射停止生效，所有域名都显示监控页。重新开启后，已保存的映射和机器公开选择恢复。

主题预览请求带 `preview=monitor` 或 `preview=agent` 时，需要管理会话或 `ADMIN_TOKEN`，并使用当前配置里对象的公开状态。预览响应不进共享缓存；匿名请求预览返回 401。各页面的主题和选项分别保存在 `pages.monitor` 和 `pages.agent`，安装、配置和预览方法见[主题指南](themes.md)。

## 管理监控

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/monitors` | 管理监控列表，含管理所需配置 |
| `POST /api/monitors` | 创建监控 |
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

## Push 接入

```sh
curl --fail-with-body -X POST \
  'https://status.example.com/api/public/push/PUSH_TOKEN?status=1&msg=job-ok'
```

- `status=0` 异常、`status=2` 警告，其他值正常。
- `msg` 最多 200 字符，要正确做 URL 编码。
- `ping` 只是接收到的上报元数据，UI 不会把它当成系统测得的延迟。
- GET 返回 405，不能上报。
- 无效 Token 返回错误，不会创建新监控。

要定期发心跳，并让正常调度一直运行，才能在停报后判断超时。完整场景见[使用手册](usage.md#push-监控)。

## Agent 接入

通常使用官方 Agent，不建议手写采集协议。下载和能力端点：

| 路径 | 用途 |
| --- | --- |
| `/install.sh`、`/install.ps1` | 短安装命令入口 |
| `/api/public/agent/manifest` | 已验证的最新 GitHub Release 清单 |
| `/api/public/agent/download/:file` | 安装脚本，或到 GitHub Release 资产的重定向 |
| `/api/public/agent/capabilities` | 最新 Release 的平台清单 |

Agent 协议用独立的机器 Token，涉及上报、WebSocket、带租约的探测任务、结果和配置交换。路径里有 `public` 不代表写操作不用认证。

管理侧常用路由：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/agents` | 机器列表 |
| `POST /api/admin/agents` | 登记机器，接收 `name` 和可选布尔值 `probe_enabled`，返回 201 `{ id, token }`，不创建监控 |
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

Agent 创建时可以带 `is_public` 布尔值，默认 `false`。Worker 传这个字段时要求机器页已启用；Go 在设成 `true` 时要求启用。关闭机器页后，批量公开状态写入返回 409 `agent_page_disabled`，已保存状态保留。Agent 分组和标签的管理写操作也要求机器页启用；分类和监控分类独立。

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
| `adminToken` | `true` | `ADMIN_TOKEN` is configured |
| `themes` | `false` | `THEMES` (R2 theme storage) is bound |
| `analytics` | `true` | `UPTIME` (Analytics Engine) is bound |

Without a configured database, the Worker still returns database options and allows the setup form to open. Other pages redirect to `/setup`; business APIs return 503 `setup_required`, or `deployment_incomplete` if required deployment items are missing. `POST /api/auth/setup` returns 503 `deployment_incomplete` without `UPTIME`, 400 `invalid_database_url` without a usable PostgreSQL connection, or 400 `invalid_database_type` when selecting an unbound D1 database. Read the session again after adding a binding to update both the check and database options.

| `setupDatabase` field | Type | Meaning |
| --- | --- | --- |
| `types` | `("d1" \| "sqlite" \| "postgres")[]` | Database types supported by this backend: D1 / PostgreSQL for Worker, SQLite / PostgreSQL for Go |
| `defaultType` | `"d1" \| "sqlite" \| "postgres"` | Default selection for setup |
| `postgresConfigured` | `boolean` | Whether the current PostgreSQL connection can be reused; no connection address is exposed |
| `postgresUrlEditable` | `boolean` | Whether a new PostgreSQL URL may be submitted: editable on Worker with D1 or configuration storage, locked once account writing starts; always `true` on Go |

`POST /api/auth/setup/database` is the Worker-only database step. It accepts `{ credential, database: { type, url? } }`, verifies the connection, initializes an empty database, and saves the encrypted selection. It returns `{ ok: true, type }` without creating an account. Configuration is saved in the `SETUP_CONFIG` Durable Object without D1, or the D1 control record with D1.

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

Public heartbeat states are `0` DOWN, `1` UP, `2` WARN and `4` PENDING; missing latency is `null`. Worker supports HTTP, TCP, UDP, ICMP, Push and Agent monitors; Go also supports DNS, TLS and WebSocket. Consult capabilities for the current runtime and probe availability.

`GET` and `PUT /api/admin/presentation` read and replace the presentation configuration using `revision` for concurrency. A stale revision returns 409 `presentation_conflict`. `agentEnabled` controls machine-page routing; disabling it retains saved selections. Worker can query bound domains through `GET /api/admin/presentation/domains?service=...` when Cloudflare credentials are configured; Go returns `runtime_unsupported`. Authenticated `preview=monitor` or `preview=agent` does not use shared cache. Theme installation, configuration and preview are covered in [the theme guide](themes.md#english).

### Monitors and Push

Management uses `GET` and `POST /api/monitors`, `PUT` and `DELETE /api/monitors/:id`, `POST /api/monitors/:id/check`, and `POST /api/monitors/check`. Creation returns 201 and `id`; a Push monitor also returns `push_token`. An Agent monitor references an existing `agent_id` and does not create a machine. Common fields include `name`, `type`, `target`, `interval_sec`, `timeout_ms`, `is_public`, `group_id`, `tag_ids` and type-specific `options_json`. Worker intervals are 60–86400 seconds and timeouts 1000–60000 ms; Go intervals are 5–86400 seconds and timeouts 100–120000 ms. Query capabilities before presenting choices.

`POST /api/monitors/visibility` accepts `{ "ids": ["UUID"], "is_public": false }` for 1–500 monitors. Any missing ID rejects the change. HTTP options can include headers, authentication, JSON matching and `check_source`. Native source types are `worker` and `server` for the respective runtime; an Agent source uses `{ "type": "agent", "agent_id": "UUID" }`. Worker UDP and ICMP require an online Agent with the relevant capability. Immediate checks reject paused, Push, Agent-host and Agent-source monitors.

Send a Push heartbeat with `POST /api/public/push/:token?status=1&msg=job-ok`. Status `0` means down, `2` warning and other values up; encode `msg` and keep it within 200 characters. `ping` is supplied metadata, not measured latency. GET returns 405. Treat the URL as a secret and keep the scheduler running to detect missed heartbeats.

### Agent management

Create a machine with `POST /api/admin/agents`; the 201 response contains `id` and its secret `token`. `GET /api/admin/agents` lists machines; `GET /api/admin/agents/:id/detail` reads details. The `rename`, `active` and `probe` subroutes accept `{ name }`, `{ active }` and `{ enabled }` respectively. `POST /api/admin/agents/visibility` changes public visibility for up to 500 IDs when the machine page is enabled. Deleting an Agent still referenced by a monitor returns 409 `agent_in_use`.

`GET` and `PUT /api/admin/agents/:id/config` read and submit the complete seven-field runtime configuration. Submit `expected_revision` from `desired_revision`; a saved revision is not applied until the Agent acknowledges it. States are `unreported`, `pending`, `synced` and `error`. A conflict returns 409 `agent_config_conflict`; reload before merging changes.

`POST /api/admin/agents/:id/commands` accepts `{ "action": "re_report" }`; supported actions are `re_report`, `check_update`, `restart` and `upgrade`. Worker returns 202 and Go 200 when queued. Query `GET /api/admin/agents/:id/commands` for the outcome. Batch requests use `ids` and `action`; inspect each result. The Worker limit is 100 deduplicated IDs and the Go limit is 500. The feature switch, Agent capability and online status gate commands; the Agent also checks whether restart or upgrade is safe. Installation, rollback and configuration details are in [the Agent guide](agents.md#agent-guide).

Agent installation and release reads use `/install.sh`, `/install.ps1`, `/api/public/agent/manifest`, `/api/public/agent/download/:file` and `/api/public/agent/capabilities`. Agent reporting, jobs and configuration use a machine token even though their paths contain `public`; never log those URLs. Agent groups and tags are separate from monitor groups and tags. Unified group management is under `/api/admin/groups`; destructive membership changes require `confirm_membership_reset: true`.

### Notifications and operations

`GET` and `POST /api/notifications`, `PUT` and `DELETE /api/notifications/:id`, `POST /api/notifications/:id/test`, and the `/stats` and `/deliveries` reads manage channels. Channel `config.language` defaults to `en-US`; its supported values and provider fields are in [the notification guide](notifications.md#notification-guide). Updating `config` replaces the object. A test sends a real message: inspect response `ok` and `error`, not HTTP 200 alone. A missing test channel returns HTTP 200 with `ok: false` on Worker and 404 on Go.

Settings use `GET` and `PUT /api/admin/settings` and `DELETE /api/admin/settings/:key`. Manual `POST /api/cron/tick` and `/api/cron/sync` need management authentication and can perform real work; they are not health checks. The [operations guide](operations.md#operations-guide) covers backup, upgrades and recovery.

Errors normally contain an `error` code. Handle 400 by correcting the input, 401 by checking authentication, 403 by checking permissions or feature switches, 404 by checking the object, 409 by resolving state conflicts, 413 by reducing request size, and 429 by retrying later. Investigate 5xx responses in server logs. Do not blindly replay writes; first determine whether the server accepted them.

### 主题页面自定义内容 / Theme page custom content

管理员通过 `GET /api/admin/presentation` 和 `PUT /api/admin/presentation` 读取和保存完整配置与 `revision`。各页面的 `headCode`（最多 16 KiB UTF-8）原样插入公开主题和预览的 head；`contentHtml`（最多 32 KiB UTF-8）通过公开配置的 `theme_content_html` 提供，由主题自行渲染。仅限当前页面和已应用的精确主题版本，切换或删除主题时清空。代码和内容对访客公开，代码可在本站执行，请勿填写凭据，仅使用可信代码。

Authenticated administrators use `GET /api/admin/presentation` and `PUT /api/admin/presentation` with the complete configuration and `revision`. Per-page `headCode` (16 KiB UTF-8 maximum) is inserted verbatim into the public theme and preview head; `contentHtml` (32 KiB UTF-8 maximum) is exposed as `theme_content_html` for the theme to render. Values belong to the exact applied page and theme version and are cleared on switching or deletion. Both are public; code can execute on the site. Never include credentials and use trusted code only.
