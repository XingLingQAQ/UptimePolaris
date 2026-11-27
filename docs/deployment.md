# 部署指南

[English](#english)

本文说明如何部署 Uptime Polaris 的 Cloudflare Worker 后端。自有服务器或 Docker 部署见 [Go 后端说明](../backends/go/README.md)。

## 目录

- [Fork 部署（推荐）](#fork-部署推荐)
- [一键按钮部署](#一键按钮部署)
- [手动 CLI 部署](#手动-cli-部署)
- [域名与反向代理](#域名与反向代理)
- [PostgreSQL 连接要求](#postgresql-连接要求)
- [从 D1 迁移到 PostgreSQL](#从-d1-迁移到-postgresql)

## Fork 部署（推荐）

1. Fork 本仓库到你的 GitHub 账号。
2. 在 Cloudflare 控制台打开 **Workers & Pages → Create application → GitHub**，选择该仓库：
   - 构建命令：`npm run build`
   - 部署命令：`npm run deploy`
3. 部署完成后访问站点进入 `/setup`，按提示在 Worker 设置中添加绑定与密钥：
   - **`CONFIG`（KV，必需）**：在 **Settings → Bindings** 添加，用于保存配置与设置。
   - **`UPTIME`（Analytics Engine，必需）**：先在账号内开启 Analytics Engine，再添加名为 `UPTIME` 的数据集绑定。
   - **`ADMIN_TOKEN`（Secret，必需）**：在 **Settings → Variables and Secrets** 添加长随机字符串。
   - **`DB`（D1，可选）**：需要使用 D1 时绑定；不绑定时默认使用 PostgreSQL。
   - **`THEMES`（R2，可选）**：安装第三方主题时需要，可稍后补充。
4. 在 Cloudflare 保存并部署后，回到 `/setup` 点击“重新检查”，通过后完成数据库配置与管理员创建。

**多账号构建提示**：若 Workers Builds 使用的 `CLOUDFLARE_API_TOKEN` 可访问多个账号，请在构建变量中设置 `CLOUDFLARE_ACCOUNT_ID`，以便 `npm run deploy` 保留你在控制台绑定的资源。后续升级直接在 GitHub 点击 **Sync fork** 即可自动重新部署。

## 一键按钮部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

一键按钮会新建独立仓库（非 Fork，后续无法通过 Sync fork 同步上游）：

1. 点击按钮并连接 Cloudflare 与 GitHub，确认账号、仓库名与 Worker 名不与现有服务冲突。
2. 保持构建命令 `npm run build`、部署命令 `npm run deploy`，按提示填入随机 `ADMIN_TOKEN`。
3. 部署后打开站点，按 [Fork 部署](#fork-部署推荐) 中的说明绑定 `CONFIG`、`UPTIME` 等资源并完成 `/setup`。

## 手动 CLI 部署

本地需准备 Node.js 24 与 npm，并在仓库根目录安装依赖：

```sh
npm ci && npm --prefix frontend ci
```

手动部署使用两份独立配置（与根目录 `wrangler.jsonc` 无关；直接跑 `npx wrangler` 时 JSONC 优先级更高）：
- `backends/worker/cloudflare.config.ts`：CF CLI 部署配置。
- `backends/worker/wrangler.toml`：D1 数据库与用户管理 CLI 配置。

### 创建资源与部署

```sh
npx cf auth login
npx cf d1 create --name uptime-polaris               # 使用 D1 时执行
npx cf r2 buckets create --name uptime-polaris-themes # 使用第三方主题时执行
```

1. 在 `cloudflare.config.ts` 和 `wrangler.toml` 中填入对应的 `CONFIG` KV ID、`UPTIME` 数据集及可选资源（仅用 PostgreSQL 时删掉 `DB` 绑定并设 `DATABASE_TYPE = "postgres"`）。勿修改绑定变量名。
2. 在 `.secrets/production.json`（已 gitignore）中配置随机密钥：

```json
{
  "ADMIN_TOKEN": "replace-with-a-long-random-secret"
}
```

3. 执行部署；使用 D1 时先初始化表结构：

```sh
npm run deploy -- --secrets-file .secrets/production.json
npx wrangler login && npm run db:init
```

## 域名与反向代理

在 Worker 设置中绑定自定义域名即可直接提供服务。若前端套用反向代理：
- 保留原始 `Host` 请求头；
- 为 `/api/public/agent/*` 放行 WebSocket；
- 勿将 `/api/*` 重写为 HTML 页面。

更换域名后，需在已安装的各台 Agent 中更新 `endpoint` 并重启服务。

## PostgreSQL 连接要求

```text
postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full
```

- 使用 `postgres://` 或 `postgresql://`，包含用户名、非空密码、公网可达主机和库名（密码中的 `@`、`:`、`/`、`?`、`#` 等字符须做 URL 编码）。
- 查询参数仅支持 `sslmode`（`verify-full` 或 `require`，省略时默认 `verify-full`）。
- 已有空库可在 `/setup` 直接填写并自动建表；已有历史数据库缺少迁移时，在终端设置 `DATABASE_URL` 并执行 `npm run db:migrate:postgres`。

## 从 D1 迁移到 PostgreSQL

后台 **设置 → 迁移到 PostgreSQL** 支持一次性复制 D1 业务表到空 PostgreSQL 库（单表上限 5,000 行、合计 10,000 行，不含 R2 主题和历史曲线）：

1. **备份并准备目标库**：准备专用的空 PostgreSQL 库，迁移期间禁止其他进程写入。
2. **停止源库写入**：暂停定时检查、Push、Agent 上报与后台变更，直到切换完成。
3. **检查并复制**：在设置页填入目标连接串，点击“检查数据库”确认后开始复制（若超时或断线，重试前务必先确认目标库事务是否已提交）。
4. **切换配置**：在 Worker 设置 `DATABASE_TYPE=postgres` 和 `DATABASE_URL` Secret；若 `CONFIG` KV 中存在 `database` 键，先备份后删除，防止旧的 D1 选择覆盖变量。
5. **恢复服务**：部署生效后验证数据与连通性，再恢复监控检查与流量。

## English

This guide covers deploying Uptime Polaris on Cloudflare Workers. For server or Docker hosting, see the [Go backend guide](../backends/go/README.md#english).

### Contents

- [Deploy a fork (recommended)](#deploy-a-fork-recommended)
- [Deploy with the Cloudflare button](#deploy-with-the-cloudflare-button)
- [Manual CLI deployment](#manual-cli-deployment)
- [Custom domains and reverse proxies](#custom-domains-and-reverse-proxies)
- [PostgreSQL connection requirements](#postgresql-connection-requirements)
- [Migrate from D1 to PostgreSQL](#migrate-from-d1-to-postgresql)

### Deploy a fork (recommended)

1. Fork this repository to your GitHub account.
2. In Cloudflare **Workers & Pages → Create application → GitHub**, select your fork:
   - Build command: `npm run build`
   - Deploy command: `npm run deploy`
3. Open `/setup` after the first deploy and add the missing Worker bindings/secrets:
   - **`CONFIG` (KV, required)**: under **Settings → Bindings**, stores configuration and settings.
   - **`UPTIME` (Analytics Engine, required)**: enable Analytics Engine on your account, then add the `UPTIME` dataset binding.
   - **`ADMIN_TOKEN` (Secret, required)**: under **Settings → Variables and Secrets**, set a long random string.
   - **`DB` (D1, optional)**: bind a D1 database if desired; otherwise PostgreSQL is used.
   - **`THEMES` (R2, optional)**: required only for third-party themes.
4. Save and redeploy in Cloudflare, click **Re-check** on `/setup`, then complete database and admin setup.

If `CLOUDFLARE_API_TOKEN` spans multiple accounts during Workers Builds, set `CLOUDFLARE_ACCOUNT_ID` in build variables so `npm run deploy` preserves your dashboard bindings. Upgrade forks via **Sync fork** on GitHub.

### Deploy with the Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

The button creates a standalone repository (not a fork, so **Sync fork** is unavailable):

1. Authorize Cloudflare and GitHub and pick a unique Worker name.
2. Keep `npm run build` / `npm run deploy` and supply a random `ADMIN_TOKEN`.
3. Add `CONFIG`, `UPTIME`, and optional bindings as described in [Deploy a fork](#deploy-a-fork-recommended), then finish `/setup`.

### Manual CLI deployment

Requires Node.js 24 and npm (`npm ci && npm --prefix frontend ci`). Edit `backends/worker/cloudflare.config.ts` (CF CLI) and `backends/worker/wrangler.toml` (D1/user CLI tools)—separate from root `wrangler.jsonc`.

```sh
npx cf auth login
npx cf d1 create --name uptime-polaris               # Optional: for D1
npx cf r2 buckets create --name uptime-polaris-themes # Optional: for themes
```

1. Fill in `CONFIG` KV ID, `UPTIME` dataset, and optional resources in both config files without renaming binding keys (for PostgreSQL only, remove `DB` and set `DATABASE_TYPE = "postgres"`).
2. Create gitignored `.secrets/production.json` with `{"ADMIN_TOKEN": "..."}`.
3. Deploy and (if using D1) initialize schema:

```sh
npm run deploy -- --secrets-file .secrets/production.json
npx wrangler login && npm run db:init
```

### Custom domains and reverse proxies

Bind your production domain in Worker settings. If fronting with a reverse proxy, preserve `Host`, allow WebSocket upgrades on `/api/public/agent/*`, and never rewrite `/api/*` to HTML. Update `endpoint` and restart existing Agents after changing domains.

### PostgreSQL connection requirements

```text
postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full
```

- Must use `postgres://` or `postgresql://` with username, non-empty percent-encoded password, public host, and database name.
- Only `sslmode=verify-full` (default) or `sslmode=require` is supported.
- Empty databases initialize during `/setup`; to migrate an existing database, run `npm run db:migrate:postgres` with `DATABASE_URL` exported.

### Migrate from D1 to PostgreSQL

**Settings → Migrate to PostgreSQL** copies D1 tables once to an empty PostgreSQL database (max 5,000 rows per table, 10,000 total; excludes R2 themes and Analytics Engine history):

1. Prepare an exclusive empty PostgreSQL database and back up D1.
2. Stop all source writes (checks, Push, Agents, admin edits) until cutover completes.
3. Enter the PostgreSQL URL under **Settings → Migrate to PostgreSQL**, check tables, and copy (if disconnected, verify target state before retrying).
4. Set `DATABASE_TYPE=postgres` and `DATABASE_URL` secret on the Worker; back up and delete any `database` key in `CONFIG` KV.
5. Deploy, confirm PostgreSQL connectivity, and resume traffic.
