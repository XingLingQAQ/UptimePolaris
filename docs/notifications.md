# 通知指南

[English](#notification-guide)

监控状态变化和 Agent 资源规则会触发通知。先让监控产生正常数据，再添加渠道、发测试消息，确认分组范围对得上。

## 配置流程

1. 登录控制台，打开通知管理，新增渠道。
2. 选择类型，填写名称和该类型要求的凭据。
3. 选择消息语言和分组范围。空范围表示全部监控，包括未分组监控。
4. 保存后发送测试消息，确认目标应用收到消息，语言也正确。
5. 启用渠道，再用一次真实的监控状态变化验证范围和维护规则。

测试消息会真的发出去。测试成功只说明这一次投递有效，不代表所有分组都能触发，也不代表每台 Agent 都配了资源告警。

## 消息语言

每个渠道单独选择消息语言，支持简体中文、繁体中文（台湾、香港）、英语、日语、韩语、法语、葡萄牙语和俄语。新建渠道默认用当前界面语言；保存后各渠道独立，之后切界面语言不会改已保存的通知语言。

所选语言用于消息标题、状态、字段名称和测试内容，也用于故障、恢复、警告和后续重试。监控名称不翻译。发送前，目标地址会去掉用户信息、查询参数和片段，通常保留主机和路径。检查详情保留能拿到的故障原因，不翻译，并对目标凭据和能识别的凭据内容脱敏。Webhook 的 `text` 用所选语言，`event`、`status`、`transition` 等结构化字段保持固定格式；结构化目标和检查详情也用脱敏后的值。

通过 API 设置时，在渠道的 `config` 里填 `language`，例如 `"language": "zh-CN"`。支持 `en-US`、`zh-CN`、`zh-TW`、`zh-HK`、`ja-JP`、`ko-KR`、`fr-FR`、`pt-BR` 和 `ru-RU`，省略时默认英语。不支持的语言返回 `notification_language_invalid`。更新 `config` 会替换整个配置对象，改语言时要把该渠道的其他配置一起带上。

Telegram 消息包含监控名称、目标、类型、状态变化、建议操作和 UTC 事件时间。事件提供检查详情、响应码或延迟时，也会显示对应内容。首次读数会单独标出。

## 渠道字段

| 类型 | 必填配置 | 说明 |
| --- | --- | --- |
| Telegram | `bot_token`、`chat_id` | Bot 要有目标会话的发送权限 |
| 飞书 | `webhook_url` | 使用机器人 HTTPS Webhook |
| Slack | `webhook_url` | Incoming Webhook URL，不是普通频道名称 |
| Discord | `webhook_url` | 使用频道 HTTPS Webhook |
| Webhook | `url` | 发送 JSON；可选 `secret` 作为 Bearer 认证 |
| Apprise | `url`，以及 `key` 或 `urls` | 有状态模式用已配置的 key；无状态模式提供目标 URL 列表 |
| Server酱 | `sendkey` | 当前支持 `sctp<数字>t<令牌>` 形式的 key |

HTTP 投递地址必须是合法的 HTTPS URL。Apprise 的 `urls` 是 Apprise 自己的目标协议列表，不是 Worker 去请求的 HTTP 地址；那个地址是 `url`。不要把两个字段混用。

Webhook 的 `secret` 非空时，发送 `Authorization: Bearer <secret>`。接收方按自己的需要校验和处理 JSON。发送端会结合提供商的响应判断成功，HTTP 200 但提供商返回业务错误时仍算失败。

渠道凭据用于外部服务，不要写在公开名称、维护说明或监控消息里。管理 API 读渠道时可能带出配置，只对可信的管理脚本开放。

## 分组范围

- 范围为空：全部监控，包含未分组条目。
- 选定分组：只匹配这些分组里的监控。
- 渠道关闭：不接收正常的自动分发。

监控换组后匹配结果会变。删除分组还会删掉渠道上的关联；最后一个关联没了，渠道就变成空范围，反而覆盖全部监控。改完分组要检查渠道配置。

## 维护窗口

维护窗口在站点设置里配置，可以选单次或每周重复。时间都是 UTC，每周窗口的 `day=0` 是星期日，可以跨午夜；单次维护结束后不重复。格式见[配置参考](configuration.md#维护窗口格式)。

在“设置 → 维护”里启用计划维护后，窗口对所有公开展示域名生效。开始前的公告和维护期间的页面内容分开编辑，自动保存，留空用默认文案。窗口开始后，公开展示页跳到当前域名根路径 `/` 的独立维护页面，结束后恢复该域名的展示页面。

手动维护也会压住自动通知。关闭手动维护后，如果还在计划维护窗口内，计划维护继续生效。

维护期间照常检查、上报和记录事件，只暂停自动通知。后台、登录、初始化、API 和 Agent 通信仍可使用。窗口结束时仍异常的监控按当前状态处理，已经恢复的异常不会作为历史告警集中补发。

Worker 还支持部署绑定 `AUTOMATIC_NOTIFICATIONS_DISABLED=true`，它只关闭自动分发，不停止监控。Go 不读这个绑定；Go 要临时停发，就在后台关掉相应渠道，或用站点维护设置压住自动通知。手动测试会真的外发，不受这些自动分发开关影响。

## 投递记录与重试

控制台提供渠道统计和投递记录，能区分发送成功、提供商拒绝、网络超时和重试失败。状态变化先进入持久待发送队列，再尝试投递；同一监控和渠道的事件保持顺序。

失败会按退避规则重试，但有次数和时效上限：失败 8 次或创建超过 7 天的记录不再处理。重试也会写投递记录。通知系统不保证永久保存，也不保证只送达一次；网络故障后的重试可能重复，接收方要能接受重复事件。

看记录时分清监控事件时间和重试发生时间。监控异常但没有投递记录，先查渠道是否启用、分组范围、维护窗口和自动通知开关；已有失败记录，就按提供商的错误排查。

## 常见排查

| 现象 | 检查方向 |
| --- | --- |
| Telegram HTTP 请求完成但没有消息 | Bot Token、chat ID、Bot 会话权限及提供商业务错误 |
| Webhook 收到请求但响应错误 | 认证头、接收端 JSON 处理、返回状态与超时 |
| 测试成功，实际告警不发送 | 分组范围、渠道是否启用、维护时间、监控是否确有状态变化 |
| 修改后仍偶尔收到旧事件 | 查看待发送事件与投递时间，区分重试和新的状态变化 |
| Agent 资源高但没有通知 | 是否配置并启用规则、是否达到持续时间、是否有连续的新报告 |

Worker 日志里 `notify_unmatched` 表示事件没匹配到渠道，`notify_failed` 表示发送失败。排查时不要打印完整渠道配置，里面含外部凭据。

## Notification guide

Notifications are triggered by monitor state changes and Agent resource rules. Establish monitor reporting first, then configure a channel, send a test and confirm its group scope.

### Set up a channel

1. Sign in to the console and add a channel under notification management.
2. Select the provider and enter its name and required credentials.
3. Choose the message language and group scope. An empty scope includes all monitors, including ungrouped monitors.
4. Save the channel and send a test. Confirm that the destination receives it in the selected language.
5. Enable the channel and check the scope and maintenance rules against an actual monitor state change.

A test sends a real external request. A successful test confirms that delivery attempt, not that every group matches or that every Agent has a resource alert configured. The test API returns delivery success or failure in its `ok` and `error` response fields; HTTP 200 alone does not establish delivery.

### Choose the message language

Each channel has its own message language. A new channel starts with the current interface language. Once saved, the channel's language remains independent of later interface language changes.

The supported values are `en-US`, `zh-CN`, `zh-TW`, `zh-HK`, `ja-JP`, `ko-KR`, `fr-FR`, `pt-BR` and `ru-RU`. The chosen language applies to titles, states, field labels, test messages and subsequent delivery attempts. Monitor names are not translated. Before sending, target addresses have user information, query parameters and fragments removed, while hosts and paths are generally retained. Check details retain available failure reasons without translation, with target credentials and recognizable credential content redacted. Webhook `text` uses the selected language; structured fields such as `event`, `status` and `transition` retain their fixed formats. Structured targets and check details use the redacted values too.

For API requests, set `language` inside the channel's `config`, for example `"language": "zh-CN"`. If omitted, the message language defaults to `en-US`. An unsupported value returns `notification_language_invalid`. Updating `config` replaces the entire object, so include the provider's other configuration fields when changing the language.

### Providers and message content

| Provider | Required configuration | Notes |
| --- | --- | --- |
| Telegram | `bot_token`, `chat_id` | The bot needs permission to send to the destination chat. |
| Feishu | `webhook_url` | Use the bot's HTTPS webhook. |
| Slack | `webhook_url` | Use an Incoming Webhook URL, not a channel name. |
| Discord | `webhook_url` | Use the channel's HTTPS webhook. |
| Webhook | `url` | Sends JSON; optional `secret` supplies bearer authentication. |
| Apprise | `url` and either `key` or `urls` | Use a saved key for stateful mode or destination URLs for stateless mode. |
| ServerChan | `sendkey` | Supports keys in the form `sctp<number>t<token>`. |

HTTP delivery address fields require a valid HTTPS URL. Apprise `urls` is a list of Apprise destination protocols, not the HTTP address used to contact the Apprise service; that address is `url`. A non-empty Webhook `secret` is sent as `Authorization: Bearer <secret>`. Provider responses are checked where applicable, so an HTTP 200 with a provider-reported error can still be a failed delivery.

Telegram messages include the monitor name, target, type and state transition. They also include available check details, response code and latency, followed by a suggested action and UTC event time. A first reading is identified as such.

Channel credentials grant access to external services. Keep them out of public names, maintenance text and monitor messages. Management API responses can contain channel configuration, so restrict access to trusted administrators and automation. Do not print complete channel configurations when troubleshooting.

### Group scope

An empty group scope matches all monitors, including ungrouped ones. A non-empty scope matches only monitors in the selected groups. A disabled channel does not receive normal automatic dispatch.

Moving a monitor changes its matching scope. Deleting a group also removes its channel associations. If the last association is deleted, the scope can become empty and the channel can receive alerts for all monitors. Review channel scope after changing groups.

### Maintenance and automatic dispatch

Configure one-time or weekly maintenance windows in site settings. Times are UTC; weekly `day=0` is Sunday and a window can cross midnight. One-time windows do not repeat. See the [configuration reference](configuration.md#maintenance-windows) for the format.

Once scheduled maintenance is enabled, it applies to all public presentation domains. The pre-maintenance announcement and maintenance page content are edited separately and saved automatically; blank content uses defaults. During a window, public presentation pages redirect to the standalone maintenance page at `/` on the current domain. Presentation resumes after the window.

Manual maintenance also suppresses automatic notifications. If a scheduled window is still active when manual maintenance ends, the scheduled window remains effective. Checks, reports and event recording continue during maintenance; the console, sign-in, setup, API and Agent communication remain available. After the window, monitors still in an abnormal state are handled according to their current state. Incidents that have already recovered are not sent as a historical batch.

Worker also accepts the deployment binding `AUTOMATIC_NOTIFICATIONS_DISABLED=true` to stop automatic dispatch without stopping monitors. Go does not read that binding; disable the relevant channels or use site maintenance to suppress automatic notifications. Manual test sends are real external deliveries and are not suppressed by these automatic-dispatch controls.

### Delivery records and retries

The console provides channel statistics and delivery records for successful sends, provider rejection, timeouts and retry failures. State changes enter a persistent outbox before delivery. Events for the same monitor and channel retain their order.

Failed attempts are retried with backoff. Records are no longer processed after 8 failed attempts or 7 days from creation. Retries produce delivery records and can result in duplicate messages after network failures; receivers should tolerate duplicates. The outbox is not permanent storage and does not guarantee exactly-once delivery.

Distinguish the monitor event time from the retry time when reviewing records. If a monitor is abnormal but there is no delivery record, check the channel's enabled state, group scope, maintenance window and automatic-dispatch setting. If a failed record exists, investigate the provider's error.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Telegram request completes but no message arrives | Bot token, chat ID, bot permissions and provider error. |
| Webhook receives a request but responds with an error | Authorization header, JSON handling, response status and timeout. |
| Test succeeds but an actual alert is not sent | Group scope, channel state, maintenance and whether the monitor changed state. |
| An older event arrives after a change | Compare pending events and delivery times to distinguish a retry from a new transition. |
| Agent resource use is high but no alert arrives | Rule enabled state, duration threshold and consecutive new reports. |

In Worker logs, `notify_unmatched` means an event matched no channel; `notify_failed` means delivery failed. Avoid exposing credentials in diagnostic output.
