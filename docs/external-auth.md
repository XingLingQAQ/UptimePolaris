# 外部认证

[English](#english)

Go 后端支持接收反向代理注入的身份请求头，或 Cloudflare Access 签发的 JWT。通过验证的身份直接获得管理员权限。该功能默认关闭，Worker 后端不支持。

启用前需先通过 `/setup` 创建本地管理员，并保留本地账号或 `POLARIS_ADMIN_TOKEN` 用于应急恢复。外部身份不会与同名本地账号合并，也不能修改本地账号密码。

## 环境变量

在进程环境或 `.env` 中配置后重启 Go 服务（每次仅启用一种模式）：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `POLARIS_AUTH_MODE` | `disabled` | 可选 `disabled`、`trusted-header`、`cloudflare-access` |
| `POLARIS_AUTH_HEADER` | `Remote-User` | `trusted-header` 模式读取的身份头 |
| `POLARIS_AUTH_TRUSTED_PROXIES` | 空 | 允许注入身份头的直连代理 CIDR（逗号分隔），`trusted-header` 必填 |
| `POLARIS_AUTH_CF_TEAM_DOMAIN` | 空 | `https://<team>.cloudflareaccess.com`，`cloudflare-access` 必填 |
| `POLARIS_AUTH_CF_AUDIENCE` | 空 | Access 应用 AUD 标签，`cloudflare-access` 必填 |
| `POLARIS_AUTH_ALLOWED_IDENTITIES` | 空 | 允许登录的身份白名单（逗号分隔；留空允许全部上游已验证身份） |

- `trusted-header` 区分大小写精确匹配。
- `cloudflare-access` 按 JWT 邮箱匹配，不区分大小写。

## 可信代理模式（Authelia、Authentik 等）

```dotenv
POLARIS_AUTH_MODE=trusted-header
POLARIS_AUTH_HEADER=Remote-User
POLARIS_AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128
POLARIS_AUTH_ALLOWED_IDENTITIES=alice,bob
```

安全要求：
- 代理认证后必须**覆盖**身份头并保留 `Host`，禁止透传客户端自带的同名请求头。
- `POLARIS_AUTH_TRUSTED_PROXIES` 仅校验直连 TCP 对端 IP（忽略 `X-Forwarded-For`），且禁止配置 `0.0.0.0/0` 或 `::/0`。跨容器或跨主机部署时请填实际代理 CIDR。
- 该配置独立于登录限流用的 `POLARIS_TRUSTED_PROXIES` 和 `POLARIS_TRUST_PROXY`。

## Cloudflare Access 模式

```dotenv
POLARIS_AUTH_MODE=cloudflare-access
POLARIS_AUTH_CF_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
POLARIS_AUTH_CF_AUDIENCE=your-application-aud
POLARIS_AUTH_ALLOWED_IDENTITIES=owner@example.com,operator@example.com
```

接入要求：
- 在 Access 中保护 `/admin`、`/login` 与管理 API，确保传递 `Cf-Access-Jwt-Assertion`。
- Agent 上报、Push 心跳和公开状态接口不要启用交互式 Access 登录拦截。
- 仅含邮箱头或不含用户邮箱的 Service Token 无法登录后台。

## 退出与恢复

在 Polaris 点击“退出”仅清除本地会话并暂停自动外部登录，不会注销上游身份提供方；点击登录页“使用外部身份登录”可重新认证。上游故障时可通过本地账号、`POLARIS_ADMIN_TOKEN` 或将 `POLARIS_AUTH_MODE` 设为 `disabled` 重启恢复。

## English

The Go backend supports admin sign-in via trusted reverse-proxy headers or Cloudflare Access JWTs (disabled by default; unsupported on Worker).

Complete `/setup` with a local administrator first and keep that account or `POLARIS_ADMIN_TOKEN` for recovery. External identities stay separate from local accounts and cannot change local passwords.

### Environment variables

Configure in process env or `.env` and restart Go (enable one mode at a time):

| Variable | Default | Purpose |
| --- | --- | --- |
| `POLARIS_AUTH_MODE` | `disabled` | `disabled`, `trusted-header`, or `cloudflare-access` |
| `POLARIS_AUTH_HEADER` | `Remote-User` | Identity header for `trusted-header` |
| `POLARIS_AUTH_TRUSTED_PROXIES` | Empty | Direct proxy CIDRs (comma-separated; required for `trusted-header`) |
| `POLARIS_AUTH_CF_TEAM_DOMAIN` | Empty | `https://<team>.cloudflareaccess.com` (required for `cloudflare-access`) |
| `POLARIS_AUTH_CF_AUDIENCE` | Empty | Access AUD tag (required for `cloudflare-access`) |
| `POLARIS_AUTH_ALLOWED_IDENTITIES` | Empty | Allowed identities (comma-separated; empty allows all verified upstream users) |

`trusted-header` matches case-sensitively; `cloudflare-access` matches the signed email claim case-insensitively.

### Trusted-header mode (Authelia, Authentik, etc.)

```dotenv
POLARIS_AUTH_MODE=trusted-header
POLARIS_AUTH_HEADER=Remote-User
POLARIS_AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128
POLARIS_AUTH_ALLOWED_IDENTITIES=alice,bob
```

- Proxies must overwrite the identity header and preserve `Host` (never pass through client-supplied headers).
- `POLARIS_AUTH_TRUSTED_PROXIES` checks only the TCP peer IP (ignoring `X-Forwarded-For`), rejects `0.0.0.0/0` and `::/0`, and is independent of `POLARIS_TRUSTED_PROXIES` / `POLARIS_TRUST_PROXY`. Use real container/host CIDRs when not on loopback.

### Cloudflare Access mode

```dotenv
POLARIS_AUTH_MODE=cloudflare-access
POLARIS_AUTH_CF_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
POLARIS_AUTH_CF_AUDIENCE=your-application-aud
POLARIS_AUTH_ALLOWED_IDENTITIES=owner@example.com,operator@example.com
```

- Protect `/admin`, `/login`, and management APIs in Access while keeping Agent, Push, and public routes reachable without interactive login.
- Polaris validates the RS256 signature and claims in `Cf-Access-Jwt-Assertion` against `/cdn-cgi/access/certs`; email headers alone or service tokens without a user email are rejected.

### Sign out and recovery

Signing out clears the local session and pauses automatic external sign-in without logging out of your identity provider (click **Continue with external sign-in** on `/login` to resume). Keep local credentials, `POLARIS_ADMIN_TOKEN`, or `POLARIS_AUTH_MODE=disabled` for recovery.
