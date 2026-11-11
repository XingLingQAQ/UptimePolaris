# Uptime Polaris 文档

[English](#english)

本手册覆盖 Uptime Polaris 的部署、使用和运维。命令里的 `https://status.example.com`、`TOKEN`、数据库名和资源 ID 都要替换成自己的值。除非特别说明，npm 命令在仓库根目录执行。

## 阅读路径

| 场景 | 建议顺序 |
| --- | --- |
| 第一次运行 | [项目说明](../README.md) → [后端选择](backends.md) → [使用手册](usage.md) |
| 部署自己的站点 | [后端选择](backends.md) → [Worker 部署](deployment.md)或 [Go 部署](../backends/go/README.md) → [运维指南](operations.md) |
| 监控服务器 | [Agent 手册](agents.md) → [通知指南](notifications.md) |
| 接入脚本和定时任务 | [使用手册](usage.md#push-监控) → [API 参考](api.md) |
| 安装或配置主题 | [主题指南](themes.md) |
| 页面没有数据或安装失败 | [常见问题](troubleshooting.md) |

## 文档约定

- 以下四种凭据用途不同，不能互换：站点管理与初始化凭据（Worker 的 `ADMIN_TOKEN`、Go 的 `POLARIS_SETUP_KEY` / `POLARIS_ADMIN_TOKEN`）、管理员登录密码、每台机器的 Agent Token、每个 Push 监控的 Push Token。
- 浏览器登录使用会话 Cookie；管理脚本使用 Bearer Token。
- 维护窗口和调度表达式按 UTC 解释。
- Agent 可执行文件是 `polaris-agent`，短命令是 `pa`。
- 公开状态页允许匿名访问。添加监控前，请确认名称、目标路径和机器信息不含敏感内容。

## 按主题查阅

- [后端选择](backends.md)：Worker 与 Go 的存储、探测能力和启动方式。
- [部署指南](deployment.md)：Fork 部署、按钮部署、命令行部署、初始化检查与 PostgreSQL。
- [使用手册](usage.md)：监控配置、检查来源、状态、覆盖率和公开数据。
- [Agent 手册](agents.md)：安装、服务管理、配置、指令、更新和卸载。
- [配置参考](configuration.md)：绑定、环境变量和后台设置。
- [通知指南](notifications.md)：渠道字段、分组范围、维护窗口和投递记录。
- [主题指南](themes.md)：安装、应用、配置和预览。
- [API 参考](api.md)：接口、初始化契约、认证和调用示例。
- [运维指南](operations.md)：备份、恢复、调度、升级、存储和日志。
- [常见问题](troubleshooting.md)：按故障现象定位与排查。

## English

This manual covers deploying, using, and operating Uptime Polaris. Replace `https://status.example.com`, tokens, database names, and resource IDs in examples with your own values. Unless stated otherwise, run npm commands from the repository root.

### Reading paths

| Task | Start here |
| --- | --- |
| Run a new installation | [Project overview](../README.md) → [Backend options](backends.md#english) → [Usage](usage.md#usage-guide) |
| Deploy a site | [Backend options](backends.md#english) → [Worker deployment](deployment.md#english) or [Go deployment](../backends/go/README.md#english) → [Operations](operations.md#operations-guide) |
| Configure and operate a site | [Configuration](configuration.md#english) → [Operations](operations.md#operations-guide) → [Troubleshooting](troubleshooting.md#troubleshooting-guide) |
| Monitor servers | [Agent guide](agents.md#agent-guide) → [Notifications](notifications.md#notification-guide) |
| Integrate a script or scheduled task | [Usage: Push monitoring](usage.md#usage-guide) → [API reference](api.md#api-reference) |
| Install or configure a theme | [Themes](themes.md#english) |

### Conventions

- These four credentials are not interchangeable: `ADMIN_TOKEN`, the user login password, each machine's Agent Token, and Push Tokens.
- Browser login uses a session cookie; management scripts use a Bearer token.
- Maintenance windows and schedules use UTC.
- The Agent executable is `polaris-agent`; its short command is `pa`.
- Public status pages are anonymous. Before adding a monitor, confirm that its name, target path, and machine details contain nothing sensitive.

### Reference index

- [Backend options](backends.md#english): storage, probes, and deployment for Worker and Go.
- [Deployment](deployment.md#english): Cloudflare resources, secrets, setup, and PostgreSQL.
- [Configuration](configuration.md#english): bindings, environment variables, and console settings.
- [Usage](usage.md#usage-guide): monitors, check sources, status, coverage, and public data.
- [Agent](agents.md#agent-guide): installation, configuration, and service management.
- [Notifications](notifications.md#notification-guide): channels, scope, maintenance, and delivery records.
- [Themes](themes.md#english): installation, application, configuration, and preview.
- [API](api.md#api-reference): endpoints, authentication, and examples.
- [Operations](operations.md#operations-guide): backups, recovery, scheduling, and upgrades.
- [Troubleshooting](troubleshooting.md#troubleshooting-guide): symptoms and diagnosis.
