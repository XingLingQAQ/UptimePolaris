<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/overview-zh-CN-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/overview-zh-CN-light.svg">
    <img src="assets/readme/overview-zh-CN-light.svg" width="100%" alt="Uptime Polaris：服务可用性和主机监控">
  </picture>
</h1>

<p align="center"><strong>自托管的状态页与服务监控</strong><br>可部署在 Cloudflare Workers 上，也可以在自有服务器上运行 Go 后端</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README-zh-TW.md">繁體中文（台灣）</a> · <a href="README-zh-HK.md">繁體中文（香港）</a> · <a href="README-ja-JP.md">日本語</a> · <a href="README-ko-KR.md">한국어</a> · <a href="README-fr-FR.md">Français</a> · <a href="README-pt-BR.md">Português (Brasil)</a> · <a href="README-ru-RU.md">Русский</a>
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" height="20" alt="运行于 Cloudflare Workers"></a>
  <a href="backends/go/README.md"><img src="https://img.shields.io/badge/Go-Backend-00ADD8?style=flat-square&amp;logo=go&amp;logoColor=white" height="20" alt="Go backend"></a>
  <a href="frontend/README.md"><img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&amp;logo=react&amp;logoColor=white" height="20" alt="前端使用 React 和 TypeScript"></a>
  <a href="https://github.com/XingLingQAQ/polaris-agent"><img src="https://img.shields.io/badge/Rust-Agent-93450A?style=flat-square&amp;logo=rust&amp;logoColor=white" height="20" alt="Polaris Agent 使用 Rust"></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Storage-D1%20%2F%20SQLite%20%2F%20PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" height="20" alt="Storage: D1, SQLite, PostgreSQL"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#部署到-cloudflare">部署</a> · <a href="#deploy-go">Go 部署</a> ·
  <a href="#监控主机">Agent</a> ·
  <a href="#文档">文档</a>
</p>

Uptime Polaris 定时检查网站和端口，接收定时任务发送的心跳，采集服务器的 CPU、内存和磁盘指标，并在监控状态变化时发送通知。项目自带公开状态页和管理后台。

## 选择后端

每次部署选择一种后端，两种后端使用相同的界面。

| | Cloudflare Worker | Go |
| --- | --- | --- |
| 运行环境 | Cloudflare | 自有服务器或容器 |
| 数据库 | D1 或 PostgreSQL | SQLite 或 PostgreSQL |
| 直接探测 | HTTP、TCP（UDP、ICMP 需通过 Agent） | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| 最短检查间隔 | 60 秒 | 5 秒 |
| 主题文件 | R2（可选） | 数据目录 |

不想维护服务器时建议使用 Worker；需要探测内网服务、使用更多协议或更短的检查间隔时，请选择 Go。详细对比见[选择后端](docs/backends.md)。

## 功能

<p align="center">
  <img src="assets/readme/check.svg" width="24" height="24" alt="服务检查图标"><br>
  <strong>服务检查与心跳</strong><br>
  支持 HTTP 和 TCP 检查，并可附加响应内容、证书、域名到期和 DNS 检查。Push 监控适用于定时任务和备份脚本，超过设定时间未收到心跳即判定为异常。
</p>

<p align="center">
  <img src="assets/readme/host.svg" width="24" height="24" alt="主机监控图标"><br>
  <strong>服务器监控</strong><br>
  <code>polaris-agent</code> 上报 CPU、内存、磁盘、负载和网络指标，也可以从所在主机发起 HTTP/TCP 检查，用于探测内网服务。
</p>

<p align="center">
  <img src="assets/readme/bell.svg" width="24" height="24" alt="状态通知图标"><br>
  <strong>状态页与通知</strong><br>
  状态页展示当前状态和事件历史，支持分组和维护窗口。通知渠道包括 Telegram、飞书、Slack、Discord、Webhook、Apprise 和 Server酱，每个渠道可以限定负责的监控分组。
</p>

<p align="center">
  <img src="assets/readme/layers.svg" width="24" height="24" alt="存储和主题图标"><br>
  <strong>存储与主题</strong><br>
  Worker 使用 D1 或 PostgreSQL 存储数据，主题存放在 R2；Go 使用 SQLite 或 PostgreSQL，主题存放在数据目录。
</p>

## 快速开始

1. 将服务部署到 [Cloudflare](#部署到-cloudflare) 或[自有服务器](#deploy-go)。
2. 打开站点的 `/setup` 页面。Worker 会先检查绑定和密钥，通过后输入 `ADMIN_TOKEN`；Go 输入启动日志中的初始化密钥。
3. 创建管理员账号，然后在 `/admin` 添加监控。

## 部署到 Cloudflare

1. Fork 本仓库。
2. 在 Cloudflare 控制台打开 **Workers & Pages → Create application → GitHub**，选择 fork 后的仓库。构建命令填写 `npm run build`，部署命令填写 `npm run deploy`。
3. 部署完成后打开站点，初始化页面会先检查绑定和密钥。请按页面提示在 Worker 的 **Settings** 中配置：
   - **D1（可选）**：使用 D1 时，在 **Bindings** 中添加数据库，变量名填写 `DB`。未绑定也可进入下一步，但初始化仅提供 PostgreSQL；创建账号前需在 **Variables and Secrets** 中配置 Secret `DATABASE_URL`，保存并部署后点击“重新获取数据库选项”。
   - **初始化密钥**：在 **Variables and Secrets** 中添加 Secret `ADMIN_TOKEN`，值使用足够长的随机字符串，例如 `openssl rand -hex 32` 的输出。
   - **Analytics Engine（必需）**：在控制台启用 Analytics Engine，并在 **Bindings** 中添加数据集，变量名填写 `UPTIME`。
   - **可选**：安装第三方主题时添加 R2 存储桶，变量名填写 `THEMES`，也可以在初始化后添加。
4. 在初始化页面点击“重新检查”，通过后进入下一步，输入 `ADMIN_TOKEN` 创建管理员账号。

后续升级只需在 GitHub 上执行 Sync fork，Workers Builds 会自动重新部署，并保留控制台中已添加的绑定。

也可以通过下方按钮部署。按钮部署会在你的 GitHub 账号下新建一个仓库（不是 fork，后续无法通过 Sync fork 同步更新），数据库和密钥同样按初始化页面的提示配置：

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

命令行部署与 PostgreSQL 配置见[部署指南](docs/deployment.md)。

<a id="deploy-go"></a>

## 部署 Go 后端

从 [Releases](https://github.com/XingLingQAQ/UptimePolaris/releases) 下载对应系统和架构的程序，重命名为 `polaris`（Windows 为 `polaris.exe`）后启动：

```sh
chmod +x polaris   # Linux / macOS
./polaris --data-dir ./data
```

```powershell
.\polaris.exe --data-dir .\data
```

程序默认监听 `127.0.0.1:8080`。如需对外访问，请修改 `--addr` 或配置反向代理。所有数据保存在 `./data` 目录，该目录需要持久化存储、限制访问权限并定期备份。更多配置见 [Go 后端说明](backends/go/README.md#安装与启动)。

## 监控主机

在后台的 Agent 页面添加机器，选择平台和安装方式，然后在目标机器上执行生成的安装命令。目标机器需要能够访问 GitHub。

安装完成后，可使用 `pa`（`polaris-agent` 的简写）管理服务：

```sh
pa status
pa restart
pa logs -f
```

- 安装命令包含站点地址和该机器的 Token，请在正式域名下生成，并避免公开。
- 添加机器不会自动创建监控，需要在监控页面新增 Agent 类型的监控。
- 手动安装模式没有服务管理器，`pa start`、`stop`、`restart` 不可用。

更多说明见 [Agent 手册](docs/agents.md)。

## 使用与公开信息

状态页无需登录即可访问，监控名称、目标路径和主机名可能出现在公开页面和公开接口中，请勿在其中填写内网地址或密钥。公开范围详见[公开数据](docs/usage.md#公开数据)，通知配置见[通知指南](docs/notifications.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [选择后端](docs/backends.md) | Worker 与 Go 的区别 |
| [部署指南](docs/deployment.md) | Fork 部署、按钮部署、手动部署、域名、PostgreSQL、D1 迁移到 PostgreSQL |
| [Go 后端](backends/go/README.md) | 启动参数、环境变量、SQLite 迁移到 PostgreSQL |
| [使用手册](docs/usage.md) | 监控配置、Push、状态与可用率 |
| [Agent 手册](docs/agents.md) | 安装、管理、配置、更新、卸载 |
| [通知指南](docs/notifications.md) | 渠道配置、分组范围、投递记录 |
| [主题指南](docs/themes.md) | 安装、配置、预览 |
| [配置参考](docs/configuration.md) | 绑定、环境变量、后台设置 |
| [API 参考](docs/api.md) | 接口、认证、示例 |
| [运维指南](docs/operations.md) | 备份、恢复、升级、数据保留 |
| [常见问题](docs/troubleshooting.md) | 按故障现象排查 |

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
