# 配置参考

[English](#english)

配置分四层：部署绑定、Worker 环境变量、数据库里的后台设置，以及 Agent 自己的配置。它们入口不同，不能互相替代。

Go 的环境变量和启动参数见 [Go 后端说明](../backends/go/README.md#部署配置)。Go 不用下面的 Cloudflare 绑定；后台设置两边共用，间隔和超时范围按所选后端执行。

## Go 启动配置

Go 默认读取进程工作目录里的 `.env`。可以从 [`backends/go/.env.example`](../backends/go/.env.example) 复制示例；程序以启动命令时的目录为准。优先级从高到低：命令行参数、进程环境变量、`.env`、默认值。

例如，在启动目录的 `.env` 里设置监听地址和端口：

```dotenv
POLARIS_ADDR=127.0.0.1:8090
POLARIS_DATA_DIR=./data
```

初始化密钥由 `POLARIS_SETUP_KEY` 指定；没设就用 `POLARIS_ADMIN_TOKEN`。两个都没配、也还没有管理员时，程序监听成功后会拿 32 字节随机数据生成密钥，并在启动日志的 `setup_key` 字段输出一次。这个自动密钥只用于本次进程的初始化，不能当管理 API 的 Bearer Token；重启还没初始化的程序会生成新密钥。已有管理员就不会生成。

`.env`、数据库连接和带自动密钥的启动日志都按敏感文件管理，不要提交到仓库或放进公开截图。数据库选择已经写进 `database.json` 时，这个文件优先于 `POLARIS_DATABASE_URL` 和 `--database-url`。

## 初始化时选择数据库

Worker 的 `/setup` 页面分为两步：先检查数据库绑定与 `ADMIN_TOKEN`，必需项通过后才进入账号与数据库选择表单；Go 后端直接显示初始化表单。

初始化表单按后端列出可选数据库：Worker 为 D1 或 PostgreSQL，Go 为 SQLite 或 PostgreSQL。不做选择则沿用当前配置。新选 PostgreSQL 必须填写连接 URL，格式示例：

```text
postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full
```

URL 需包含协议（`postgres://` 或 `postgresql://`）、用户名、密码、主机名和数据库名，密码中的特殊字符需进行 URL 编码；查询参数仅支持 `sslmode`（`verify-full` 或 `require`，Go 本机回环测试可用 `disable`）。只有已部署的 PostgreSQL 连接对应当前数据库时才能留空复用。初始化成功后，管理员账号和会话保存在目标数据库中，后续请求和重启继续使用该数据库。

会话状态会返回可选类型、默认类型、PostgreSQL 是否已配置、URL 是否可编辑，但不返回 URL。Worker 要在页面填新的 PostgreSQL URL，必须保留 D1 绑定：D1 保存引导选择和加密 URL，业务数据仍在 PostgreSQL。纯 PostgreSQL 且没有 D1 绑定时，部署只需配置 `DATABASE_URL`（`DATABASE_TYPE` 可省略，未绑定 D1 时自动按 PostgreSQL 处理），初始化只能复用这个连接，页面不能换 URL。Go 可以在页面填新 URL。不要在日志或截图里暴露 URL。请求字段和错误码见[初始化数据库契约](api.md#初始化数据库契约)。

Worker 有 D1 绑定、初始化又使用 PostgreSQL 时（包括复用预配置连接），都会在 D1 里保存活动加密 URL，密钥由 `ADMIN_TOKEN` 派生。要保留原 `ADMIN_TOKEN` 和 D1 绑定；直接换 Token 会让已保存的 URL 无法解密。目前没有重加密或 Token 轮换命令，不要直接轮换。维护连接配置前，先停业务写入，备份 D1 控制记录、PostgreSQL 和原 Token。不要删除控制记录，也不要回退到空 D1。如果已经误换了 Token，用受保护的部署密钥机制恢复原 Token，并保留原 D1 绑定；无法取得原 Token 时，保留现有数据和备份，不要猜密钥或清空记录。

Worker 用部署配置里的默认 D1 初始化时，成功后会删掉临时控制记录。有 D1 绑定时，用 PostgreSQL 初始化，或者从预配 PostgreSQL 的部署里显式选 D1，都会留下活动记录，优先于部署数据库配置。迁移前先核对实际生效的配置并备份 D1 控制数据；不要以为改了 `DATABASE_TYPE` 和 `DATABASE_URL` 就一定能盖掉活动记录。迁移步骤见[从 D1 迁移到 PostgreSQL](deployment.md#从-d1-迁移到-postgresql)。

控制记录在 D1 的 `_polaris_database` 表里；HTTP 请求、定时任务和 WebSocket 都解析同一个活动选择。没有 D1 绑定的纯 PostgreSQL 部署使用部署配置，不使用这张加密控制表。

Go 显式选过数据库后，数据目录里的 `database.json` 优先于 `POLARIS_DATABASE_URL` 和 `--database-url`。这个文件可能包含明文 PostgreSQL URL，按 `0600` 创建；Windows 还要限制文件和目录 ACL，并保护备份。重启时只改环境变量，不会覆盖持久选择。

## 目录

- [Go 启动配置](#go-启动配置)
- [初始化时选择数据库](#初始化时选择数据库)
- [部署绑定](#部署绑定)
- [Worker 环境变量](#worker-环境变量)
- [后台设置](#后台设置)
- [维护窗口格式](#维护窗口格式)
- [通过 API 修改设置](#通过-api-修改设置)
- [Agent 配置](#agent-配置)

## 部署绑定

| 绑定 | 类型 | 说明 |
| --- | --- | --- |
| `DB` | D1，可选 | 绑定后初始化可选择 D1；未绑定时按 PostgreSQL 处理 |
| `ASSETS` | Workers Assets | 服务前端资源 |
| `THEMES` | R2，可选 | 第三方主题版本与资源；内置界面不依赖它 |
| `UPTIME` | Analytics Engine，可选 | 原始观测写入；SQL 回填另需查询凭据 |

手动部署的 CF CLI 读 `backends/worker/cloudflare.config.ts`，数据库 npm 脚本默认读 `backends/worker/wrangler.toml`。Fork 部署和按钮部署用根目录的 `wrangler.jsonc`，其中不声明 `DB`、`THEMES`、`UPTIME`，这些绑定在 Worker 的 **Settings → Bindings** 中添加。直接运行 Wrangler 时，JSONC 优先于 TOML；操作手动部署的数据库时，显式加 `--config backends/worker/wrangler.toml`，并核对账号和数据库。资源名称可以自己起，绑定名不要改。详细步骤见[部署指南](deployment.md)。

## Worker 环境变量

| 名称 | 默认或范围 | 配置方式与用途 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 无默认值 | Secret；首次初始化凭据，也是管理 API 的 Bearer Token |
| `DATABASE_TYPE` | 有 D1 时为 `d1`，否则为 `postgres`；也可显式设为 `postgres` | 普通变量；部署数据库类型，可省略，活动覆盖记录优先 |
| `DATABASE_URL` | 无默认值 | Secret；PostgreSQL 连接 URL，形如 `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`（网页指定的连接另存于 D1 控制记录） |
| `CF_ACCOUNT_ID` | 无默认值 | AE SQL 回填使用的账号 ID |
| `CF_API_TOKEN` | 无默认值 | Secret；AE SQL 查询所需的账号 Analytics Read 凭据 |
| `PBKDF2_ITERATIONS` | `3000`；允许 1–100000 | 密码哈希成本，作为字符串变量配置 |
| `USAGE_PLAN` | `free`，可选 `paid` | 用量页比较的计划，不会替账号开通付费套餐 |
| `AUTOMATIC_NOTIFICATIONS_DISABLED` | 未设置 | 精确等于字符串 `true` 时禁用自动通知，不停止采集 |

AE SQL 回填需要 `UPTIME`、`CF_ACCOUNT_ID`、`CF_API_TOKEN` 同时可用。缺少时回填显示禁用，数据库里的实时状态、近期历史和可用率照常工作。

`PBKDF2_ITERATIONS` 会增加认证时的 CPU 开销。默认成本有限；调整前要结合 Worker 的实际运行预算验证，不能只凭本地计时判断生产环境能否承受。已有密码记录各自保存自己的哈希成本，改这个变量不会立刻重算所有密码。

手动部署的生产 Secret 可以通过 `--secrets-file` 提供；Fork 部署和按钮部署在 Worker 的 **Settings → Variables and Secrets** 中设置。步骤见[部署指南](deployment.md)。不要把这些值写进普通配置、提交记录或文档截图。

## 后台设置

登录控制台设置页修改。没保存的键用默认值；删掉某个键的覆盖值，就恢复默认。服务端统一拒绝未知键和非法值。

| 键 | 默认值 | 合法范围或含义 |
| --- | --- | --- |
| `site.title` | `Uptime Polaris` | 非空字符串，最多 120 字符 |
| `site.description` | `服务可用性监控` | 非空字符串，最多 300 字符 |
| `site.icon` | `/api/public/icon` | 站内路径或 HTTP(S) URL，最多 2048 字符 |
| `site.syncMonitorIcons` | `false` | 是否同步监控图标 |
| `monitor.defaultIntervalSec` | `60` | Worker：60–86400 秒；Go：5–86400 秒 |
| `monitor.defaultTimeoutMs` | `10000` | Worker：1000–60000 毫秒；Go：100–120000 毫秒 |
| `monitor.defaultRetries` | `3` | 0–10；运行时失败确认阈值 |
| `retention.availabilityDays` | `400` | 7–3650 天 |
| `retention.detailDays` | `90` | 1–3650 天 |
| `retention.eventDays` | `90` | 1–3650 天 |
| `alerts.maintenanceWindows` | `[]` | 最多 32 个单次或每周维护窗口 |
| `alerts.maintenanceNote` | 空字符串 | 最多 300 字符 |
| `maintenance.enabled` | `false` | 手动维护开关；关闭后恢复按维护窗口运行 |
| `maintenance.scheduleEnabled` | `false` | 是否启用已配置的维护窗口；关闭不删除计划 |
| `maintenance.announcementTitle` | 空字符串 | 开始前的顶部公告标题，最多 120 字符 |
| `maintenance.announcementDescription` | 空字符串 | 开始前的顶部公告正文，最多 1000 字符 |
| `maintenance.title` | 空字符串 | 公开维护标题，最多 120 字符；留空使用默认文案 |
| `maintenance.description` | 空字符串 | 公开维护正文，最多 1000 字符，支持多行纯文本 |
| `security.sessionTtlDays` | `14` | 1–365 天 |
| `security.loginMaxAttempts` | `8` | 3–100 |
| `security.loginWindowSec` | `300` | 60–86400 秒 |
| `security.allowAgentCommands` | `false` | 允许符合条件的远程 Agent 指令与配置控制 |

默认检查间隔和超时只在新建监控时使用，已有监控保留自己的参数。`monitor.defaultRetries` 由检查运行时读取，会影响已有监控的失败确认，不是某个监控单独保存的重试字段。保留天数影响定期清理，不会凭空生成历史，也恢复不了已删数据。

站点图标和账号头像各有上传入口；`site.icon` 不是图片文件本身。监控图标同步是单独的开关。

## 维护窗口格式

```json
[
  { "kind": "weekly", "day": 0, "start": "02:00", "end": "03:30" },
  { "kind": "once", "startsAt": "2026-12-01T23:00:00Z", "endsAt": "2026-12-02T01:00:00Z" }
]
```

`kind` 为 `weekly` 或 `once`。每周窗口的 `day` 为 0–6，0 是星期日；时间用 24 小时制 `HH:MM`，结束早于开始表示跨午夜。单次窗口用完整 UTC 时间，结束必须晚于开始，结束后不重复。所有时间都是 **UTC**，起止相同无效。

维护开关、窗口和文字都在“设置 → 维护”里编辑，修改后自动保存。`maintenance.announcementTitle`、`maintenance.announcementDescription` 是开始前的顶部公告；`maintenance.title`、`maintenance.description` 是维护进行中的独立页面。留空用默认文案，关开关不会清空文字或计划。公开文字里不要放凭据。

启用 `maintenance.scheduleEnabled` 后，窗口对所有公开展示域名生效。计划维护显示在页面顶部；窗口开始后，公开展示页进入当前域名根路径 `/` 的独立维护页面，结束后恢复。开启 `maintenance.enabled` 时，手动维护优先并一直生效，直到管理员关闭。关闭后，如果计划维护还处在窗口内，计划维护继续生效。后台、登录、初始化、API 和 Agent 通信仍可使用。

维护期间继续采集和记录状态，自动通知暂缓。窗口结束时如果仍然异常，按当前状态处理；已经恢复的历史异常不会全部补发。通知行为见[通知指南](notifications.md#维护窗口)。

## 通过 API 修改设置

`GET /api/admin/settings` 返回当前值、默认值和表单元数据。更新时直接提交键值对象：

```sh
curl --fail-with-body -X PUT \
  'https://status.example.com/api/admin/settings' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"monitor.defaultIntervalSec":60,"security.allowAgentCommands":false}'
```

一次请求里出现未知键或非法值，会返回 `invalid_settings` 和字段错误；失败请求不能当作已保存。恢复某项默认值用 `DELETE /api/admin/settings/:key`，例如键 `monitor.defaultIntervalSec`。

## Agent 配置

Agent 使用自己的 `config.json`、`install.json` 和 `POLARIS_AGENT_*` 环境变量。采样、上报间隔等完整字段、命令优先级和平台差异见 [Agent 手册](agents.md#本地配置)。

## English

Deployment bindings, Worker environment variables, database-backed console settings and Agent configuration have different owners. Go has no Cloudflare bindings; its environment variables and flags are in the [Go backend guide](../backends/go/README.md#english). Console settings are shared, with backend-specific interval and timeout limits.

### Go startup configuration

Go loads `.env` from the process working directory. Copy [`backends/go/.env.example`](../backends/go/.env.example) to that directory and edit the values. The executable uses the directory from which it is launched. Precedence is command-line flags, process environment variables, `.env`, then defaults. Set `POLARIS_ADDR=127.0.0.1:8090` to choose the listen address and port, and `POLARIS_DATA_DIR=./data` for persistent data.

`POLARIS_SETUP_KEY` selects the setup credential, falling back to `POLARIS_ADMIN_TOKEN`. If neither is configured and no administrator exists, Go generates a key from 32 random bytes after successfully listening and logs it once in the `setup_key` field. The key is valid for setup in that process, not as a management API Bearer token. Restarting an uninitialized server generates a new key. An initialized server does not generate an automatic key.

Protect `.env` and startup logs containing the generated key. A saved `database.json` still takes precedence over `POLARIS_DATABASE_URL` and `--database-url`.

### Database selection during setup

On the Worker, `/setup` has two steps: it first checks the database binding and `ADMIN_TOKEN` and shows the account form only after every required item passes; the Go backend shows the setup form directly.

Setup offers D1 or PostgreSQL on Worker, and SQLite or PostgreSQL on Go. Omitting the selection retains the current backend configuration. A newly selected PostgreSQL database requires a connection URL such as `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`; percent-encode special characters in the password, and keep only a supported `sslmode` in the query string. A blank URL reuses the deployed PostgreSQL connection only when it corresponds to the current database. On successful setup, the administrator and session are created in the target database, which remains active for later requests and restarts.

Session status returns supported types, the default, whether PostgreSQL is configured, and whether its URL is editable; it never returns the URL. To enter a new PostgreSQL URL during Worker setup, keep the D1 binding: D1 stores the bootstrap selection and encrypted URL, while business data remains in PostgreSQL. A Worker without D1 only needs `DATABASE_URL`; `DATABASE_TYPE` may be omitted because PostgreSQL is then the only option. Setup can reuse that connection but cannot accept a different URL. Go can accept a new URL. Keep URLs out of logs and screenshots. See the [setup database contract](api.md#setup-database-contract) for fields and errors.

When Worker has a D1 binding and setup uses PostgreSQL, including a preconfigured connection, it keeps an active encrypted URL in D1. The key is derived from `ADMIN_TOKEN`. Retain the original token and D1 binding: replacing the token directly makes the saved URL unreadable. There is currently no re-encryption or token-rotation command; do not rotate the token directly. Before maintaining the connection configuration, stop business writes and back up the D1 control record, PostgreSQL and the original token. Do not delete the control record or fall back to an empty D1 database. If the token was changed, restore the original through the protected deployment secret mechanism and retain the D1 binding. If the original token is unavailable, preserve the data and backups; do not guess the key or clear the record.

When setup uses the deployed default D1, the temporary control record is removed after success. With D1 bound, setup using PostgreSQL or choosing D1 against a PostgreSQL deployment leaves an active record that takes precedence over deployment database settings. Before migration, identify the effective configuration and back up D1 control data; changing `DATABASE_TYPE` and `DATABASE_URL` alone does not necessarily override an active record. See [database setup and initialization](deployment.md#database-setup-and-initialization).

The control record resides in D1's `_polaris_database` table; HTTP requests, scheduled jobs and WebSocket connections resolve the same active selection. A PostgreSQL-only deployment without D1 uses the deployed configuration and does not use this encrypted control table.

On Go, an explicit setup selection writes `database.json` in the data directory. It takes precedence over `POLARIS_DATABASE_URL` and `--database-url`; changing the environment at restart does not override it. The file can contain a plaintext PostgreSQL URL and is created with mode `0600`. Restrict Windows file and directory ACLs and protect backups as well.

### Deployment bindings

| Binding | Resource | Purpose |
| --- | --- | --- |
| `DB` | D1, optional | Selecting D1 during setup requires it; without it the deployment is PostgreSQL |
| `ASSETS` | Workers Assets | Frontend assets |
| `THEMES` | R2, optional | Third-party theme versions and assets; not required for the built-in interface |
| `UPTIME` | Analytics Engine, optional | Raw observations; SQL backfill also requires query credentials |

Manual deployment uses `backends/worker/cloudflare.config.ts`; database npm scripts default to `backends/worker/wrangler.toml`. Fork and button deployments use the root `wrangler.jsonc`, which declares no `DB`, `THEMES` or `UPTIME`; add those bindings under the Worker's **Settings → Bindings**. Direct Wrangler commands prefer JSONC when both formats exist. For a manual deployment, specify `--config backends/worker/wrangler.toml` for database operations and confirm the account and database first. Resource names can change; binding names must remain as shown. See [deployment](deployment.md#english).

### Worker environment variables

| Name | Default or range | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | No default | Secret for initial setup and management API Bearer authentication |
| `DATABASE_TYPE` | `d1` with D1 bound, otherwise `postgres`; may also be set to `postgres` | Deployed database type; may be omitted, and an active override takes precedence |
| `DATABASE_URL` | No default | Secret PostgreSQL URL such as `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`; a page-selected connection is stored separately in the D1 control record |
| `CF_ACCOUNT_ID` | No default | Account ID for Analytics Engine SQL backfill |
| `CF_API_TOKEN` | No default | Secret with account Analytics Read access for SQL backfill |
| `PBKDF2_ITERATIONS` | `3000`; 1–100000 | Password hash cost, configured as a string |
| `USAGE_PLAN` | `free`; also `paid` | Plan used for usage comparisons; does not enable a paid plan |
| `AUTOMATIC_NOTIFICATIONS_DISABLED` | Unset | Exactly `true` disables automatic notifications, not collection |

SQL backfill requires `UPTIME`, `CF_ACCOUNT_ID` and `CF_API_TOKEN`. Without them, backfill is disabled while database-backed current status, recent history and availability continue. Increasing `PBKDF2_ITERATIONS` increases authentication CPU cost; existing password records retain their own cost. Evaluate the Worker budget before changing it.

Use Worker secrets or a protected `--secrets-file` for deployment. Do not commit credentials or include them in screenshots.

### Console settings

Change settings in the console. An unset key uses its default; deleting an override restores that default. The server rejects unknown keys and invalid values.

| Key | Default | Limit or meaning |
| --- | --- | --- |
| `site.title` | `Uptime Polaris` | Non-empty, at most 120 characters |
| `site.description` | `服务可用性监控` | Non-empty, at most 300 characters |
| `site.icon` | `/api/public/icon` | Site path or HTTP(S) URL, at most 2048 characters |
| `site.syncMonitorIcons` | `false` | Synchronize monitor icons |
| `monitor.defaultIntervalSec` | `60` | Worker 60–86400 seconds; Go 5–86400 seconds |
| `monitor.defaultTimeoutMs` | `10000` | Worker 1000–60000 ms; Go 100–120000 ms |
| `monitor.defaultRetries` | `3` | 0–10, runtime failure confirmation threshold |
| `retention.availabilityDays` | `400` | 7–3650 days |
| `retention.detailDays` | `90` | 1–3650 days |
| `retention.eventDays` | `90` | 1–3650 days |
| `alerts.maintenanceWindows` | `[]` | Up to 32 one-time or weekly windows |
| `alerts.maintenanceNote` | Empty | Up to 300 characters |
| `maintenance.enabled` | `false` | Manual maintenance switch |
| `maintenance.scheduleEnabled` | `false` | Enables configured windows without deleting them when disabled |
| `maintenance.announcementTitle` | Empty | Pre-maintenance banner title, up to 120 characters |
| `maintenance.announcementDescription` | Empty | Pre-maintenance banner text, up to 1000 characters |
| `maintenance.title` | Empty | Active maintenance page title, up to 120 characters; empty uses the default |
| `maintenance.description` | Empty | Active maintenance page text, up to 1000 characters; supports multiline plain text |
| `security.sessionTtlDays` | `14` | 1–365 days |
| `security.loginMaxAttempts` | `8` | 3–100 |
| `security.loginWindowSec` | `300` | 60–86400 seconds |
| `security.allowAgentCommands` | `false` | Allows eligible remote Agent commands and configuration control |

Default interval and timeout apply when creating monitors; existing monitors keep their own values. The runtime reads `monitor.defaultRetries` for existing monitors too. Retention controls cleanup; it cannot recreate deleted history. Site icon and account avatar uploads are separate; `site.icon` is not the image file.

### Maintenance windows

The JSON example in [维护窗口格式](#维护窗口格式) shows both formats. `weekly` uses `day` 0–6, where 0 is Sunday, and `HH:MM` times; an end earlier than the start crosses midnight. `once` uses complete UTC timestamps and ends after it starts. All times are UTC; identical start and end values are invalid.

Edit switches, schedules and text under Settings → Maintenance. The announcement fields are for the banner before maintenance; the title and description are for the active maintenance page. Empty text uses defaults. Disabling a switch keeps the configured text and schedule.

Scheduled maintenance applies to all public presentation domains. During a window, the public root shows the maintenance page. Manual maintenance takes precedence until disabled; an enabled active schedule then resumes. Administration, login, setup, API and Agent communication remain available. Collection continues and automatic notifications are deferred; after the window, the current abnormal state is processed rather than replaying every recovered event. See [notifications](notifications.md#maintenance-and-automatic-dispatch).

### Settings API

`GET /api/admin/settings` returns values, defaults and form metadata. `PUT /api/admin/settings` accepts a key-value object; the authenticated curl example is in [通过 API 修改设置](#通过-api-修改设置). An unknown key or invalid value returns `invalid_settings` with field errors. Use `DELETE /api/admin/settings/:key` to remove an override.

### Agent configuration

Agents use their own `config.json` and installation metadata. See the [Agent guide](agents.md#configuration-and-remote-commands) for fields, precedence and platform differences.
