# Uptime Polaris Go 后端

[English](#english)

Go 后端和 Worker 共用前端，自己负责 HTTP API、网络探测、Agent 协议和主题存储。可执行文件内置界面，运行时需要一个可写的数据目录。项目概览见[根 README](../../README.md)。

## 安装与启动

从项目 [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) 页面选择对应操作系统和架构的程序。下载后把程序命名为 `polaris`（Windows 为 `polaris.exe`），Linux 和 macOS 还要授予执行权限。

在程序目录启动：

```sh
./polaris --data-dir ./data
```

Windows PowerShell：

```powershell
.\polaris.exe --data-dir .\data
```

打开 `http://127.0.0.1:8080/setup`，用启动日志里的初始化密钥创建管理员。也可以用 `POLARIS_SETUP_KEY` 预先设置密钥；没设就用 `POLARIS_ADMIN_TOKEN`。两个都为空、环境又没初始化时，程序会生成一个只在本次进程有效的初始化密钥。初始化后不再生成密钥。

首次初始化可以选 SQLite 或 PostgreSQL。显式选择会写进数据目录的 `database.json`，优先于环境变量和启动参数。这个文件可能包含明文 PostgreSQL URL，要保护文件和备份；POSIX 权限为 `0600`，Windows 还要限制 ACL。重启还没初始化的程序后，用最新日志里的密钥。

## 部署配置

程序读取进程当前工作目录里的 `.env`。优先级从高到低：命令行参数 > 进程环境变量 > `.env` > 默认值。服务管理器或容器仍可以直接传环境变量。

可以复制 [`.env.example`](.env.example) 到启动目录再改。`.env` 不存在时正常启动；格式错误时停止启动。支持 `KEY=value`、单双引号、行尾注释和 `export` 前缀，不执行命令，也不展开变量。含空格或特殊字符的值要加引号。保护 `.env` 和带初始化密钥的日志，不要提交或公开。

| 环境变量 | 命令行参数 | 默认值 |
| --- | --- | --- |
| `POLARIS_ADDR` | `--addr` | `127.0.0.1:8080` |
| `POLARIS_DATA_DIR` | `--data-dir` | `./data` |
| `POLARIS_FRONTEND_DIR` | `--frontend-dir` | 空；默认使用内置界面，设置后使用指定目录 |
| `POLARIS_DATABASE_URL` | `--database-url` | 数据目录中的 SQLite 文件 |
| `POLARIS_CONCURRENCY` | `--concurrency` | `32`，允许 1～1024 |
| `POLARIS_TRUST_PROXY` | `--trust-proxy` | `false` |
| `POLARIS_SETUP_KEY` | 无 | 初始化凭据；未设置时使用 `POLARIS_ADMIN_TOKEN` |
| `POLARIS_ADMIN_TOKEN` | 无 | 可选的管理 API Bearer 凭据 |

PostgreSQL 连接串形如 `postgresql://user:password@host:5432/database?sslmode=verify-full`。启动时创建 Go 自己的表；SQLite 和 PostgreSQL 的数据含义一致。主题资产始终在数据目录里，不会存进 PostgreSQL。

HTTPS 反向代理要保留 `Host`。只有可信代理隔离了后端直连入口，并且能可靠设置 `X-Forwarded-Proto` 时，才启用 `--trust-proxy`。这个设置会让 HTTPS 会话 Cookie 带上 `Secure`，并生成 HTTPS 的 Agent 安装地址。

备份时先停服务，再备份整个数据目录。PostgreSQL 部署还要备份数据库。切换数据库后保留原数据和主题目录，检查新服务的登录、监控和主题，再结束旧服务。

## 原生探测与 API

匿名 `GET /api/capabilities` 返回 `runtime: "go"`、执行源 `server`、能执行的原生类型和主题文件系统能力。后台仍使用现有的 `/api/monitors`、`/api/overview`、`/api/cron/tick` 和 `/api/cron/sync`。

监控支持 HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket、Push 和 Agent。最短间隔 5 秒，超时 100～120,000 ms。执行源只接受 `server` 或 `agent`；Agent 来源仍要声明对应探测能力。

DNS、TLS 和 WebSocket 的 `options_json` 示例：

```json
{"dns":{"recordType":"A","expected":"192.0.2.10","resolver":"127.0.0.1:5353"},"check_source":{"type":"server"}}
```

DNS 目标是主机名；`resolver` 可以省略，用系统解析器，也可以填 `host:port` 或 HTTPS JSON DoH 地址。

```json
{"serverName":"status.example.com","check_source":{"type":"server"}}
```

TLS 目标是 `host:port`，用 `warn_days` 控制证书到期预警。证书不受信任、主机名不匹配或即将到期时返回 WARN；握手失败返回 DOWN。SSL 附加项每天通过真实 TLS 握手读取对端证书。

```json
{"headers":{"Authorization":"Bearer <目标凭据>"},"send":"ping","expect":"pong","check_source":{"type":"server"}}
```

WebSocket 目标是 `ws://` 或 `wss://` URL。UDP 接受 `send`、`expect` 和 `encoding: "text" | "hex"`，发出去后必须收到应答。Push 只接受 POST，不使用 `ping` 参数，所有公开延迟字段保持 `null`。

账号、公开范围、分组标签、维护窗口、域名映射、通知和主题都在管理界面配置。`/api/admin/usage` 返回 Go 运行状态。

## 数据库迁移

后台数据库设置支持把当前 Go SQLite 数据复制到独立的 PostgreSQL 数据库。接口为 `/api/admin/database-migration/preview` 和 `/execute`，请求体分别是 `{ "url": "..." }`、`{ "url": "...", "confirmed": true }`。

预览只读。执行时在目标事务里建表、复制数据并校验行数；拒绝非空目标和不匹配的表结构。源端用一致性快照，限制为每表 5,000 行、合计 10,000 行和 8 MiB。复制不会改当前运行时配置；主题资产继续用原数据目录。

迁移期间必须停止源库写入，并一直保持到切换完成。维护通知开关不会停止调度、Push、Agent 或管理写入。生产切换走离线模式：

1. 停止所有使用该 SQLite 库的 Go 后端和自动重启器，挡住入口流量；备份整个数据目录和目标库。
2. 在服务原来的工作目录里设置目标地址，用同一个二进制和原数据目录执行预览和复制。离线模式不监听 HTTP，也不启动后台调度：

   ```powershell
   $env:POLARIS_MIGRATION_TARGET = 'postgresql://user:password@db.example/polaris?sslmode=verify-full'
   .\polaris.exe --data-dir .\data --migration preview
   .\polaris.exe --data-dir .\data --migration execute
   Remove-Item Env:POLARIS_MIGRATION_TARGET
   ```

   离线迁移不读 `database.json`；源库不是数据目录里的默认 SQLite 文件时，用 `--database-url` 明确指定原 SQLite 路径。实际凭据通过受保护的环境变量注入，不要写进脚本或提交到仓库。
3. 确认执行成功和复制数量，服务和自动重启器继续停着。初始化时显式选过 SQLite 的话，数据目录里的 `database.json` 优先于 `POLARIS_DATABASE_URL`；只改环境变量完成不了切换。保留源库、主题目录和受保护的 `database.json` 备份。在受保护环境里编辑原数据目录的 `database.json`，把 `url` 改成目标 PostgreSQL 连接，保留 `0600` 权限；Windows 上限制文件和目录 ACL。格式如下，实际凭据不要提交，也不要写进公开日志：

   ```json
   { "url": "postgresql://user:password@host:5432/database?sslmode=verify-full" }
   ```

   也可以在停服、备份后，把原 `database.json` 改名移到受保护的备份路径，再用 `POLARIS_DATABASE_URL` 配置目标；不要盲目删掉这个文件。之后继续用原数据目录和主题目录启动服务。
4. 验证登录、监控、历史、主题和最新的 Agent 报告，再恢复流量和自动重启器。回退时先停目标服务和写入，恢复原数据库和对应的 `database.json`，再按原配置启动；不要让两个写入源同时运行。复制失败时目标事务会回滚，可以按原配置恢复旧服务。

后台复制不会自动冻结源库或切换配置。源快照之后的写入不会同步到目标，不能用运行中服务的一次复制代替上面的停写窗口。

远程迁移要求 TLS。只有回环 PostgreSQL 测试实例可以用 `sslmode=disable`。域名映射可以手动保存；Cloudflare 已绑定域名的查询在 Go 返回 `available: false`。

## Agent 与主题资产

Agent 命令默认关闭，支持 `upgrade`、`restart`、`re_report` 和 `check_update`。每台机器有独立 Token。

Agent 安装和更新需要访问 GitHub 下载服务；所选平台没有可用版本，或者网络不通，安装会失败。

主题只接受 schema 2 ZIP 包，根目录必须有 `polaris-theme.json`。解压限制为 500 项、解压后合计 32 MiB。删除主题会解除页面引用并移除文件。安装、配置和预览见[主题指南](../../docs/themes.md)。

## English

The Go backend serves the shared frontend, HTTP API, native checks, Agent protocol and themes without Worker or Cloudflare bindings. The executable includes the web interface and needs a writable data directory. See the [documentation index](../../docs/README.md#english) and [deployment guide](../../docs/deployment.md#english).

### Install and start

Download the program for your operating system and architecture from the project's [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) page. Rename it to `polaris` (`polaris.exe` on Windows), grant execute permission on Linux or macOS, then run `./polaris --data-dir ./data` or `.\polaris.exe --data-dir .\data` in PowerShell.

Open `http://127.0.0.1:8080/setup` and use the setup key from the startup log. You can set `POLARIS_SETUP_KEY` in advance; otherwise setup accepts `POLARIS_ADMIN_TOKEN`. If neither is configured and no administrator exists, the service generates a key valid only for setup in that process. Restarting an uninitialized service generates a new key.

Choose SQLite or PostgreSQL during first setup. An explicit selection is saved in `database.json` in the data directory and takes precedence over flags and environment variables. It can contain a plaintext PostgreSQL URL. Protect the file and backups; use POSIX mode `0600` and restrict Windows ACLs.

| Environment variable | Flag | Default or purpose |
| --- | --- | --- |
| `POLARIS_ADDR` | `--addr` | `127.0.0.1:8080` |
| `POLARIS_DATA_DIR` | `--data-dir` | `./data` |
| `POLARIS_FRONTEND_DIR` | `--frontend-dir` | Empty; use the built-in interface unless a directory is specified |
| `POLARIS_DATABASE_URL` | `--database-url` | SQLite file in the data directory |
| `POLARIS_CONCURRENCY` | `--concurrency` | `32`; range 1–1024 |
| `POLARIS_TRUST_PROXY` | `--trust-proxy` | `false` |
| `POLARIS_SETUP_KEY` | none | Setup credential; falls back to `POLARIS_ADMIN_TOKEN` |
| `POLARIS_ADMIN_TOKEN` | none | Optional admin API bearer credential |

### Deployment and operation

The CLI reads `.env` from the current working directory; see [`.env.example`](.env.example). Precedence is flags > process environment > `.env` > defaults, except that persisted `database.json` still takes precedence for the database. A missing `.env` is allowed; malformed input stops startup. The format supports `KEY=value`, single- or double-quoted values, trailing comments and the `export` prefix; commands are never executed and variables are not expanded. Quote values containing spaces or special characters. Protect `.env` and logs containing setup keys, and never commit them.

The executable includes the web interface and requires persistent, writable storage for data and themes. Agent installation uses GitHub downloads. Native ICMP requires raw-socket permission on the host.

For HTTPS, preserve `Host` at the reverse proxy. Enable `--trust-proxy` only if the backend cannot be reached directly by untrusted clients and the proxy reliably sets `X-Forwarded-Proto`. Stop the service before backing up its data directory; also back up PostgreSQL when used. The full configuration is in the table above, and common backup and deployment guidance is in [operations](../../docs/operations.md#operations-guide).

### Checks and public APIs

`GET /api/capabilities` exposes the available native check types and sources. Go supports HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket, Push and Agent monitors. Native ICMP depends on permissions; Agent sources must advertise the required capability. The minimum interval is 5 seconds and the timeout range is 100–120,000 ms. DNS, TLS and WebSocket configuration examples are above. Push accepts POST, ignores `ping`, and reports public latency as `null`.

Agent commands are disabled by default and accept `upgrade`, `restart`, `re_report` and `check_update`. Themes use schema 2 ZIP packages stored in the data directory. See the [theme guide](../../docs/themes.md#english) for installation, configuration and preview.

### SQLite to PostgreSQL

The Go migration is independent of Worker's migration tool. Preview is read-only; execution copies from a consistent SQLite snapshot into a transaction on the target, rejecting nonempty or mismatched targets. Limits are 5,000 rows per table, 10,000 total and 8 MiB. Copying does not switch the application and does not move theme files.

For a production cutover, stop all Go backend processes and restarters using the source, block incoming writes, and back up the data directory and target. Keep the source stopped until the switch is complete. In the original working directory, use the same binary and data-directory arguments with `POLARIS_MIGRATION_TARGET` set, then run `--migration preview` and `--migration execute` as shown above. Offline migration ignores `database.json`; use `--database-url` to specify the source SQLite file when it is not the default data-directory file. Supply credentials via a protected environment variable. Offline migration does not listen for HTTP or start scheduling.

Inspect the result and keep the service and restarter stopped. An explicit SQLite setup selection creates `database.json`, which overrides `POLARIS_DATABASE_URL`; changing the environment alone does not complete the cutover. Preserve the source database, theme directory and a protected `database.json` backup. In a protected environment, edit `url` in the original data directory's `database.json` to the target PostgreSQL connection, using the JSON format shown in step 3 above. Keep mode `0600`, restrict Windows file and directory ACLs, and do not put real credentials in public logs or version control.

Alternatively, after stopping the service and backing up, move or rename the original `database.json` to a protected backup location, then configure the target with `POLARIS_DATABASE_URL`; do not blindly delete it. Start the service with the original data and theme directories. Check login, monitoring, history, themes and Agent reporting before restoring traffic and restarters. For rollback, stop the target service and writes first, restore the original database and matching `database.json`, then start with the original configuration. Remote targets require TLS; `sslmode=disable` is allowed only for loopback PostgreSQL test instances. Do not run both sources as independent writers.
