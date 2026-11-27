# 通知指南

[English](#english)

监控状态变化、Agent 资源阈值规则和外部订阅异常会触发通知。建议先确认监控已有正常上报，再配置通知渠道并发送测试消息验证。

## 配置渠道

在 `/admin` 的通知管理中新增渠道，填写名称、类型、凭据、消息语言与分组范围，保存后发送“测试”确认收件，再启用渠道。

| 类型 | 必填配置 | 说明 |
| --- | --- | --- |
| Telegram | `bot_token`、`chat_id` | Bot 须具备向目标会话发消息权限 |
| 飞书 | `webhook_url` | 机器人 HTTPS Webhook |
| Slack | `webhook_url` | Incoming Webhook URL（非频道名） |
| Discord | `webhook_url` | 频道 HTTPS Webhook |
| Webhook | `url` | 发送 JSON；可选 `secret` 发送 `Authorization: Bearer <secret>` |
| Apprise | `url`，加 `key` 或 `urls` | `url` 为 Apprise 服务地址；有状态填 `key`，无状态填目标列表 `urls` |
| Server酱 | `sendkey` | 格式为 `sctp<数字>t<令牌>` |

HTTP 投递目标必须为合法 HTTPS URL；勿把渠道凭据写进公开监控名或维护文案。

## 消息语言

每个渠道单独保存消息语言（新建默认当前界面语言，后续切换后台语言不影响已保存渠道），支持 `en-US`、`zh-CN`、`zh-TW`、`zh-HK`、`ja-JP`、`ko-KR`、`fr-FR`、`pt-BR`、`ru-RU`。

标题、状态与字段标签按所选语言生成；监控名与原始错误详情保持原文（URL 中的账号凭据与查询参数会自动脱敏）。Webhook 的 `text` 字段使用所选语言，结构化字段保持固定格式。

## 分组范围与路由

监控与 AI 渠道支持三种策略：**使用全局规则**、**指定通知渠道**和**关闭通知**。

- **全局规则**：在通知管理配置允许的事件类别、来源与监控分组（默认仅收本地网站、模型与 Agent 资源事件；接收外部订阅需手动勾选来源）。AI 事件与订阅无普通分组，限定了分组的渠道不会匹配它们。
- **空分组陷阱**：渠道分组范围为**空**表示匹配全部监控（含未分组）。删除监控分组后，若某渠道关联的分组被删空，它会转为接收全部监控告警，变更分组后务必复核渠道范围。
- **指定渠道**：绕过全局分组范围，仍受监控开关、渠道启用状态和维护窗口限制。可使用后台“接收范围预览”提前核对（不会发送消息）。

## 维护静默与重试

- **维护静默**：开启手动或计划维护窗口期间自动通知暂停；窗口结束时仍异常的监控按当前状态触发，已恢复的历史事件不集中补发。Worker 另支持 `AUTOMATIC_NOTIFICATIONS_DISABLED=true` 暂停自动通知（Go 不读此变量；测试发送不受影响）。
- **重试机制**：事件按监控与渠道顺序入队投递，失败按退避策略最多重试 **8 次**或保留 **7 天**。网络重试可能产生重复消息，接收端需容忍重复。

## 常见排查

- **测试成功但故障不发**：检查渠道启用状态、分组范围、维护窗口、自动通知开关及是否满足失败确认次数/Agent 持续时间。Worker 日志中 `notify_unmatched` 表示未匹配到渠道，`notify_failed` 表示投递失败。
- **Telegram / Webhook 无响应**：核对凭据、群组权限、HTTPS 状态与提供商返回错误（HTTP 200 但业务报错仍算失败）。

## English

Notifications fire on monitor transitions, Agent resource rules, and subscription issues. Verify healthy checks first, then add a channel, send a test, and check group scope.

### Providers and setup

Add channels under `/admin` Notifications, configure language and group scope, run **Test** to verify delivery, then enable the channel.

| Provider | Required fields | Notes |
| --- | --- | --- |
| Telegram | `bot_token`, `chat_id` | Bot must have permission to post in the chat |
| Feishu | `webhook_url` | Bot HTTPS webhook |
| Slack | `webhook_url` | Incoming Webhook URL (not channel name) |
| Discord | `webhook_url` | Channel HTTPS webhook |
| Webhook | `url` | JSON POST; optional `secret` sends `Authorization: Bearer <secret>` |
| Apprise | `url` + (`key` or `urls`) | `url` is the Apprise service; use `key` (stateful) or `urls` (stateless) |
| ServerChan | `sendkey` | `sctp<number>t<token>` format |

HTTP targets require valid HTTPS URLs. Keep channel credentials out of public monitor names and maintenance text.

### Message language

Each channel saves its own language (`en-US`, `zh-CN`, `zh-TW`, `zh-HK`, `ja-JP`, `ko-KR`, `fr-FR`, `pt-BR`, `ru-RU`), independent of later UI locale changes. Titles, states, and labels localize; monitor names and raw redacted details stay untranslated. Webhook `text` localizes while structured keys stay fixed.

### Scope and routing

Monitors and AI channels support **Use global rules**, **Choose channels**, and **Off**:
- Global rules match event type, source (tick **external subscriptions** to receive subscription alerts), and monitor group (AI and subscription events have no group and do not match group-restricted channels).
- **Empty group list matches all monitors** (including ungrouped). Review channel scopes after deleting monitor groups so channels do not silently expand to all monitors.
- Explicit channels bypass global scope while still honoring enabled states and maintenance windows. Use recipient preview to verify matching safely.

### Maintenance and retries

- Active maintenance suppresses automatic alerts without replaying recovered events afterward. Worker also supports `AUTOMATIC_NOTIFICATIONS_DISABLED=true` (Go ignores it; manual tests still send).
- Failed deliveries retry with backoff up to **8 attempts** or **7 days** (at-least-once delivery). Inspect `notify_unmatched` and `notify_failed` in Worker logs when troubleshooting.
