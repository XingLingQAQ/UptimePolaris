# 配置参考

[English](#english)

Uptime Polaris 的配置按作用范围分为三块：**Go 启动配置**、**Worker 环境变量与绑定**、**控制台设置**。Agent 本地配置见 [Agent 手册](agents.md#本地配置)。

## Go 启动配置

Go 默认读取当前工作目录的 `.env`（示例见 [`backends/go/.env.example`](../backends/go/.env.example)），优先级为：**命令行参数 > 进程环境变量 > `.env` > 默认值**。

- 未配置 `POLARIS_SETUP_KEY` 和 `POLARIS_ADMIN_TOKEN` 且尚未初始化时，启动日志的 `setup_key` 会输出一次性初始化密钥（重启后会重新生成）。
- 初始化显式选库后会写入数据目录下的 `database.json`（权限 `0600`），优先级高于 `POLARIS_DATABASE_URL` 和 `--database-url`。
- 完整变量与参数列表见 [Go 后端说明](../backends/go/README.md#部署配置)。

## Worker 绑定与环境变量

### 资源绑定

| 绑定名 | 类型 | 必需性 | 用途 |
| --- | --- | --- | --- |
| `CONFIG` | KV | 必需 | 保存后台设置与初始化选库配置 |
| `UPTIME` | Analytics Engine | 必需 | 写入实时观测与历史数据 |
| `ASSETS` | Workers Assets | 必需 | 托管前端静态资源 |
| `ANALYTICS_SQL` | Analytics SQL | 模板自带 | 查询历史趋势与每日归档（缺失时仅停用历史图表与归档） |
| `DB` | D1 | 可选 | 绑定后可在初始化时选择 D1 |
| `THEMES` | R2 | 可选 | 存放第三方主题资产 |
| `CHECK_QUEUE` | Queue | 可选 | 分批检查队列，详见 [Worker Queue](queue.md) |

说明：直接使用 Wrangler 部署要求版本 `>= 4.145.0`。

### 环境变量与 Secret

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 无 | Secret；初始化凭据、管理 API Token 及配置加密主密钥 |
| `DATABASE_TYPE` | 有 D1 为 `d1`，否则为 `postgres` | 默认数据库类型；初始化页面保存的选型优先 |
| `DATABASE_URL` | 无 | Secret；PostgreSQL 连接串；初始化页面保存的连接优先 |
| `PBKDF2_ITERATIONS` | `3000`（`1–100000`） | 字符串变量；密码哈希迭代次数，调高会增加登录 CPU 耗时 |
| `USAGE_PLAN` | `free`（可选 `paid`） | 用量对比基准，不会自动开通付费计划 |
| `AUTOMATIC_NOTIFICATIONS_DISABLED` | 未设置 | 设为 `true` 时暂停自动通知（不停止探测） |
| `UPTIME_DATASET` | `uptime_heartbeats` | 自定义数据集时须与 `UPTIME` 绑定保持一致 |
| `AUTH_MODE` | `disabled` | 外部认证模式：仅支持 `disabled` 或 `cloudflare-access`（不支持 `trusted-header`） |
| `AUTH_CF_TEAM_DOMAIN` | 无 | `https://<team>.cloudflareaccess.com`，`cloudflare-access` 必填 |
| `AUTH_CF_AUDIENCE` | 无 | Cloudflare Access 应用 AUD 标签，`cloudflare-access` 必填 |
| `AUTH_ALLOWED_IDENTITIES` | 无 | 允许登录的 Access 邮箱白名单（逗号分隔，不区分大小写；留空允许全部通过验签的用户邮箱） |

**密钥提醒**：如果在 `/setup` 页面填写了 PostgreSQL 连接串，系统会用 `ADMIN_TOKEN` 派生密钥加密保存。不要直接轮换 `ADMIN_TOKEN`，否则会导致原加密连接无法读取（目前没有重加密工具）。

## AI 与订阅加密密钥

使用 AI 监控或外部订阅的凭据加密时，各环境要求如下：

| 部署方式 | 密钥来源 | 备份与恢复要求 |
| --- | --- | --- |
| Worker | 复用 `ADMIN_TOKEN` | 与数据库、KV 一起备份 |
| Go + SQLite | 首次保存凭据时自动在数据目录生成 `ai-credential.key` | 随数据目录一起备份 |
| Go + PostgreSQL | 通过 `POLARIS_AI_KEY_FILE` 指定 32 字节原始随机文件 | 多实例使用同一文件，单独备份 |

`POLARIS_AI_KEY_FILE` 必须为 **32 个原始随机字节**（非口令、十六进制或 Base64），POSIX 权限 `0600`，Windows 仅授权运行账号与 SYSTEM。若密钥丢失且无备份，需重新配置密钥后逐个重填渠道 API Key。

## 控制台设置

可在 `/admin` 的 **设置** 页面修改站点信息、监控默认值、保留天数、安全策略与维护窗口，也可以通过 `GET / PUT /api/admin/settings` 读写（`DELETE /api/admin/settings/:key` 恢复默认）：

| 设置键 | 默认值 | 取值范围 / 说明 |
| --- | --- | --- |
| `site.title` | `Uptime Polaris` | 非空字符串，最多 120 字符 |
| `site.description` | `服务可用性监控` | 非空字符串，最多 300 字符 |
| `site.icon` | `/api/public/icon` | 站内路径或 HTTP(S) URL，最多 2048 字符 |
| `site.syncMonitorIcons` | `false` | 是否同步监控网站与订阅图标 |
| `site.showPublicAgentHardware` | `false` | 是否在监控详情页（`/monitor/:id`）的公开 Agent 展示中返回网卡名与磁盘挂载路径（不影响 `/servers` 机器页）；会暴露主机网络接口与挂载信息，仅建议私有或受访问控制保护的实例启用 |
| `monitor.defaultIntervalSec` | `60` | 新建监控默认间隔（Worker：`60–86400` 秒；Go：`5–86400` 秒） |
| `monitor.defaultTimeoutMs` | `10000` | 新建监控默认超时（Worker：`1000–60000` ms；Go：`100–120000` ms） |
| `monitor.defaultRetries` | `3` | `0–10`；运行时失败确认次数，对所有监控生效 |
| `retention.availabilityDays` | `400` | `7–3650` 天；可用率与资源日汇总保留天数 |
| `retention.detailDays` | `90` | `1–3650` 天；详细指标保留天数（Worker AE 受平台约 90 天上限约束） |
| `retention.eventDays` | `90` | `1–3650` 天；状态变化事件保留天数 |
| `alerts.maintenanceWindows` | `[]` | 最多 32 个单次或每周维护窗口（UTC） |
| `alerts.maintenanceNote` | 空 | 最多 300 字符 |
| `maintenance.enabled` | `false` | 手动维护开关（优先于计划窗口） |
| `maintenance.scheduleEnabled` | `false` | 计划维护总开关（关闭仍保留窗口列表） |
| `maintenance.announcementTitle` / `announcementDescription` | 空 | 维护开始前的顶部公告（标题 ≤120，正文 ≤1000 字符） |
| `maintenance.title` / `description` | 空 | 维护中独立页面文案（标题 ≤120，正文 ≤1000 字符，留空用默认） |
| `security.sessionTtlDays` | `14` | `1–365` 天；登录会话有效期 |
| `security.loginMaxAttempts` / `loginWindowSec` | `8` / `300` | 登录限流次数（`3–100`）与窗口秒数（`60–86400`） |
| `security.allowAgentCommands` | `false` | 是否允许远程 Agent 指令与配置同步 |

`alerts.maintenanceWindows` 示例（均为 **UTC**；`weekly` 的 `day` `0–6` 中 `0` 为星期日，结束早于开始表示跨午夜）：

```json
[
  { "kind": "weekly", "day": 0, "start": "02:00", "end": "03:30" },
  { "kind": "once", "startsAt": "2026-12-01T23:00:00Z", "endsAt": "2026-12-02T01:00:00Z" }
]
```

**提示**：默认间隔和超时仅预填新建监控表单；调整保留天数不会立即清理或恢复历史数据；进入维护期间仅暂缓自动通知，探测与后台操作照常运行。

## English

Configuration spans three areas: **Go startup settings**, **Worker bindings & variables**, and **Console settings**. For Agent settings, see the [Agent guide](agents.md#english).

### Go startup configuration

Go reads `.env` from the process working directory ([`.env.example`](../backends/go/.env.example)) with precedence **CLI flags > env vars > `.env` > defaults**.

- If `POLARIS_SETUP_KEY` and `POLARIS_ADMIN_TOKEN` are unset on an uninitialized instance, a one-time `setup_key` is printed in startup logs.
- Choosing a database in `/setup` writes `database.json` (`0600`), overriding `POLARIS_DATABASE_URL` and `--database-url`.
- See the [Go backend guide](../backends/go/README.md#english) for the complete flag and variable table.

### Worker bindings and environment variables

#### Bindings

| Binding | Type | Required | Purpose |
| --- | --- | --- | --- |
| `CONFIG` | KV | Yes | Console settings and setup database selection |
| `UPTIME` | Analytics Engine | Yes | Live observations and history |
| `ASSETS` | Workers Assets | Yes | Frontend static files |
| `ANALYTICS_SQL` | Analytics SQL | Included | History charts and daily archives (missing pauses charts/archives only) |
| `DB` | D1 | No | Enables D1 option during setup |
| `THEMES` | R2 | No | Third-party theme assets |
| `CHECK_QUEUE` | Queue | No | Batched checks ([Worker Queue](queue.md#english)) |

Direct Wrangler deploys require Wrangler `>= 4.145.0`.

#### Environment variables and secrets

| Name | Default | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | None | Secret; setup key, API Bearer token, and encryption root |
| `DATABASE_TYPE` | `d1` if D1 bound, else `postgres` | Default DB type; overridden by KV selection |
| `DATABASE_URL` | None | Secret PostgreSQL URL; overridden by KV selection |
| `PBKDF2_ITERATIONS` | `3000` (`1–100000`) | Password hash cost (increases login CPU time) |
| `USAGE_PLAN` | `free` (or `paid`) | Baseline for console usage comparison only |
| `AUTOMATIC_NOTIFICATIONS_DISABLED` | Unset | Set to `true` to pause automatic alerts without stopping probes |
| `UPTIME_DATASET` | `uptime_heartbeats` | Must match your bound `UPTIME` dataset name |
| `AUTH_MODE` | `disabled` | External auth mode: `disabled` or `cloudflare-access` (`trusted-header` is rejected on Worker) |
| `AUTH_CF_TEAM_DOMAIN` | None | `https://<team>.cloudflareaccess.com` (required for `cloudflare-access`) |
| `AUTH_CF_AUDIENCE` | None | Cloudflare Access application AUD tag (required for `cloudflare-access`) |
| `AUTH_ALLOWED_IDENTITIES` | None | Allowed Access emails (comma-separated, case-insensitive; empty allows any verified user email) |

**Key warning**: PostgreSQL URLs entered during `/setup` are encrypted with `ADMIN_TOKEN`. Rotating `ADMIN_TOKEN` directly makes stored connection records unreadable.

### AI and subscription encryption keys

- **Worker**: uses `ADMIN_TOKEN`.
- **Go + SQLite**: auto-creates `ai-credential.key` in the data directory.
- **Go + PostgreSQL**: requires `POLARIS_AI_KEY_FILE` pointing to a **32 raw random bytes** file (`0600` on POSIX, restricted ACLs on Windows), shared across instances.

Always back up encryption keys alongside the database; lost keys require re-entering channel API keys.

### Console settings

Manage settings in `/admin` or via `GET / PUT /api/admin/settings` (`DELETE /api/admin/settings/:key` restores the default):

| Key | Default | Range / Meaning |
| --- | --- | --- |
| `site.title` | `Uptime Polaris` | Non-empty, max 120 chars |
| `site.description` | `服务可用性监控` | Non-empty, max 300 chars |
| `site.icon` | `/api/public/icon` | Site path or HTTP(S) URL, max 2048 chars |
| `site.syncMonitorIcons` | `false` | Sync website and subscription icons |
| `site.showPublicAgentHardware` | `false` | Expose Agent network interface names and disk mount paths on public monitor detail pages (`/monitor/:id`, without affecting `/servers`); enable only on private or access-controlled instances |
| `monitor.defaultIntervalSec` | `60` | New-monitor default interval (Worker: `60–86400` s; Go: `5–86400` s) |
| `monitor.defaultTimeoutMs` | `10000` | New-monitor default timeout (Worker: `1000–60000` ms; Go: `100–120000` ms) |
| `monitor.defaultRetries` | `3` | `0–10`; runtime failure confirmation threshold across monitors |
| `retention.availabilityDays` | `400` | `7–3650` days |
| `retention.detailDays` | `90` | `1–3650` days (Worker AE caps around 90 days) |
| `retention.eventDays` | `90` | `1–3650` days |
| `alerts.maintenanceWindows` | `[]` | Up to 32 `once` or `weekly` UTC windows |
| `alerts.maintenanceNote` | Empty | Max 300 chars |
| `maintenance.enabled` | `false` | Manual maintenance switch (overrides schedules) |
| `maintenance.scheduleEnabled` | `false` | Enables configured schedules while keeping them on disable |
| `maintenance.announcementTitle` / `announcementDescription` | Empty | Pre-maintenance banner (title ≤120, body ≤1000 chars) |
| `maintenance.title` / `description` | Empty | Active maintenance page text (title ≤120, body ≤1000 chars) |
| `security.sessionTtlDays` | `14` | `1–365` days |
| `security.loginMaxAttempts` / `loginWindowSec` | `8` / `300` | Login throttle attempts (`3–100`) and window (`60–86400` s) |
| `security.allowAgentCommands` | `false` | Enables remote Agent commands and config sync |

`alerts.maintenanceWindows` uses **UTC** (`day` `0–6` with `0` = Sunday; an end earlier than start spans midnight); see the JSON example in [控制台设置](#控制台设置). Default intervals/timeouts prefill new monitors only, retention drives async cleanup, and active maintenance pauses automatic alerts while keeping probes and `/admin` online.
