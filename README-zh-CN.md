<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-zh-CN-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-zh-CN-light.svg">
  <img src="assets/readme/overview-zh-CN-light.svg" width="100%" alt="Uptime Polaris：服务可用性和主机监控">
</picture>

<a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>

# Uptime Polaris - 自托管状态页与服务监控

Uptime Polaris 定时检查网站、端口和定时任务，采集服务器指标，并在状态变化时发送通知。<br>
可以部署在 Cloudflare Workers 上，不需要维护服务器；也可以在自有服务器上运行 Go 后端。<br>
自带公开状态页和管理后台，界面支持 9 种语言。

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="运行于 Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="前端使用 React 和 TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent 使用 Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p><a href="#功能">功能</a> · <a href="#部署">部署</a> · <a href="#快速开始">快速开始</a> · <a href="#监控服务器">Agent</a> · <a href="#数据与公开范围">公开范围</a> · <a href="#常见问题">常见问题</a> · <a href="#文档">文档</a></p>

</div>

## 为什么选择 Uptime Polaris

- **不用维护服务器**：部署在 Cloudflare Workers 上，检查、通知和状态页都由 Cloudflare 运行。需要探测内网或缩短检查间隔时，可以改用 Go 后端，两者使用同一套界面。
- **状态来自实际结果**：页面只显示实际检查和上报得到的数据。没有数据时显示等待，不会把缺口补成正常。
- **定时任务也能监控**：备份脚本和 cron 任务按时上报心跳，超过时限没有上报即判为异常。
- **服务器指标**：`polaris-agent` 上报 CPU、内存、磁盘、负载和网络，也可以从所在主机检查内网服务。
- **两种公开页面**：监控状态页和机器状态页分开展示，可以分别绑定域名；维护期间自动切换到维护页面。
- **按分组发送通知**：支持 Telegram、飞书、Slack、Discord、Webhook、Apprise 和 Server酱，每个渠道可以只负责部分分组。
- **数据库可选**：Worker 使用 D1 或 PostgreSQL，Go 使用 SQLite 或 PostgreSQL，已有数据可以迁移到 PostgreSQL。

## 功能

### <img src="assets/readme/check.svg" width="20" height="20" alt=""> 服务检查与心跳

- HTTP 检查可以校验状态码、JSON 字段、响应头和响应时间；TCP 检查端口能否连接，也可以发送内容并校验返回。
- Go 后端还能直接检查 UDP、ICMP、DNS、TLS 和 WebSocket。Worker 上的 UDP 和 ICMP 检查由 Agent 执行。
- 附加检查包括 SSL 证书到期、域名到期和 DNS 记录。
- Push 监控提供专属上报地址，定时任务按期发送 POST 请求，超时未上报即判为异常。
- 最短检查间隔为 60 秒（Worker）或 5 秒（Go）。目标只在内网开放时，可以指定一台 Agent 作为检查来源。

监控类型和各项配置，详见[使用手册](docs/usage.md)。

### <img src="assets/readme/host.svg" width="20" height="20" alt=""> 服务器监控

- `polaris-agent` 上报 CPU、内存、磁盘、负载、网络和挂载点，支持 Linux、macOS 和 Windows，Linux 还可以使用 Docker 安装。
- 资源告警可以设置阈值和持续时间，连续超过阈值才会告警；恢复时按比例回落，减少临界值附近的反复告警。
- 机器状态页可以单独开启，支持搜索、筛选和地图视图，也可以选择 2～4 台机器对比。机器状态页默认关闭，机器默认只在后台可见。

安装、管理和更新，详见 [Agent 手册](docs/agents.md)。

### <img src="assets/readme/bell.svg" width="20" height="20" alt=""> 状态页与通知

- 状态页显示当前状态、可用率和事件记录，支持分组，只展示标记为公开的监控。
- 维护窗口可以设为一次性或每周重复。开始前在页面顶部显示公告，维护期间暂缓自动通知。
- 每个通知渠道可以选择消息语言和负责的分组。控制台保留投递记录，区分发送成功、提供商拒绝和网络超时。

渠道配置与分组范围，详见[通知指南](docs/notifications.md)。

### <img src="assets/readme/layers.svg" width="20" height="20" alt=""> 存储与主题

- Worker 使用 D1 或 PostgreSQL，Go 使用 SQLite 或 PostgreSQL；D1 和 SQLite 的数据都可以迁移到 PostgreSQL。
- 公开页面可以安装第三方主题，上传 ZIP 包或填写下载地址，应用前可以预览。Worker 的主题存放在 R2，Go 存放在数据目录。
- 未安装主题时使用内置主题，管理后台始终使用内置界面。

主题的安装与制作，详见[主题指南](docs/themes.md)。

### 更多

- **命令面板**：在控制台按 `Ctrl+K`（macOS 为 `⌘K`），可以搜索页面、监控和 Agent。
- **状态浮层**：控制台顶部汇总异常的监控和离线的 Agent，可以直接暂停、立即检查或复制摘要。
- **API**：管理接口支持 Bearer Token 认证，可以通过脚本创建和管理监控，详见 [API 参考](docs/api.md)。
- **界面语言**：简体中文、繁体中文（台湾、香港）、英语、日语、韩语、法语、葡萄牙语和俄语。

## 部署

每次部署选择一种后端，两种后端使用相同的界面。

| | Cloudflare Worker | Go |
| --- | --- | --- |
| 运行环境 | Cloudflare | 自有服务器或容器 |
| 数据库 | D1 或 PostgreSQL | SQLite 或 PostgreSQL |
| 直接探测 | HTTP、TCP（UDP、ICMP 需通过 Agent） | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| 最短检查间隔 | 60 秒 | 5 秒 |
| 主题文件 | R2（可选） | 数据目录 |

不想维护服务器时建议使用 Worker；需要探测内网服务、使用更多协议或更短的检查间隔时，请选择 Go。详细对比见[选择后端](docs/backends.md)。

### 部署到 Cloudflare

1. Fork 本仓库。
2. 在 Cloudflare 控制台打开 **Workers & Pages → Create application → GitHub**，选择 fork 后的仓库。构建命令填写 `npm run build`，部署命令填写 `npm run deploy`。
3. 部署完成后打开站点，初始化页面会先检查绑定和密钥。请按页面提示在 Worker 的 **Settings** 中配置：
   - **D1（可选）**：使用 D1 时，在 **Bindings** 中添加数据库，变量名填写 `DB`。未绑定 D1 时，初始化只提供 PostgreSQL。
   - **KV（页面配置 PostgreSQL 时必需）**：在 **Bindings** 中添加 KV 命名空间，变量名填写 `CONFIG`，用于加密保存连接地址。仅使用 D1 或部署时配置的 `DATABASE_URL` 时可不绑定。
   - **初始化密钥**：在 **Variables and Secrets** 中添加 Secret `ADMIN_TOKEN`，值使用足够长的随机字符串，例如 `openssl rand -hex 32` 的输出。
   - **Analytics Engine（必需）**：在控制台启用 Analytics Engine，并在 **Bindings** 中添加数据集，变量名填写 `UPTIME`。
   - **R2（可选）**：安装第三方主题时需要。在 **Bindings** 中添加存储桶，变量名填写 `THEMES`，也可以在初始化后再添加。
4. 回到初始化页面点击“重新检查”。必需项通过后，输入 `ADMIN_TOKEN`，配置并验证数据库，再创建管理员账号。

也可以通过下方按钮部署。按钮会在你的 GitHub 账号下新建一个仓库（不是 fork，之后无法通过 Sync fork 更新），数据库和密钥同样按初始化页面的提示配置：

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

命令行部署和 PostgreSQL 配置，详见[部署指南](docs/deployment.md)。

<a id="deploy-go"></a>

### 部署 Go 后端

从 [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) 下载对应系统和架构的程序，重命名为 `polaris`（Windows 为 `polaris.exe`）后启动：

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

程序默认监听 `127.0.0.1:8080`。如需对外访问，请修改 `--addr` 或配置反向代理。所有数据保存在 `./data` 目录，该目录需要持久化存储、限制访问权限并定期备份。启动参数和环境变量，详见 [Go 后端说明](backends/go/README.md#安装与启动)。

## 快速开始

1. 打开站点的 `/setup` 页面。Worker 会先检查绑定和密钥，通过后输入 `ADMIN_TOKEN`；Go 输入启动日志中的初始化密钥。然后创建管理员账号。
2. 进入 `/admin`，在“监控项”中新增监控。例如选择 HTTP，填写 `https://example.com/health`，保存后点击“立即检查”。
3. 在“通知”中添加渠道，并发送一条测试消息。
4. 使用未登录的浏览器窗口打开站点首页，确认状态页显示的内容。

首次登录时，总览页的“开始使用”清单会列出添加监控、设置站点名称、配置通知和接入 Agent 这几步。

## 监控服务器

在控制台的“Agent 管理”中添加机器，选择平台和安装方式，然后在目标机器上执行生成的安装命令。目标机器需要能够访问 GitHub。

安装完成后，可以使用 `pa`（`polaris-agent` 的简写）管理服务：

```sh
pa status
pa restart
pa logs -f
```

- 安装命令包含站点地址和该机器的 Token，请在正式域名下生成，并避免公开。
- 添加机器不会自动创建监控，需要在“监控项”中新增“Agent 主机”类型的监控。
- 手动安装模式没有服务管理器，`pa start`、`stop`、`restart` 不可用。

安装模式和平台差异，详见 [Agent 手册](docs/agents.md)。

## 升级与卸载

### 升级

升级前请先备份数据库，完整步骤见[运维指南](docs/operations.md#升级流程)。

- **Cloudflare**：Fork 部署在 GitHub 上执行 Sync fork，Workers Builds 会自动重新部署，并保留控制台中添加的绑定。按钮部署需要把新版本合并到生成的仓库。
- **Go**：停止服务并备份数据目录，替换程序后使用原数据目录启动。
- **Agent**：在机器上执行 `pa update`。托管安装也可以在控制台开启自动更新，默认关闭。

### 卸载

- **Cloudflare**：在控制台删除 Worker。D1 数据库、R2 存储桶和 PostgreSQL 数据库不会随 Worker 删除，不再需要时请单独删除。
- **Go**：停止服务后删除程序和数据目录；使用 PostgreSQL 时，另行删除对应的数据库。
- **Agent**：下载当前站点的安装脚本，然后执行卸载：

  ```sh
  curl -fsSL 'https://status.example.com/install.sh' -o install.sh
  sh install.sh --uninstall
  ```

  Windows 的卸载方式见 [Agent 手册](docs/agents.md#卸载)。卸载 Agent 不会删除控制台中的监控。

## 数据与公开范围

- 数据保存在你自己的部署中：Worker 使用你 Cloudflare 账号下的 D1 或你提供的 PostgreSQL，Go 使用数据目录中的 SQLite 或你提供的 PostgreSQL。
- 状态页和公开接口无需登录即可访问。监控名称、HTTP 目标的域名和路径、TCP 目标的主机和端口会公开显示，请勿在其中填写内网地址或密钥。
- HTTP 目标中的用户名、密码和查询参数会被去掉；认证配置和 Agent Token 不会出现在公开数据中。
- Push 地址中的 Token 相当于该监控的上报凭据，请勿公开。
- 不需要公开的监控，可以在监控列表中选择“在状态页隐藏”，之后只在后台可见。
- Worker 的 SSL 到期检查会查询公开的证书透明度日志；Agent 启动时会查询本机公网 IP 的归属地，更新时会访问 GitHub。

公开页面和接口返回哪些字段，详见[公开数据](docs/usage.md#公开数据)。

## 常见问题

**初始化页面停在部署检查，无法进入下一步？**
请在 Worker 的 **Settings** 中配置必需的 `ADMIN_TOKEN` 和 `UPTIME`，保存并部署后点击“重新检查”。D1 和 R2 为可选项；未绑定 D1 时，在下一步配置 PostgreSQL 连接。

**在浏览器里打开 Push 地址，为什么没有数据？**
浏览器发送的是 GET 请求，Push 只接受 POST，GET 请求会返回 405。请使用 `curl -X POST` 或在任务中发送 POST 请求。

**通知测试成功，故障时却没有收到？**
请检查渠道是否启用、分组范围是否包含该监控，以及当前是否处于维护窗口。渠道没有选择任何分组时，会接收全部监控的通知。

**Agent 显示离线？**
在机器上执行 `pa status` 和 `pa logs -f`，确认服务正在运行，并且能够访问站点域名。默认每 60 秒上报一次，约 3 分钟没有上报会判为离线。

更多问题见[常见问题](docs/troubleshooting.md)。仍无法解决时，欢迎在 [Issues](https://github.com/XingLingQAQ/UptimePolaris/issues) 中反馈。

## 文档

| 文档 | 内容 |
| --- | --- |
| [选择后端](docs/backends.md) | Worker 与 Go 的区别 |
| [部署指南](docs/deployment.md) | Fork 部署、按钮部署、手动部署、域名、PostgreSQL、D1 迁移到 PostgreSQL |
| [Go 后端](backends/go/README.md) | 启动参数、环境变量、SQLite 迁移到 PostgreSQL |
| [使用手册](docs/usage.md) | 控制台、监控配置、Push、状态页、维护窗口、账号与安全 |
| [Agent 手册](docs/agents.md) | 安装、管理、配置、更新、卸载 |
| [通知指南](docs/notifications.md) | 渠道配置、分组范围、投递记录 |
| [主题指南](docs/themes.md) | 安装、配置、预览 |
| [配置参考](docs/configuration.md) | 绑定、环境变量、后台设置 |
| [API 参考](docs/api.md) | 接口、认证、示例 |
| [运维指南](docs/operations.md) | 备份、恢复、升级、数据保留 |
| [常见问题](docs/troubleshooting.md) | 按故障现象排查 |

## 许可证

Uptime Polaris 采用 [MIT 许可证](LICENSE)。
