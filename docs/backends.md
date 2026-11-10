# 选择后端

[English](#english)

Uptime Polaris 提供 Cloudflare Worker 和 Go 两种后端。两者用同一套前端，管理入口都是 `/admin`。每次部署选择一种后端，再把域名指向所选服务。

## 按运行环境选择

| 项目 | Cloudflare Worker | Go 后端 |
| --- | --- | --- |
| 运行位置 | Cloudflare Workers | 自有服务器或容器 |
| 数据库 | D1 或 PostgreSQL | SQLite 或 PostgreSQL |
| 直接网络探测 | HTTP、TCP | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| Agent 探测 | 支持 | 支持 |
| 最短检查间隔 | 60 秒 | 5 秒 |
| SSL 监控 | 每日查询证书记录 | 每日通过 TLS 握手读取服务器证书 |
| 主题文件 | R2 | 后端的持久化目录 |
| 运行状态 | Worker 用量 | 运行时长、内存、协程与数据库类型 |

不想自己维护服务器时选 Worker。需要直接探测内网、UDP 或更多协议时选 Go。ICMP 需要主机开放原始套接字权限；界面只列出当前后端或在线 Agent 能执行的检查类型。

初始化时，Worker 提供 D1 或 PostgreSQL，Go 提供 SQLite 或 PostgreSQL；不做选择就沿用当前配置。新选 PostgreSQL 必须提供连接 URL。只有已部署的连接对应当前 PostgreSQL 时，URL 才能留空复用。Worker 在页面输入新 URL 时必须保留 D1 绑定，D1 用来保存加密的引导配置；没有 D1 的纯 PostgreSQL 部署只能复用预配置的 `DATABASE_URL`。初始化在目标库创建管理员和会话，之后的请求和重启继续使用该库。字段和错误码见[初始化数据库契约](api.md#初始化数据库契约)。

## 部署

- [Worker 部署](deployment.md)：在 Cloudflare 上运行。
- [Go 安装与启动](../backends/go/README.md#安装与启动)：下载可执行文件，在自己的服务器上运行。

两种后端都提供内置界面和 `/admin` 管理入口。Worker 的主题文件在 R2；Go 的主题文件在持久化数据目录。备份时把数据库和主题一起备份。

## English

Uptime Polaris has two backends: Cloudflare Worker and Go. Both serve the same frontend and use `/admin` for management. Choose one backend per deployment and point the domain at it. The Go backend does not import Worker data.

### Choose a runtime

| | Cloudflare Worker | Go backend |
| --- | --- | --- |
| Hosting | Cloudflare Workers | Server or container |
| Database | D1 or PostgreSQL | SQLite or PostgreSQL |
| Direct probes | HTTP, TCP | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Agent probes | Supported | Supported |
| Minimum check interval | 60 seconds | 5 seconds |
| SSL monitoring | Daily certificate-record lookup | Daily TLS handshake |
| Theme files | R2 | Persistent backend data directory |
| Runtime information | Worker usage | Uptime, memory, goroutines, and database type |

Choose Worker when you do not want to run a server. Choose Go when you need direct private-network probes, UDP, or the extra native protocols. ICMP requires raw-socket permission on the host. The interface lists only the checks the active backend or an online Agent can run.

Worker setup offers D1 or PostgreSQL; Go setup offers SQLite or PostgreSQL. Omitting the choice keeps the current configuration. A new PostgreSQL selection requires a URL; a blank URL reuses the deployed connection only when it points at the current PostgreSQL database. To enter a new URL in Worker setup, keep the D1 binding: D1 stores the encrypted bootstrap configuration. A PostgreSQL-only Worker without D1 can only reuse its preconfigured `DATABASE_URL`. Setup creates the administrator and session in the target database, and later requests and restarts keep using it. See the [setup database contract](api.md#setup-database-contract).

### Deployment

- [Worker deployment](deployment.md#english): run on Cloudflare.
- [Go installation](../backends/go/README.md#install-and-start): download the executable and run it on your server.

Both provide built-in pages and the `/admin` console. Worker stores theme files in R2; Go stores them in its persistent data directory. Back up themes together with the database.
