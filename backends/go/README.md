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

## Docker 部署

镜像支持 `linux/amd64` 和 `linux/arm64`。启动容器：

```sh
docker run -d --name uptime-polaris --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v uptime-polaris-data:/data \
  ghcr.io/xinglingqaq/uptimepolaris:latest

docker logs uptime-polaris
```

打开 `http://127.0.0.1:8080/setup`，使用日志中的初始化密钥完成设置。日志包含密钥，请妥善保管。也可以将 `latest` 换成具体版本标签，例如 `v0.1.0`。

数据和主题保存在 `/data`，请备份数据卷。如果使用宿主机目录挂载，确保目录可供 UID 和 GID `65532` 写入。

## 在后台更新

官方程序支持 Linux、Windows 和 macOS，均包含 amd64 与 arm64。启动命令保持不变；在后台顶部打开版本浮层，点击“立即更新”。程序会校验下载文件，短暂重启服务，并检查新版本和数据库连接。更新完成后点击“刷新页面”加载新界面。

“自动更新”默认关闭。开启后每 6 小时检查正式版本；同一版本失败后需要手动重试。原生部署把新程序存入数据目录的 `updates` 子目录，Windows 也无需覆盖运行中的 exe。请保留原始启动程序、数据目录和原启动参数；服务管理器继续启动原始程序。该目录需要可写且允许执行程序。

新版本启动失败时会恢复上一程序。自动更新只接受声明了相同数据兼容要求的版本；需要更改数据格式的版本按[运维指南](../../docs/operations.md#升级流程)手动升级。程序恢复不会撤销数据库写入，仍需定期备份 SQLite 或 PostgreSQL。自定义 `--frontend-dir` 的界面文件需自行同步更新。

Docker 需要独立更新服务。下载 [compose.yaml](compose.yaml)，在同一目录创建受保护的密钥目录，然后启动：

```sh
mkdir -p .secrets
chmod 700 .secrets
openssl rand -hex 32 > .secrets/updater-token.txt
chmod 644 .secrets/updater-token.txt
docker compose up -d
```

Windows PowerShell 可用以下命令创建密钥，再执行 `docker compose up -d`：

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
New-Item -ItemType Directory -Force .secrets | Out-Null
[IO.File]::WriteAllText((Join-Path (Get-Location) '.secrets/updater-token.txt'), ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant())
```

Linux 上由 `0700` 的父目录限制宿主机访问；文件自身允许容器里的非 root 应用读取。为 Windows 的 `.secrets` 目录限制 ACL，只允许部署管理员和 Docker 读取。Docker Desktop 使用 Linux 容器；镜像支持 linux/amd64 和 linux/arm64。已有容器接入时，先停止旧服务，核对 Compose 的数据卷映射，使用原数据卷；不要启动一套空的数据卷代替现有数据。可通过 `POLARIS_IMAGE` 和 `POLARIS_TAG` 指定镜像仓库和起始版本。

只有更新服务挂载 Docker socket；该权限可以管理宿主机容器。将它与应用放在可信网络内，保持 8091 端口不对外发布，并保护 `updater-token.txt`。应用通过 `POLARIS_UPDATER_URL` 和 `POLARIS_UPDATER_TOKEN_FILE` 连接更新服务。自动更新会保留环境变量、端口、数据卷和网络配置，停止的旧容器以 `uptime-polaris-backup-*` 保留。新容器健康检查失败时恢复旧容器，期间数据卷保持原样。

更新服务的可选环境变量：

| 变量 | 默认值 |
| --- | --- |
| `POLARIS_UPDATE_CONTAINER` | `uptime-polaris` |
| `POLARIS_UPDATE_IMAGE` | `ghcr.io/xinglingqaq/uptimepolaris` |
| `POLARIS_UPDATE_HEALTH_URL` | `http://uptime-polaris:8080/api/public/health` |
| `POLARIS_UPDATE_DATA_DIR` | `/updates` |
| `POLARIS_UPDATER_ADDR` | `0.0.0.0:8091` |
| `POLARIS_UPDATER_TOKEN_FILE` | `/run/secrets/updater-token` |
| `POLARIS_DOCKER_SOCKET` | `/var/run/docker.sock` |

手动更新 Compose 部署前，将 `POLARIS_TAG` 调整到目标版本，并保留更新后的配置，避免下次 `docker compose up` 切回旧标签。更新服务自身通过 `docker compose pull updater` 和 `docker compose up -d --no-deps updater` 升级。确认无需回退后，可清理已停止的备份容器，保留数据卷。原生部署只清理 `updates/native.json` 中 `active` 和 `previous` 均未引用的版本目录。

Docker 托管更新要求固定宿主机端口，并关闭容器自动删除。使用 `-P`、随机端口或 `--rm` 的容器需先调整部署配置，再接入更新服务。

## 部署配置

反向代理或 Cloudflare Access 登录见[外部认证](../../docs/external-auth.md)。默认关闭；Go 支持 `trusted-header` 与 `cloudflare-access` 两种模式。

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
| `POLARIS_TRUSTED_PROXIES` | `--trusted-proxies` | 空；不信任转发的客户端 IP |
| `POLARIS_SETUP_KEY` | 无 | 初始化凭据；未设置时使用 `POLARIS_ADMIN_TOKEN` |
| `POLARIS_ADMIN_TOKEN` | 无 | 可选的管理 API Bearer 凭据 |
| `POLARIS_AUTH_MODE` | 无 | `disabled`；`trusted-header` 和 `cloudflare-access` 的配置见[外部认证](../../docs/external-auth.md) |
| `POLARIS_AI_KEY_FILE` | 无 | AI 渠道与订阅的加密密钥文件；PostgreSQL 使用 AI 监控或订阅时必填，SQLite 默认用数据目录的 `ai-credential.key` |

PostgreSQL 连接串形如 `postgresql://user:password@host:5432/database?sslmode=verify-full`。启动时创建 Go 自己的表；SQLite 和 PostgreSQL 的数据含义一致。主题资产始终在数据目录里，不会存进 PostgreSQL。

HTTPS 反向代理要保留 `Host`。只有可信代理隔离了后端直连入口，并且能可靠设置 `X-Forwarded-Proto` 时，才启用 `--trust-proxy`。这个设置会让 HTTPS 会话 Cookie 带上 `Secure`，并生成 HTTPS 的 Agent 安装地址。

代理后的登录限流需要识别访客 IP。用 `POLARIS_TRUSTED_PROXIES` 配置逗号分隔的代理 CIDR，例如本机代理使用 `127.0.0.1/32,::1/128`。代理应覆盖或正确追加 `X-Forwarded-For`；服务从右向左跳过受信代理，以首个非受信地址作为客户端。未列入范围的直连请求会忽略转发头。容器部署应填写实际代理地址范围，避免信任整个公网。

备份时先停服务，再备份整个数据目录。PostgreSQL 部署还要备份数据库。切换数据库后保留原数据和主题目录，检查新服务的登录、监控和主题，再结束旧服务。

AI 密钥文件须为受保护的 32 字节原始随机数据，多实例共享相同内容，并与数据库配套备份。添加渠道、模型和恢复密钥的方法见 [AI 模型监控](../../docs/ai-monitoring.md)。不使用 AI 监控时无需配置此项。

## 原生探测与 API

匿名 `GET /api/capabilities` 返回 `runtime: "go"`、执行源 `server`、能执行的原生类型和主题文件系统能力。后台仍使用现有的 `/api/monitors`、`/api/overview`、`/api/cron/tick` 和 `/api/cron/sync`。

监控支持 HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket、Push 和 Agent。最短间隔 5 秒，超时 100～120,000 ms。执行源只接受 `server` 或 `agent`；Agent 来源仍要声明对应探测能力。

HTTP 监控跨源跳转时只保留 `Accept` 和 `User-Agent`，不转发认证信息及其他自定义请求头。需要保留正文的跨源跳转、HTTPS 降级和带用户名或密码的跳转地址会被拒绝。POST 经 301、302 或 303 转为 GET 后可继续跳转，正文会丢弃。需使用凭据或正文的目标，请直接填写最终 URL；Worker 和 Agent 也遵守这些限制。

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

WebSocket 目标是 `ws://` 或 `wss://` URL。UDP 接受 `send`、`expect` 和 `encoding: "text" | "hex"`，发出去后必须收到应答。Push 使用 `POST /api/public/push/:id`，通过 `Authorization: Bearer <push_token>` 认证，JSON 请求体包含 `status` 和可选的 `message`；编辑页会显示地址、密钥和示例。Push 不测量延迟，公开延迟字段保持 `null`。

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

远程迁移要求 TLS。只有回环 PostgreSQL 测试实例可以用 `sslmode=disable`。域名映射在控制台手动填写；保存前先完成 DNS 和服务器域名配置。

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
| `POLARIS_TRUSTED_PROXIES` | `--trusted-proxies` | Empty; ignore forwarded client IPs |
| `POLARIS_SETUP_KEY` | none | Setup credential; falls back to `POLARIS_ADMIN_TOKEN` |
| `POLARIS_ADMIN_TOKEN` | none | Optional admin API bearer credential |
| `POLARIS_AUTH_MODE` | none | `disabled`; see [external authentication](../../docs/external-auth.md#english) for `trusted-header` and `cloudflare-access` |
| `POLARIS_AI_KEY_FILE` | none | Protected AI and subscription encryption key file; required for AI monitoring or subscriptions on PostgreSQL. SQLite defaults to `ai-credential.key` in the data directory |

The AI key file contains 32 raw random bytes, identical across instances. Back it up with the matching database. See [AI monitoring](../../docs/ai-monitoring.md#english) for setup and recovery. It is not required when AI monitoring is unused.

### Docker

The image supports `linux/amd64` and `linux/arm64`:

```sh
docker run -d --name uptime-polaris --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v uptime-polaris-data:/data \
  ghcr.io/xinglingqaq/uptimepolaris:latest

docker logs uptime-polaris
```

Open `http://127.0.0.1:8080/setup` and use the setup key from the logs. Protect logs containing the key. Replace `latest` with a specific version tag, such as `v0.1.0`, if needed.

Data and themes are stored in `/data`; back up the volume. For a host directory mount, grant write access to UID and GID `65532`.

### Updates from the console

Official binaries support Linux, Windows and macOS on amd64 and arm64. Keep the same startup command, open the version popover in the console, and choose **Update now**. The updater verifies the download, restarts the service, and checks the running version and database connection. Choose **Reload page** when complete to load the new interface.

Automatic updates are off by default. When enabled, stable releases are checked every 6 hours; a failed version requires a manual retry. Native installations keep versioned executables in `updates` inside the data directory, including on Windows. Keep the original launcher, data directory and arguments, and continue pointing the service manager at the original launcher. The update directory must be writable and allow execution. Update any custom `--frontend-dir` files separately.

An unhealthy new version is replaced with the previous program. Managed updates require matching data compatibility declarations; releases that change data formats require a manual upgrade. Program recovery preserves database writes, so keep regular SQLite or PostgreSQL backups. See [operations](../../docs/operations.md#upgrade).

For Docker, use [compose.yaml](compose.yaml) and the commands above to create `.secrets/updater-token.txt`. Restrict the parent directory to mode `0700`; mode `0644` on the file lets the container's non-root application read the mounted secret. Then run `docker compose up -d`. A PowerShell alternative is provided above; restrict Windows directory ACLs to deployment administrators and Docker. Docker Desktop must use Linux containers. Images support linux/amd64 and linux/arm64. When adopting an existing deployment, stop it first and map the existing data volume explicitly. `POLARIS_IMAGE` and `POLARIS_TAG` select the image repository and starting tag.

Only the updater mounts the Docker socket, which grants control over host containers. Keep its network trusted, do not publish port 8091, and protect the token file. The application connects using `POLARIS_UPDATER_URL` and `POLARIS_UPDATER_TOKEN_FILE`. The updater preserves environment variables, ports, volumes and networks; stopped containers named `uptime-polaris-backup-*` provide a recovery path. Failed health checks restore the old container without replacing its data volumes. The optional updater settings and defaults are listed above.

Before a manual Compose redeployment, set `POLARIS_TAG` to the intended version and retain that configuration, so `docker compose up` does not restore an old tag. Upgrade the updater itself using `docker compose pull updater` and `docker compose up -d --no-deps updater`. Once rollback is no longer needed, remove stopped backup containers while preserving volumes. For native installs, clean only version directories referenced by neither `active` nor `previous` in `updates/native.json`.

Managed Docker updates require fixed host ports and disabled automatic container removal. Reconfigure containers using `-P`, random ports or `--rm` before connecting the updater.

### Deployment and operation

The CLI reads `.env` from the current working directory; see [`.env.example`](.env.example). Precedence is flags > process environment > `.env` > defaults, except that persisted `database.json` still takes precedence for the database. A missing `.env` is allowed; malformed input stops startup. The format supports `KEY=value`, single- or double-quoted values, trailing comments and the `export` prefix; commands are never executed and variables are not expanded. Quote values containing spaces or special characters. Protect `.env` and logs containing setup keys, and never commit them.

The executable includes the web interface and requires persistent, writable storage for data and themes. Agent installation uses GitHub downloads. Native ICMP requires raw-socket permission on the host.

For HTTPS, preserve `Host` at the reverse proxy. Enable `--trust-proxy` only if the backend cannot be reached directly by untrusted clients and the proxy reliably sets `X-Forwarded-Proto`. Stop the service before backing up its data directory; also back up PostgreSQL when used. The full configuration is in the table above, and common backup and deployment guidance is in [operations](../../docs/operations.md#english).

For login rate limits behind a proxy, set `POLARIS_TRUSTED_PROXIES` to comma-separated proxy CIDRs, such as `127.0.0.1/32,::1/128` for a local proxy. The proxy must replace or correctly append `X-Forwarded-For`. The service walks the chain from right to left, stopping at the first untrusted address. Direct requests from unlisted peers cannot override their client IP. For containers, specify the actual proxy address range; avoid trusting the entire public network.

### Checks and public APIs

`GET /api/capabilities` exposes the available native check types and sources. Go supports HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket, Push and Agent monitors. Native ICMP depends on permissions; Agent sources must advertise the required capability. The minimum interval is 5 seconds and the timeout range is 100–120,000 ms. DNS, TLS and WebSocket configuration examples are above. Push accepts POST, ignores `ping`, and reports public latency as `null`.

HTTP monitors retain only `Accept` and `User-Agent` across origins, removing credentials and other custom headers. Cross-origin redirects that retain a request body, HTTPS downgrades and redirect URLs containing credentials are rejected. A POST converted to GET by 301, 302 or 303 can continue without its body. Configure the final URL directly when the target needs credentials or a body. Worker and Agent checks apply the same restrictions.

Agent commands are disabled by default and accept `upgrade`, `restart`, `re_report` and `check_update`. Themes use schema 2 ZIP packages stored in the data directory. See the [theme guide](../../docs/themes.md#english) for installation, configuration and preview.

### SQLite to PostgreSQL

The Go migration is independent of Worker's migration tool. Preview is read-only; execution copies from a consistent SQLite snapshot into a transaction on the target, rejecting nonempty or mismatched targets. Limits are 5,000 rows per table, 10,000 total and 8 MiB. Copying does not switch the application and does not move theme files.

For a production cutover, stop all Go backend processes and restarters using the source, block incoming writes, and back up the data directory and target. Keep the source stopped until the switch is complete. In the original working directory, use the same binary and data-directory arguments with `POLARIS_MIGRATION_TARGET` set, then run `--migration preview` and `--migration execute` as shown above. Offline migration ignores `database.json`; use `--database-url` to specify the source SQLite file when it is not the default data-directory file. Supply credentials via a protected environment variable. Offline migration does not listen for HTTP or start scheduling.

Inspect the result and keep the service and restarter stopped. An explicit SQLite setup selection creates `database.json`, which overrides `POLARIS_DATABASE_URL`; changing the environment alone does not complete the cutover. Preserve the source database, theme directory and a protected `database.json` backup. In a protected environment, edit `url` in the original data directory's `database.json` to the target PostgreSQL connection, using the JSON format shown in step 3 above. Keep mode `0600`, restrict Windows file and directory ACLs, and do not put real credentials in public logs or version control.

Alternatively, after stopping the service and backing up, move or rename the original `database.json` to a protected backup location, then configure the target with `POLARIS_DATABASE_URL`; do not blindly delete it. Start the service with the original data and theme directories. Check login, monitoring, history, themes and Agent reporting before restoring traffic and restarters. For rollback, stop the target service and writes first, restore the original database and matching `database.json`, then start with the original configuration. Remote targets require TLS; `sslmode=disable` is allowed only for loopback PostgreSQL test instances. Do not run both sources as independent writers.
