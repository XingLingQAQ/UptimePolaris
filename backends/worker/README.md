# Uptime Polaris — Cloudflare Worker

[中文](#中文) · [English](#english)

## 中文

Worker 运行在 Cloudflare，支持 D1 或 PostgreSQL。内置状态页和管理控制台不依赖 R2；安装第三方主题时才需要 `THEMES` R2 绑定。

使用[部署指南](../../docs/deployment.md)里的 Cloudflare 按钮部署，设置 `ADMIN_TOKEN` 并绑定 `UPTIME`（Analytics Engine），再打开 `/setup`，依次完成部署检查、数据库配置和管理员账号设置。

绑定 `DB` 时可选 D1；未绑定时只提供 PostgreSQL。页面填写的 PostgreSQL 连接加密保存在 `CONFIG` KV 命名空间，使用前请先绑定。账号、会话和业务数据保存在所选数据库中。

在 Worker 的环境变量中设置 `CF_ACCOUNT_ID`，并添加有账号 Analytics Read 权限的 Secret `CF_API_TOKEN`，以启用历史图表和每日归档。未配置时仍显示实时状态、近期检查状态条和精确可用率。

- [配置参考](../../docs/configuration.md)
- [运维指南](../../docs/operations.md)
- [常见问题](../../docs/troubleshooting.md)

## English

Worker runs on Cloudflare with D1 or PostgreSQL. The built-in pages and console do not require R2; third-party themes require the `THEMES` R2 binding.

Deploy with the Cloudflare button in the [deployment guide](../../docs/deployment.md#english), configure `ADMIN_TOKEN` and bind `UPTIME` (Analytics Engine), then open `/setup` for deployment checks, database configuration and administrator setup.

D1 is available when bound as `DB`; otherwise setup offers PostgreSQL only. Bind a KV namespace as `CONFIG` to store page-entered PostgreSQL connections encrypted. Accounts, sessions and business data remain in the selected database.

Set `CF_ACCOUNT_ID` and a `CF_API_TOKEN` Secret with account Analytics Read permission to enable history charts and daily archives. Without them, live status, recent check status bars and exact availability remain available.

- [Configuration](../../docs/configuration.md#english)
- [Operations](../../docs/operations.md#operations-guide)
- [Troubleshooting](../../docs/troubleshooting.md#troubleshooting-guide)
