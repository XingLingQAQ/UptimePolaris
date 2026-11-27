# 选择后端

[English](#english)

Uptime Polaris 提供 Cloudflare Worker 和 Go 两种后端，共用同一套前端与 `/admin` 控制台。每次部署只需选择其中一种。

| 维度 | Cloudflare Worker | Go 后端 |
| --- | --- | --- |
| 运行环境 | Cloudflare Workers | 自有服务器或 Docker |
| 数据库 | D1 或 PostgreSQL | SQLite 或 PostgreSQL |
| 原生探测协议 | HTTP、TCP | HTTP、TCP、UDP、ICMP、DNS、TLS、WebSocket |
| Agent 代理探测 | 支持 | 支持 |
| 最短检查间隔 | 60 秒 | 5 秒 |
| SSL 检查方式 | 每日查询公开证书记录 | 每日实时 TLS 握手 |
| 主题存储 | R2 存储桶 | 本地数据目录 |

**如何选择**：
- 不想维护服务器、只需公网 HTTP/TCP 检查且 60 秒以上间隔够用，选 **Worker**（[部署指南](deployment.md)）。
- 需要直接探测内网服务、使用 UDP/ICMP/DNS/TLS/WebSocket 原生协议，或需要 5 秒级高频检查，选 **Go**（[Go 后端说明](../backends/go/README.md)）。注：原生 ICMP 需要宿主机原始套接字权限。

## English

Uptime Polaris offers Cloudflare Worker and Go backends sharing the same frontend and `/admin` console. Pick one per deployment.

| Capability | Cloudflare Worker | Go backend |
| --- | --- | --- |
| Hosting | Cloudflare Workers | Server or Docker |
| Database | D1 or PostgreSQL | SQLite or PostgreSQL |
| Native probes | HTTP, TCP | HTTP, TCP, UDP, ICMP, DNS, TLS, WebSocket |
| Agent probes | Supported | Supported |
| Minimum interval | 60 seconds | 5 seconds |
| SSL check | Daily public certificate lookup | Daily live TLS handshake |
| Theme storage | R2 bucket | Local data directory |

- **Choose Worker** for serverless hosting with 60-second public HTTP/TCP checks ([Deployment](deployment.md#english)).
- **Choose Go** for private-network probes, native UDP/ICMP/DNS/TLS/WebSocket checks, or intervals down to 5 seconds ([Go backend](../backends/go/README.md#english)). Native ICMP requires raw-socket host privileges.
