# 常见问题

[English](#troubleshooting-guide)

先确认你访问的完整 URL（含协议和端口）、对应的后端和数据库。不同部署的数据可能不一样。

## 目录

- [初始化页面无法继续](#初始化页面无法继续)
- [忘记管理密码](#忘记管理密码)
- [运行很久仍没有监控数据](#运行很久仍没有监控数据)
- [Push 地址能打开，为什么没数据](#push-地址能打开为什么没数据)
- [Agent 没有数据或反复离线](#agent-没有数据或反复离线)
- [pa 或 polaris-agent 找不到](#pa-或-polaris-agent-找不到)
- [远程指令被拒绝或一直排队](#远程指令被拒绝或一直排队)
- [安装脚本返回 HTML 或下载失败](#安装脚本返回-html-或下载失败)
- [切换域名后机器停报](#切换域名后机器停报)
- [通知测试成功，故障时没收到](#通知测试成功故障时没收到)
- [通知语言与选择的不一致](#通知语言与选择的不一致)
- [页面显示语言键](#页面显示语言键)
- [主题安装或预览失败](#主题安装或预览失败)
- [仍无法定位](#仍无法定位)

## 初始化页面无法继续

1. **Worker 部署检查未通过**：初始化页面第一步会列出必需的 `ADMIN_TOKEN`、`UPTIME` 和可选的 D1、R2 的配置状态：
   - **D1 未配置**：不影响进入下一步。第二步默认 PostgreSQL，直接在页面填写连接地址并验证即可。
   - **初始化密钥未配置**：在 **Settings → Variables and Secrets** 中添加 Secret `ADMIN_TOKEN`。
   - **Analytics Engine 未配置**：启用 Analytics Engine 后，在 **Settings → Bindings** 中添加数据集，变量名填写 `UPTIME`。
   - 在 Cloudflare 保存并部署配置后，回到页面点击“重新检查”，必需项全部通过后才能点击“下一步”。检查失败时不会沿用上次的通过结果，已填写的初始化信息会保留。R2 不影响初始化，可稍后添加。
2. **Go 后端提示未配置密钥**：检查工作目录 `.env` 或进程环境变量中的 `POLARIS_SETUP_KEY`（未设置时回退到 `POLARIS_ADMIN_TOKEN`）。两者均未设置且尚未初始化时，请查看本次进程启动日志中的 `setup_key` 字段。修改后需重启进程。
3. 请确认输入的是初始化密钥，而不是管理员登录密码或 Agent Token。
4. 核对所选数据库：Worker 在绑定 D1 时可选 D1 或 PostgreSQL，未绑定 D1 时只有 PostgreSQL；Go 支持 SQLite 或 PostgreSQL。新选 PostgreSQL 需填写连接地址；已部署的 PostgreSQL 连接可留空复用，页面不会回显原地址。
5. 已有数据库提示表结构缺失时，请按对应后端执行迁移，不要反复重输凭据。首次初始化仅为空数据库建表，不会接管未知的表结构。

Worker 的第二步负责数据库配置，第三步才创建账号。未绑定 D1 时，连接会加密保存在随 Worker 部署的 `SETUP_CONFIG` Durable Object，无需在控制台配置 `DATABASE_URL`。若配置存储不可用，请重新部署当前版本，并保留 `SETUP_CONFIG` 绑定和迁移配置。Go 的 `database.json` 优先于启动参数和环境变量，排查时请一并检查，不要公开其中的地址。

`deployment_incomplete`（503）表示 Worker 缺少 `UPTIME` 绑定；`credential_unconfigured`（503）表示当前服务未配置初始化凭据；`invalid_setup_credential`（401）表示输入的凭据不匹配。Go 重启后需使用最新启动日志中的自动生成密钥。初始化完成后请前往 `/login` 登录，初始化接口不会创建第二个账号。

数据库初始化错误按以下方式处理（请勿在日志或截图中暴露含密码的连接地址）：

| 错误码 | 处理方式 |
| --- | --- |
| `deployment_incomplete` | 在 Worker 中添加 Analytics Engine 数据集绑定，变量名为 `UPTIME` |
| `invalid_database_type` | 重新加载页面，选择当前后端提供的数据库类型 |
| `invalid_database_url` | 检查 PostgreSQL 连接地址格式（如 `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`），确认包含用户名、密码和数据库名，密码特殊字符已做 URL 编码，且查询参数仅含支持的 `sslmode` |
| `database_connection_failed` | 检查连接地址、数据库访问权限、网络和证书后重试 |
| `database_initialization_failed` | 检查目标数据库的建表权限和已有结构；保留已有数据，不要清空后盲目重试 |
| `database_configuration_failed` | 检查后端持久配置的读取、写入或解密条件，见[配置参考](configuration.md) |
| `setup_in_progress` | 等待正在进行的初始化结束，再重新加载会话；不要在多个标签页同时提交 |

Worker 初始化中断后，若页面已锁定数据库类型并显示使用已保存连接，请使用原管理员用户名和密码继续提交。此时目标账号可能已写入，页面会继续完成同一次初始化，不再允许更换数据库。持有租约的进程中断时，最多等待 10 分钟后重试；请勿删除 `pending` 控制记录。

## 忘记管理密码

账号设置中修改密码需要验证当前密码。若已忘记密码，无法通过设置表单恢复。

手动部署的 Worker D1 环境可使用命令行工具重置：

```sh
npm run user:list -- --remote
npm run user:create -- --remote --username your-name --password 'a-new-strong-password'
```

该工具会为同名用户更新密码并清除登录锁定记录；若用户不存在则创建新账号。工具默认读取 `backends/worker/wrangler.toml`，执行前请确认目标账号与数据库并做好备份。Fork 部署和按钮部署的 `wrangler.jsonc` 不包含 `database_id`，如需使用该工具，请先在本地配置中填入目标 D1 的 `database_id`。命令行中的密码会留在终端历史中，请勿在共享终端或开启命令审计的环境中直接粘贴明文密码。

这个工具不适用于 Worker PostgreSQL，也不适用于 Go 的 SQLite 或 PostgreSQL。Go 目前没有忘记密码恢复命令；`POLARIS_ADMIN_TOKEN` 是独立的管理凭据，代替不了账号表单要求的旧密码。不要靠清空业务数据库或重复初始化来恢复账号；先保留数据库备份，确认还有哪些管理凭据可用。

## 运行很久仍没有监控数据

1. 确认访问的是预期站点和端口。
2. 看监控是否启用，目标和检查来源有没有保存正确。
3. 检查 Cron 配置、最近的运行日志、数据库和外部请求错误。
4. 来源是 Agent 的监控，先确认机器在线、能领取任务并访问目标。
5. Push 需要被监控端主动发 POST；只等不会有新心跳。

图表只显示监控创建后采集到的数据。

## Push 地址能打开，为什么没数据

浏览器打开通常发的是 GET，这个端点返回 405。改用 `curl -X POST` 或任务程序发 POST。检查返回 JSON 里是不是 `ok: true`，并确认 Token 属于当前环境。

Push 不做延迟测试，`ping` 参数不代表系统测量。上报后很快超时，就对比实际任务周期和监控配置，再检查时钟、网络和调度状态。

## Agent 没有数据或反复离线

在目标机器上依次检查：

```sh
pa status
pa logs -n 200
pa command status
```

- 服务有没有启动，用的是不是预期的 `config.json`。
- `endpoint` 是不是机器能访问的长期站点地址，Token 是不是来自这台机器的条目。
- 域名解析、TLS、代理、防火墙和 WebSocket 是否允许连接。
- 采样和上报间隔是否满足 `1 <= sample <= report <= 1800`。
- 是不是有两个实例共用同一个 Token，或者终端环境变量覆盖了文件。
- 是不是因为网卡、挂载点过滤，期望的指标根本没采。

默认 60 秒上报时，超过约 180 秒没有报告会判失联；阈值会随配置间隔变化。历史曲线缺口和最后快照不是同一个问题，先看最新报告时间。

## `pa` 或 `polaris-agent` 找不到

重新打开终端，让 PATH 刷新。用实际二进制路径执行 `command status`；必要时执行 `command register`。命令名被其他程序占用时，注册器会拒绝覆盖，可以换一个目录并明确管理 PATH。

系统安装的服务操作需要相应权限。手动模式或只有开机任务的安装没有完整的服务管理能力，`start` 被拒绝不代表 Agent 二进制坏了。

## 远程指令被拒绝或一直排队

检查 `security.allowAgentCommands`、Agent 在线状态和声明的能力。`restart`、`upgrade` 还要求 Agent 处于能安全退出并重启的托管等级 A。Docker 不支持就地更新。

自动更新开关不可用时，先看开关下面的说明。Windows 需要支持托管更新的 Agent，并使用系统或用户计划任务安装。可以通过控制台的重新安装命令更新程序；手动运行模式没法自动重启。Windows 更新失败时，检查程序旁的 `polaris-agent.update.log`。

入队不代表执行完成，继续看回执和机器日志。托管能力不够时，按控制台提示重新安装 Agent。

## 安装脚本返回 HTML 或下载失败

确认访问的是 `/install.sh` 或 `/install.ps1`，并且当前前端把它们代理到了正确的 Worker。生产资产配置要让这些入口先进入 Worker，不能统一回退成 `index.html`。

Windows 引导脚本还要访问 `/api/public/agent/download/install.ps1`；下载失败时检查这个路径通不通。

`release_not_found` 或 `release_asset_missing` 表示暂时没有可下载的稳定版本，或者所选平台不可用。`github_rate_limited` 表示 GitHub API 限流；检查网络和限额后重试。下载条件见[部署指南](deployment.md#agent-下载)。

## 切换域名后机器停报

网页生成的新命令用新 origin，但已经装好的机器保留旧 `endpoint`。更新目标机器的配置并重启服务，再看新入口的报告时间。代理要保留正确的 Host，并放行 API 和 WebSocket。

## 通知测试成功，故障时没收到

核对渠道是否启用、分组是否匹配、维护窗口是否命中、自动通知是否被禁用，以及监控有没有真的产生新的状态变化。Agent 资源告警还要达到持续时间。

已有失败记录就按提供商错误排查。空分组范围表示全部监控，删除或移动分组后要重新核对。分组与范围见[通知指南](notifications.md)。

## 通知语言与选择的不一致

打开对应渠道的编辑页面，检查并保存渠道自己的消息语言，再发测试消息。切换后台界面语言不会改已保存渠道的语言。通过 API 修改时，确认 `config.language` 和其他渠道配置一起提交；省略语言默认英语。消息里的监控名称、目标和原始检查详情保留原文，不会自动翻译。语言设置见[消息语言](notifications.md#消息语言)。

## 页面显示语言键

确认网页和后端属于同一版本、同一环境，用完整的同版本程序和网页资源，再重新加载页面。

## 主题安装或预览失败

Worker 检查 R2 绑定，Go 检查主题目录是否可写。再检查 ZIP 根目录的 `polaris-theme.json`、入口路径、包大小、文件数量和资源引用。未知清单字段和非法默认值会被拒绝。

预览在隔离窗口里运行，部分外部资源和需要本站权限的行为可能受限。检查主题包是否完整，以及对应版本有没有应用。

## 仍无法定位

记录完整访问地址、发生时间、监控类型、检查来源、最后成功时间、HTTP 状态和业务错误码。提供脱敏日志时，移除管理密钥、机器 Token、Push 地址、通知凭据和数据库 URL，不要直接共享整个密钥文件或数据库导出。

## Troubleshooting guide

This English section summarizes the Chinese guide and links to more detailed procedures where needed.

First identify the complete site URL, backend, and database. Different deployments can contain different data. Before sharing logs, remove credentials, Push URLs, notification secrets, and database URLs.

### Setup and accounts

- **Worker deployment check not passed:** the first step lists required `ADMIN_TOKEN` and `UPTIME`, plus optional D1 and R2 bindings.
  - **D1 missing:** this does not block setup. The second step defaults to PostgreSQL; enter and verify its connection URL directly on the page.
  - **Setup key missing:** under **Settings → Variables and Secrets**, add the secret `ADMIN_TOKEN`.
  - **Analytics Engine missing:** enable Analytics Engine, then add a dataset in **Settings → Bindings** with the binding name `UPTIME`.
  - Save and deploy the configuration in Cloudflare, then select **Re-check**. All required items must pass before continuing. Failed checks do not reuse an earlier passing result, and form entries are preserved. R2 can be added later.
- **Go reports no setup key:** check `POLARIS_SETUP_KEY` in the working directory's `.env` or the process environment (falling back to `POLARIS_ADMIN_TOKEN`). If neither is set and the server is uninitialized, use the `setup_key` field in the current startup log. Restart after changing the environment or `.env`. `credential_unconfigured` means no setup credential is available; `invalid_setup_credential` means the supplied value does not match. A restart invalidates the previous automatically generated key.
- **Database choice:** Worker offers D1 and PostgreSQL when D1 is bound and PostgreSQL only otherwise; Go supports SQLite or PostgreSQL. Enter a PostgreSQL URL when selecting a new connection, for example `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`. Leave it blank only to reuse a deployment-configured PostgreSQL connection; the original URL is never shown. Setup initializes a fresh database, not an unknown existing schema.
- **Persistent selection:** configure the database in step two; step three creates the account. Without D1, Worker encrypts the connection configuration in the deployment-provided `SETUP_CONFIG` Durable Object. If configuration storage is unavailable, redeploy the current version with the `SETUP_CONFIG` binding and migration retained. No deployment `DATABASE_URL` is required. Go's saved `database.json` takes precedence over flags and environment variables; inspect it securely when diagnosing the active connection.
- **Forgotten password:** manual Worker D1 deployments provide `npm run user:list -- --remote` and `npm run user:create -- --remote --username your-name --password 'a-new-strong-password'`. These commands use `backends/worker/wrangler.toml`: confirm the target and back it up first. Fork and button deployments keep no `database_id` in `wrangler.jsonc`; fill in the target D1 `database_id` locally before using the tool. Passwords passed on the command line can appear in process listings and shell history. This tool does not support Worker PostgreSQL or Go. Go has no password recovery command; preserve a backup and check available administrative credentials rather than resetting the database.

| Setup error | Action |
| --- | --- |
| `deployment_incomplete` | Bind an Analytics Engine dataset as `UPTIME` in the Worker |
| `invalid_database_type` | Reload and select a database supported by the active backend |
| `invalid_database_url` | Check the PostgreSQL URL format (`postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`), that it includes a username, password and database name, that special characters in the password are percent-encoded, and that the query string contains only a supported `sslmode` |
| `database_connection_failed` | Check connectivity, access permissions and certificates, then retry |
| `database_initialization_failed` | Check schema permissions and existing objects; preserve data instead of clearing the target |
| `database_configuration_failed` | Check persistent configuration access or decryption; see [configuration](configuration.md#english) |
| `setup_in_progress` | Wait for the active setup to finish, then reload the session; avoid concurrent submissions |

Never include a credential-bearing connection URL in shared logs or screenshots.

If Worker setup was interrupted and the database choice is locked, resubmit the original administrator username and password to resume the same setup. The account may already exist in the selected database. If the lease holder crashed, wait up to 10 minutes before retrying. Do not delete a pending control record.

### Missing checks or Agent data

- Confirm the monitor is enabled, the target and check source are correct, and the expected environment is open. Inspect scheduler configuration and recent job errors.
- Push requires a POST to the monitor's own URL. GET returns 405 and does not record a heartbeat. Check `ok: true`, the token, and the reporting interval.
- For an Agent, inspect `pa status`, `pa logs -n 200`, and `pa command status`. Check its endpoint, token, connection, reporting interval, permissions, and whether multiple instances share the same token. A domain change does not update installed Agents; update their endpoint and restart them.
- If `pa` is missing, reopen the terminal or use the installed binary path. `command register` can register the command without overwriting an existing program. Service controls depend on installation mode and permissions.
- For queued or rejected remote commands, check `security.allowAgentCommands`, connectivity, capabilities, and the service tier. Restart and upgrade need a managed tier A installation; Docker does not support in-place upgrade. Read the receipt and Agent logs.
- If an installer returns HTML or a download fails, verify that the proxy routes `/install.sh`, `/install.ps1`, and `/api/public/agent/download/install.ps1` to the backend. `release_not_found` or `release_asset_missing` means no stable version is available for download or the selected platform is unavailable; `github_rate_limited` means the API quota was exceeded. See [deployment](deployment.md#agent-downloads).

### Notifications, presentation, and themes

- A successful notification test confirms only that particular delivery. For a missing automatic alert, check channel enablement, group scope, maintenance, automatic notification settings, and whether a new state change occurred. Agent resource rules also require the configured duration.
- If a message uses the wrong language, edit and save the channel's own language, then send a test. Changing the console language does not update a saved channel. API updates replace `config`, so include the other channel settings as well. Names, targets, and original check details are not translated. See [notification languages](notifications.md#choose-the-message-language).
- If a page displays translation keys, confirm the frontend and backend versions and environment, and reload the page.
- For a theme installation or preview failure, check the theme storage, root `polaris-theme.json`, entry paths, archive limits, and declared capabilities. Preview runs in an isolated window, so some external resources and actions requiring site permissions can be restricted.
