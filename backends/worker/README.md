# Uptime Polaris — Cloudflare Worker

[中文](#中文) · [English](#english)

## 中文

Worker 运行在 Cloudflare，支持 D1 或 PostgreSQL。内置状态页和管理控制台不依赖 R2；安装第三方主题时才需要 `THEMES` R2 绑定。

使用[部署指南](../../docs/deployment.md)里的 Cloudflare 按钮部署，设置 `ADMIN_TOKEN`，再打开站点的 `/setup` 创建管理员。

初始化时可以选 D1 或 PostgreSQL。在页面填新的 PostgreSQL 连接时，必须保留 D1 绑定，用来保存加密的选库记录；业务数据写入 PostgreSQL。没有 D1 绑定的部署只能复用预先配置的 PostgreSQL 连接。

- [配置参考](../../docs/configuration.md)
- [运维指南](../../docs/operations.md)
- [常见问题](../../docs/troubleshooting.md)

## English

Worker runs on Cloudflare with D1 or PostgreSQL. The built-in pages and console do not require R2; third-party themes require the `THEMES` R2 binding.

Deploy with the Cloudflare button in the [deployment guide](../../docs/deployment.md#english), configure `ADMIN_TOKEN`, then open `/setup` to create the administrator.

Setup offers D1 or PostgreSQL. Entering a new PostgreSQL connection requires D1 to retain the encrypted selection; business data stays in PostgreSQL. Without D1, setup can only reuse the preconfigured PostgreSQL connection.

- [Configuration](../../docs/configuration.md#english)
- [Operations](../../docs/operations.md#operations-guide)
- [Troubleshooting](../../docs/troubleshooting.md#troubleshooting-guide)
