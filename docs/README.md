# Uptime Polaris 文档

[English](#english)

本手册涵盖 Uptime Polaris 的部署、配置、使用与运维。命令示例中的 `https://status.example.com`、`TOKEN`、数据库名和资源 ID 需替换为实际值；npm 命令默认在仓库根目录执行。

## 文档导航

| 主题 | 说明 |
| --- | --- |
| [选择后端](backends.md) | Worker 与 Go 后端能力对比 |
| [部署指南](deployment.md) | Cloudflare Worker 部署、域名、PostgreSQL 与迁移 |
| [Go 后端说明](../backends/go/README.md) | Go 二进制、Docker、后台更新与离线迁移 |
| [配置参考](configuration.md) | 绑定资源、环境变量与站点设置 |
| [外部认证](external-auth.md) | 反向代理头与 Cloudflare Access 登录（Go 支持两种，Worker 仅支持 Cloudflare Access） |
| [使用手册](usage.md) | 监控配置、Push 心跳、分组、公开页与维护模式 |
| [Agent 手册](agents.md) | `polaris-agent`（`pa`）安装、管理、配置与卸载 |
| [AI 模型监控](ai-monitoring.md) | 模型渠道、自定义参数、展示页与密钥管理 |
| [订阅公开监控](subscriptions.md) | 订阅仓库、自定义接口描述与通知 |
| [通知指南](notifications.md) | 通知渠道、分组范围、维护静默与重试 |
| [主题指南](themes.md) | 主题包安装、配置、SDK 与预览 |
| [Worker Queue](queue.md) | Worker 队列分批检查 |
| [API 参考](api.md) | HTTP 接口、认证、请求字段与错误码 |
| [运维指南](operations.md) | 调度、升级、备份恢复与凭据轮换 |
| [常见问题](troubleshooting.md) | 常见故障定位与处理 |

## 基础约定

- **凭据互不通用**：初始化/管理凭据（Worker 为 `ADMIN_TOKEN`，Go 为 `POLARIS_SETUP_KEY` / `POLARIS_ADMIN_TOKEN`）、管理员密码、Agent Token、Push Token 和 AI 渠道 API Key 各有独立用途。
- **时区**：维护窗口与调度规则均使用 UTC。
- **匿名可见性**：公开状态页可匿名访问，勿在监控名、目标路径和机器名中填入敏感信息。

## English

This documentation covers deploying, configuring, using, and operating Uptime Polaris. Replace `https://status.example.com`, tokens, database names, and resource IDs in examples with your own values. Run npm commands from the repository root unless noted otherwise.

### Guides

| Topic | Contents |
| --- | --- |
| [Backend options](backends.md#english) | Worker vs. Go capability comparison |
| [Deployment](deployment.md#english) | Cloudflare Worker setup, domains, PostgreSQL, and migration |
| [Go backend](../backends/go/README.md#english) | Binary, Docker, managed updates, and offline migration |
| [Configuration](configuration.md#english) | Bindings, environment variables, and site settings |
| [External authentication](external-auth.md#english) | Trusted proxy headers and Cloudflare Access (both on Go; Cloudflare Access only on Worker) |
| [Usage](usage.md#english) | Monitors, Push heartbeats, groups, public pages, and maintenance |
| [Agent](agents.md#english) | Installing, managing, configuring, and removing `polaris-agent` (`pa`) |
| [AI monitoring](ai-monitoring.md#english) | AI channels, custom payloads, public pages, and key backup |
| [Subscriptions](subscriptions.md#english) | Official/third-party libraries, custom descriptors, and alerts |
| [Notifications](notifications.md#english) | Providers, routing scope, maintenance suppression, and retries |
| [Themes](themes.md#english) | Theme packages, options, SDK, and preview |
| [Worker Queue](queue.md#english) | Batched checks on Cloudflare Workers |
| [API reference](api.md#english) | Endpoints, authentication, payloads, and error codes |
| [Operations](operations.md#english) | Scheduling, upgrades, backups, restores, and key rotation |
| [Troubleshooting](troubleshooting.md#english) | Diagnosing common issues |

### Conventions

- **Separate credentials**: setup/admin tokens (`ADMIN_TOKEN` on Worker; `POLARIS_SETUP_KEY` / `POLARIS_ADMIN_TOKEN` on Go), the admin password, Agent tokens, Push tokens, and AI API keys are not interchangeable.
- **Time zone**: maintenance windows and schedules use UTC.
- **Public visibility**: public status pages are anonymous; keep secrets out of monitor names, target paths, and host metadata.
