# 订阅公开监控

[English](#english)

Uptime Polaris 可拉取其他站点的公开网站与模型状态并汇总展示。在 **订阅 → 订阅仓库** 选择模板并预览即可创建（订阅模型前需先开启 AI 监控）。

## 从仓库或自定义接口添加

1. 打开 **订阅 → 订阅仓库**，选择内置模板（默认接入[官方订阅仓库](https://github.com/XingLingQAQ/UptimePolaris-Subscriptions)）或预填站点。
2. 填入来源地址与参数（例如 Polaris 模型页、JSON 链接或 Kuma 站点域名/完整状态页链接）。
3. 点击“读取预览”，勾选所需条目并设置名称、分组、公开范围和通知后保存。

默认规则：
- 新订阅与自动订阅的新条目均默认私有，且首次读取只建基线，不把源站已有故障当作新告警。
- 在 **管理仓库** 可添加最多 8 个遵守 `schemaVersion: 1` 的可信第三方 HTTPS `catalog.json` 仓库。
- 在 **导入自定义接口** 可通过 HTTPS 链接、上传或粘贴 JSON 导入自定义描述文件（格式见 [`shared/subscription.schema.json`](../shared/subscription.schema.json)，建议以官方 `json-website`、`json-model` 或 `statuspage` 模板为底稿）。目标地址必须为公网主机名 + HTTPS；认证参数应设为 `secret`（导出时自动剔除）；条目 ID 须绑定稳定不变的源站标识。

## 同步周期、更新与通知

- **周期与历史**：同步周期 `60–86400` 秒；每个条目保留最近 60 条观测和最多 90 天日汇总。同步失败仅影响同步状态，不会直接将源站条目改成故障；来源提供的可用率单独标注，不与本地 SLA 混算。
- **配置更新与恢复**：在 **接口配置** 可检查描述文件更新、预览差异并手动应用（运行时不自动套用远端修改）。若条目 ID 发生变化，应用前需显式映射新旧 ID（未关联旧条目归档）；支持通过“预览上一版”回滚描述（凭据不回滚）。远程同步保留本地名称、分组、排序、公开和静默设置。
- **通知与密钥**：支持分别配置**监控告警**（条目状态变化）和**同步告警**（读取来源失败，默认连续异常 300 秒）。走全局规则时需在通知渠道勾选 **外部订阅**。凭据与缓存加密方式与 AI 监控相同（Worker 用 `ADMIN_TOKEN`，Go 用 `ai-credential.key` 或 `POLARIS_AI_KEY_FILE`），备份恢复时需一并携带。

## English

Uptime Polaris aggregates public website and model status from external sites under **Subscriptions → Subscription library** (enable AI monitoring first to subscribe to models).

### Add from library or custom descriptors

1. Pick a template (defaults to the [official repository](https://github.com/XingLingQAQ/UptimePolaris-Subscriptions)) or prefilled entry.
2. Enter the source URL (such as a Polaris AI URL, JSON endpoint, or Kuma hostname/status URL).
3. Click **Read preview**, select items, set visibility/notifications, and save.

- New subscriptions (and auto-subscribed additions) start private, and the initial fetch sets a baseline without alerting on existing outages.
- **Manage repositories** supports up to 8 trusted third-party `schemaVersion: 1` HTTPS `catalog.json` sources.
- Custom descriptors ([`shared/subscription.schema.json`](../shared/subscription.schema.json)) import via HTTPS URL, upload, or JSON paste; copy `json-website`, `json-model`, or `statuspage` to start. Target URLs must use public HTTPS hostnames, credentials should use `secret` inputs, and item IDs must bind to stable source identifiers.

### Sync, updates, and notifications

- Sync intervals run `60–86400` s; each item retains 60 observations and 90 daily summaries. Failed syncs do not mark source items `DOWN`, and upstream SLA stays separate from local SLA.
- Check descriptor updates under **Interface configuration** and apply after previewing (ID changes require explicit mapping; **Preview previous version** rolls back descriptors without reverting secrets). Local names, groups, order, visibility, and mute states persist across syncs.
- Configure **Monitor alerts** and **Sync alerts** (default 300 s failure delay) separately; for global routing, enable **external subscriptions** on notification channels. Secrets encrypt with `ADMIN_TOKEN` (Worker) or `ai-credential.key` / `POLARIS_AI_KEY_FILE` (Go) and must be backed up with the database.
