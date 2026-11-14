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

Worker 的 `/setup` 页面分为三步：部署检查、数据库配置、管理员账号。第一步检查必需的 `ADMIN_TOKEN`、`UPTIME` 和 `CONFIG` KV，D1、R2 为可选项；第二步选择数据库、填写连接地址并验证，成功后才能设置账号。Go 后端仍使用同一张初始化表单。

未绑定 D1 的 Worker 只提供 PostgreSQL；绑定 D1 后可选 D1 或 PostgreSQL。PostgreSQL 连接可直接在第二步填写，不需要预先配置 `DATABASE_URL`；页面保存的选择和加密连接地址存放在 `CONFIG` KV 命名空间。已有连接可以留空复用，页面不会回显原地址。连接格式示例：

```text
postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full
```

URL 需包含协议（`postgres://` 或 `postgresql://`）、用户名、密码、主机名和数据库名，密码中的特殊字符需做 URL 编码；查询参数仅支持 `sslmode`（`verify-full` 或 `require`，Go 本机回环测试可用 `disable`）。数据库验证会为空库建表，但不会创建管理员；账号只在最后一步创建。

Worker 将页面填写的 PostgreSQL 连接和数据库选择保存在 `CONFIG` KV 命名空间，连接地址用 `ADMIN_TOKEN` 派生的密钥加密。绑定 D1 与否不影响存储位置，后续添加 D1 也不会覆盖已保存的选择。仅使用 D1 或部署时设置的 `DATABASE_URL` 时，可以不绑定 KV。账号、会话、监控数据及初始化状态仍保存在所选数据库中。

KV 配置同步可能需要约一分钟或更久。页面会等到能够读取本次保存的配置后，再进入账号设置；同步期间保留输入，稍后点击“验证并继续”即可，无需重复填写。

加密密钥由 `ADMIN_TOKEN` 派生。请保留原密钥和配置存储，不要直接轮换密钥或删除 KV 中的 `database` 配置、数据库中的初始化记录。目前没有重加密命令；如果误换密钥，请通过受保护的 Secret 配置恢复原值。维护数据库前，先停止业务写入，并备份数据库、连接配置和密钥。不要在日志或截图中公开连接 URL。接口字段和错误码见[初始化数据库契约](api.md#初始化数据库契约)。

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
| `CONFIG` | KV，必需 | 保存数据库选择和加密连接地址，也存放后台设置 |
| `DB` | D1，可选 | 绑定后初始化可选择 D1；未绑定时按 PostgreSQL 处理 |
| `ASSETS` | Workers Assets | 服务前端资源 |
| `THEMES` | R2，可选 | 第三方主题版本与资源；内置界面不依赖它 |
| `UPTIME` | Analytics Engine，Worker 初始化必需 | 写入监控和 Agent 历史 |
| `ANALYTICS_SQL` | Analytics SQL，随部署配置提供 | 读取 AE 历史和每日归档，无需另设账号 ID 或 API Token |

手动部署的 CF CLI 读 `backends/worker/cloudflare.config.ts`，数据库 npm 脚本默认读 `backends/worker/wrangler.toml`。Fork 部署和按钮部署用根目录的 `wrangler.jsonc`，其中不声明 `DB`、`CONFIG`、`THEMES`、`UPTIME`，这些绑定在 Worker 的 **Settings → Bindings** 中添加。直接运行 Wrangler 时，JSONC 优先于 TOML；操作手动部署的数据库时，显式加 `--config backends/worker/wrangler.toml`，并核对账号和数据库。资源名称可以自己起，绑定名不要改。详细步骤见[部署指南](deployment.md)。

## Worker 环境变量

| 名称 | 默认或范围 | 配置方式与用途 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 无默认值 | Secret；首次初始化凭据，也是管理 API 的 Bearer Token |
| `DATABASE_TYPE` | 有 D1 时为 `d1`，否则为 `postgres`；也可显式设为 `postgres` | 普通变量；部署数据库类型，可省略，KV 保存的选择优先 |
| `DATABASE_URL` | 无默认值 | Secret；PostgreSQL 连接 URL，形如 `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`；也可在初始化页面填写，已保存的连接优先 |
| `CF_ACCOUNT_ID` | 可选 | 自动获取 Worker 绑定域名时使用的账号 ID |
| `CF_API_TOKEN` | 可选 | Secret；自动获取 Worker 绑定域名时使用的 API Token |
| `PBKDF2_ITERATIONS` | `3000`；允许 1–100000 | 密码哈希成本，作为字符串变量配置 |
| `USAGE_PLAN` | `free`，可选 `paid` | 用量页比较的计划，不会替账号开通付费套餐 |
| `AUTOMATIC_NOTIFICATIONS_DISABLED` | 未设置 | 精确等于字符串 `true` 时禁用自动通知，不停止采集 |

Worker 初始化要求绑定 `UPTIME`。延迟趋势、Agent 资源历史和每日归档通过 `ANALYTICS_SQL` 读取 AE；三份部署配置均已声明该绑定，部署后即可使用，无需添加查询凭据。直接使用 Wrangler 部署时，版本需为 4.145.0 或更高。

缺少 `ANALYTICS_SQL` 绑定时，实时状态、近期检查状态条和精确可用率继续工作；历史图表显示缺少绑定的提示，每日 AE 归档暂停。更新部署配置并重新部署后，可继续读取 AE 中仍保留的数据。

`PBKDF2_ITERATIONS` 会增加认证时的 CPU 开销。默认成本有限；调整前要结合 Worker 的实际运行预算验证，不能只凭本地计时判断生产环境能否承受。已有密码记录各自保存自己的哈希成本，改这个变量不会立刻重算所有密码。

手动部署的生产 Secret 可以通过 `--secrets-file` 提供；Fork 部署和按钮部署在 Worker 的 **Settings → Variables and Secrets** 中设置。步骤见[部署指南](deployment.md)。不要把这些值写进普通配置、提交记录或文档截图。

## 后台设置

登录控制台设置页修改。没保存的键用默认值；删掉某个键的覆盖值，就恢复默认。服务端统一拒绝未知键和非法值。覆盖值保存在 `CONFIG` KV 命名空间的 `settings` 键中，读取按 isolate 缓存 15 秒。

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

Worker setup has three steps: deployment check, database configuration, and administrator account. The check requires `ADMIN_TOKEN`, `UPTIME` and the `CONFIG` KV namespace; D1 and R2 remain optional. Configure and verify the database in the second step before creating an account in the last step. Go keeps its single setup form.

Without D1, Worker offers PostgreSQL only. With D1 bound, either database is available. A PostgreSQL URL can be entered in step two without a deployment `DATABASE_URL`; the saved selection and encrypted URL live in the `CONFIG` KV namespace. Leave the field blank to reuse a saved connection, which is never shown. For example: `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`. Percent-encode special characters in the password. Only `sslmode=verify-full` or `sslmode=require` is supported in the query string. Verification initializes an empty database but does not create an account.

Worker stores the database selection and page-entered PostgreSQL URL in the `CONFIG` KV namespace. The URL is encrypted with a key derived from `ADMIN_TOKEN`. This applies with or without D1; binding D1 later does not replace the saved selection. The `CONFIG` KV namespace is required and also stores console settings. Accounts, sessions, monitoring data and setup state remain in the selected database.

KV changes can take about a minute or longer to propagate. The page keeps your input and waits until it can read the saved configuration before opening the account step. Wait, then click “Verify and continue” again.

Encryption derives its key from `ADMIN_TOKEN`. Retain the original secret and configuration storage; do not directly rotate the secret or delete the KV `database` configuration or database setup records. No re-encryption command is available. If the secret was changed, restore the original through the protected deployment secret mechanism. Before database maintenance, stop business writes and back up the database, connection configuration and secret. Keep URLs out of logs and screenshots. See the [setup API contract](api.md#setup-database-contract).

On Go, an explicit setup selection writes `database.json` in the data directory. It takes precedence over `POLARIS_DATABASE_URL` and `--database-url`; changing the environment at restart does not override it. The file can contain a plaintext PostgreSQL URL and is created with mode `0600`. Restrict Windows file and directory ACLs and protect backups as well.

### Deployment bindings

| Binding | Resource | Purpose |
| --- | --- | --- |
| `CONFIG` | KV, required | Database selection, encrypted connection URL, and console settings |
| `DB` | D1, optional | Selecting D1 during setup requires it; without it the deployment is PostgreSQL |
| `ASSETS` | Workers Assets | Frontend assets |
| `THEMES` | R2, optional | Third-party theme versions and assets; not required for the built-in interface |
| `UPTIME` | Analytics Engine, required for Worker setup | Writes monitor and Agent history |
| `ANALYTICS_SQL` | Analytics SQL, included in deployment configuration | Reads AE history and daily archives without a separate account ID or API Token |

Manual deployment uses `backends/worker/cloudflare.config.ts`; database npm scripts default to `backends/worker/wrangler.toml`. Fork and button deployments use the root `wrangler.jsonc`, which declares no `DB`, `CONFIG`, `THEMES` or `UPTIME`; add those bindings under the Worker's **Settings → Bindings**. Direct Wrangler commands prefer JSONC when both formats exist. For a manual deployment, specify `--config backends/worker/wrangler.toml` for database operations and confirm the account and database first. Resource names can change; binding names must remain as shown. See [deployment](deployment.md#english).

### Worker environment variables

| Name | Default or range | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | No default | Secret for initial setup and management API Bearer authentication |
| `DATABASE_TYPE` | `d1` with D1 bound, otherwise `postgres`; may also be set to `postgres` | Deployed database type; may be omitted, and the selection saved in KV takes precedence |
| `DATABASE_URL` | No default | Secret PostgreSQL URL such as `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`; it can also be entered during setup, and the saved selection takes precedence |
| `CF_ACCOUNT_ID` | Optional | Account ID for fetching domains bound to the Worker |
| `CF_API_TOKEN` | Optional | Secret API Token for fetching domains bound to the Worker |
| `PBKDF2_ITERATIONS` | `3000`; 1–100000 | Password hash cost, configured as a string |
| `USAGE_PLAN` | `free`; also `paid` | Plan used for usage comparisons; does not enable a paid plan |
| `AUTOMATIC_NOTIFICATIONS_DISABLED` | Unset | Exactly `true` disables automatic notifications, not collection |

Worker setup requires the `UPTIME` binding. Latency charts, Agent resource history and daily archives read AE through `ANALYTICS_SQL`. All three deployment configurations include this binding; no query credentials are needed. Direct Wrangler deployments require version 4.145.0 or later.

If `ANALYTICS_SQL` is missing, live status, recent check status bars and exact availability continue. History charts show a missing-binding notice, and AE daily archiving pauses. Update the deployment configuration and redeploy to query retained AE data again. Increasing `PBKDF2_ITERATIONS` increases authentication CPU cost; existing password records retain their own cost. Evaluate the Worker budget before changing it.

Use Worker secrets or a protected `--secrets-file` for deployment. Do not commit credentials or include them in screenshots.

### Console settings

Change settings in the console. An unset key uses its default; deleting an override restores that default. The server rejects unknown keys and invalid values. Overrides live under the `settings` key in the `CONFIG` KV namespace and are cached per isolate for 15 seconds.

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
