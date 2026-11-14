# Uptime Polaris — Cloudflare Worker

[中文](#中文) · [English](#english)

## 中文

Worker 运行在 Cloudflare，支持 D1 或 PostgreSQL。内置状态页和管理控制台不依赖 R2；安装第三方主题时才需要 `THEMES` R2 绑定。

使用[部署指南](../../docs/deployment.md)里的 Cloudflare 按钮部署，设置 `ADMIN_TOKEN` 并绑定 `UPTIME`（Analytics Engine），再打开 `/setup`，依次完成部署检查、数据库配置和管理员账号设置。

绑定 `DB` 时可选 D1；未绑定时只提供 PostgreSQL。页面填写的 PostgreSQL 连接加密保存在 `CONFIG` KV 命名空间，使用前请先绑定。账号、会话和业务数据保存在所选数据库中。

历史图表和每日归档使用部署配置自带的 `ANALYTICS_SQL` 绑定，无需添加账号 ID 或 API Token。直接使用 Wrangler 部署时，版本需为 4.145.0 或更高。

- [配置参考](../../docs/configuration.md)
- [运维指南](../../docs/operations.md)
- [常见问题](../../docs/troubleshooting.md)

## English

Worker runs on Cloudflare with D1 or PostgreSQL. The built-in pages and console do not require R2; third-party themes require the `THEMES` R2 binding.

Deploy with the Cloudflare button in the [deployment guide](../../docs/deployment.md#english), configure `ADMIN_TOKEN` and bind `UPTIME` (Analytics Engine), then open `/setup` for deployment checks, database configuration and administrator setup.

D1 is available when bound as `DB`; otherwise setup offers PostgreSQL only. Bind a KV namespace as `CONFIG` to store page-entered PostgreSQL connections encrypted. Accounts, sessions and business data remain in the selected database.

History charts and daily archives use the `ANALYTICS_SQL` binding included in the deployment configuration. No account ID or API Token is needed. Direct Wrangler deployments require version 4.145.0 or later.

- [Configuration](../../docs/configuration.md#english)
- [Operations](../../docs/operations.md#operations-guide)
- [Troubleshooting](../../docs/troubleshooting.md#troubleshooting-guide)
