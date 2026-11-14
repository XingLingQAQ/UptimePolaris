# 部署指南

[English](#english)

本文说明怎么部署一套新的 Uptime Polaris。已有环境要保留原来的数据库、密钥和主题存储，不要重复创建资源。

Cloudflare 步骤针对 Worker。自有服务器可选 [Go 后端](backends.md#部署)，两种后端共用内置界面。

## 目录

- [准备环境](#准备环境)
- [Fork 后部署到 Cloudflare](#fork-后部署到-cloudflare)
- [通过 Cloudflare 按钮部署](#通过-cloudflare-按钮部署)
- [手动部署到 Cloudflare](#手动部署到-cloudflare)
- [准备 Cloudflare 资源](#准备-cloudflare-资源)
- [配置部署](#配置部署)
- [Agent 下载](#agent-下载)
- [上传与初始化](#上传与初始化)
- [域名与代理](#域名与代理)
- [使用 PostgreSQL](#使用-postgresql)
- [从 D1 迁移到 PostgreSQL](#从-d1-迁移到-postgresql)
- [上线检查](#上线检查)

## 准备环境

Fork 部署和按钮部署需要一个 Cloudflare 账号和一个 GitHub 账号。手动部署还需要 Node.js 24 和 npm。

```sh
npm ci
npm --prefix frontend ci
```

## Fork 后部署到 Cloudflare

1. Fork 本仓库。
2. 在 Cloudflare 控制台进入 **Workers & Pages → Create application → GitHub**，选择 fork 后的仓库。构建命令填写 `npm run build`，部署命令填写 `npm run deploy`。
3. 部署完成后打开站点。初始化页面的第一步是部署检查，未通过的项会写明配置方法：
   - **D1（可选）**：需要使用 D1 时，在 Worker 的 **Settings → Bindings** 中添加 D1 数据库，变量名填写 `DB`。未绑定不影响进入下一步。
   - **`ADMIN_TOKEN`（必需）**：在 **Settings → Variables and Secrets** 中添加 Secret，值使用足够长的随机字符串。
   - **`THEMES`（可选）**：安装第三方主题时，在 **Settings → Bindings** 中添加 R2 存储桶。
   - **`UPTIME`（必需）**：先在控制台启用 Analytics Engine，再添加数据集绑定。

   在 Cloudflare 保存并部署配置后，回到初始化页面点击“重新检查”。必需项未通过时，“下一步”不可用；R2 可在初始化后添加。
4. 必需项全部通过后点击“下一步”，配置并验证数据库，再设置管理员账号。要求见[完成初始化](#完成初始化)。

数据库在第二步配置。未绑定 D1 时默认 PostgreSQL，可直接在页面填写连接地址并点击“验证并继续”；绑定 D1 后也可选择 D1。验证成功后进入第三步设置管理员账号，无需预先在控制台添加 `DATABASE_URL`。

根目录的 `wrangler.jsonc` 不声明 D1、R2 和 Analytics Engine 绑定，这些资源由用户绑定；数据库配置存储 `SETUP_CONFIG` Durable Object 随 Worker 部署。`wrangler deploy` 会用配置文件覆盖 Worker 的绑定，因此 `npm run deploy` 在 Workers Builds 中会先通过 Cloudflare API 读取 Worker 现有的 `DB`、`THEMES`、`UPTIME` 绑定，带上它们再部署；读取失败时部署会停止，不会删除已有绑定。这一步使用 Workers Builds 提供的 `CLOUDFLARE_API_TOKEN`。如果构建环境中没有 `CLOUDFLARE_ACCOUNT_ID`，且该令牌能访问多个账号，请在构建变量中设置 `CLOUDFLARE_ACCOUNT_ID`。

`wrangler.jsonc` 启用了 `keep_vars`，在控制台添加的普通变量在重新部署后保留；Secret 不受部署影响。

升级时，在 GitHub 上执行 Sync fork，Workers Builds 会自动重新部署。

## 通过 Cloudflare 按钮部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

按钮使用 GitHub 上的公开仓库版本。Cloudflare 会在你的 GitHub 账号下新建一个仓库并部署；这个仓库不是 fork，之后无法通过 Sync fork 同步更新。

1. 点击按钮，登录 Cloudflare 并连接 GitHub。
2. 核对目标账号、仓库名和 Worker 名。Worker 名不要与账号中已有的 Worker 重复，以免覆盖已有 Worker。
3. 构建命令和部署命令保持为 `npm run build` 和 `npm run deploy`。
4. 页面要求填写 `ADMIN_TOKEN` 时，填入足够长的随机值。不要把密钥提交到仓库。
5. 部署成功后打开站点，按初始化页面的检查结果配置数据库、`UPTIME` 和初始化密钥，再完成初始化。绑定方法与 [Fork 后部署](#fork-后部署到-cloudflare)相同。

Agent 安装需要访问 GitHub 下载服务，要求见 [Agent 下载](#agent-下载)。

## 手动部署到 Cloudflare

下面这些步骤用于手动配置 CF CLI 的部署。已有环境的资源和密钥要保留，动手前先核对账号与绑定。

## 准备 Cloudflare 资源

登录 CF CLI：

```sh
npx cf auth login
```

新部署使用 D1 时创建数据库；使用主题时再创建 R2 桶：

```sh
npx cf d1 create --name uptime-polaris
npx cf r2 buckets create --name uptime-polaris-themes
```

记下数据库返回的 ID。已有资源可直接复用，不用因为产品改名就重建。

| 资源 | 绑定名 | 用途 |
| --- | --- | --- |
| D1（可选） | `DB` | 使用 D1 时的业务数据库 |
| Durable Object | `SETUP_CONFIG` | 未绑定 D1 时保存加密的数据库配置，随 Worker 部署 |
| 静态资产 | `ASSETS` | 前端资源 |
| R2（可选） | `THEMES` | 第三方主题 ZIP 解包后的版本资产 |
| Analytics Engine（必需） | `UPTIME` | 原始观测与 SQL 回填 |

只使用 PostgreSQL 时，可从两份手动配置中移除 `DB`，在初始化第二步填写连接地址。保留 `SETUP_CONFIG` 的声明和迁移配置，用于保存连接。不用第三方主题，可从两份配置里删掉 `THEMES`。`UPTIME` 是 Worker 初始化的必需绑定，请保留。声明 Analytics Engine 之前，先在账号里启用该服务。AE SQL 查询凭据只用于可选的数据回填，不是初始化要求。

## 配置部署

手动部署时两份配置都要核对：

| 文件 | 使用方 | 需要核对 |
| --- | --- | --- |
| `backends/worker/cloudflare.config.ts` | CF CLI 部署 | Worker 名称、D1 名称与 ID、R2 名称、AE 数据集、变量与调度 |
| `backends/worker/wrangler.toml` | 迁移与数据库工具 | 同一套资源绑定和数据库后端 |

根目录的 `wrangler.jsonc` 用于 Fork 部署和按钮部署，和上面的手动配置互不相干。两种格式同时存在时，直接运行 `npx wrangler` 默认读 JSONC。数据库 npm 脚本默认显式使用 `backends/worker/wrangler.toml`；直接用 Wrangler 操作原有环境时，加上 `--config backends/worker/wrangler.toml`，并在操作前确认目标账号、数据库名称和 ID。

绑定名 `DB`、`ASSETS`、`THEMES`、`UPTIME` 和 `SETUP_CONFIG` 保持不变；资源名称可自行命名。D1 工具通过 `DB` 绑定选择数据库。

静态资源目录是 `public/`。保留 SPA 回退和 `runWorkerFirst` / `run_worker_first` 里的业务路径，尤其是 `/api/*`、`/install.sh`、`/install.ps1`。

### 密钥

在已忽略的 `.secrets/` 目录创建 `production.json`：

```json
{
  "ADMIN_TOKEN": "replace-with-a-long-random-secret"
}
```

用密码管理器或随机生成器生成实际密钥。这个密钥既用于首次初始化，也用于调用管理 API。不要把它换成 Agent Token 或登录密码。

启用 AE SQL 回填时，另外配置 `CF_ACCOUNT_ID` 和有账号 Analytics Read 权限的 `CF_API_TOKEN`。PostgreSQL 连接可在初始化第二步填写，无需预先添加 `DATABASE_URL`。变量完整说明见[配置参考](configuration.md)。

## Agent 下载

安装器下载所选平台的最新稳定版本，并校验文件完整性。目标平台没有可用版本，或者 GitHub 访问不了，安装会失败。

安装和更新需要目标机器能访问 GitHub API 和 Release 下载地址。

## 上传与初始化

手动部署执行：

```sh
npm run deploy -- --secrets-file .secrets/production.json
```

手动部署用 CF CLI；Fork 部署和按钮部署由 Workers Builds 使用根目录的 `wrangler.jsonc` 和 Wrangler。两条路径的账号认证和资源配置要分别核对。

空 D1 会在首次请求时建表。已有迁移记录的 D1，Worker 请求也可能自动应用还没记录的迁移。升级前先备份，在隔离环境审阅并验证迁移；确认目标后，可在部署新 Worker 之前先跑迁移：

```sh
npx wrangler login
npm run db:init
```

Wrangler 要能访问 `backends/worker/wrangler.toml` 指向的同一个账号和数据库。迁移不会创建默认账号。

Fork 部署和按钮部署的 D1 由 Worker 在请求时建表并应用迁移，不需要手动执行迁移命令。

### 完成初始化

打开站点地址，进入 `/setup`：

1. **部署检查（仅 Worker）**：检查 `ADMIN_TOKEN` 和 Analytics Engine，D1、R2 为可选项。保存并部署缺少的配置后点击“重新检查”，必需项通过后继续。
2. **数据库配置（仅 Worker）**：输入 `ADMIN_TOKEN`，选择数据库。PostgreSQL 可直接填写连接 URL；点击“验证并继续”，连接和建表通过后进入最后一步。
3. **管理员账号**：设置用户名、密码和可选的站点名称，创建后进入 `/admin`。Go 后端仍在同一张表单中填写初始化凭据、数据库和账号信息。后续从 `/login` 登录。

用户名为 2–32 个字母、数字或 `._-`，会统一转为小写；密码至少 8 位。系统不开放公开注册，初始化完成后无法再通过初始化接口创建账号。

初始化时，Worker 可选 D1 或 PostgreSQL，Go 可选 SQLite 或 PostgreSQL。新选 PostgreSQL 需填写连接 URL，格式示例：

```text
postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full
```

已保存的 PostgreSQL 连接可以留空复用。不绑定 D1 也可在页面填写新连接：Worker 会将加密配置保存到随部署提供的 Durable Object；有 D1 时使用 D1 控制记录。数据库验证不会创建账号，最后一步才在目标库创建管理员和会话。后续请求和重启继续使用该库。请勿在截图或公开日志中暴露连接 URL。字段和错误码见 [API 初始化契约](api.md#初始化数据库契约)。

## 域名与代理

在 Cloudflare Worker 的域名设置里绑定准备长期使用的自定义域名。应用按站点根路径运行，前端构建基址是 `/`。

安装命令会用当前访问的 origin，包含协议、域名和端口。代理要正确转发 Host，并为 `/api/public/agent/*` 放行 WebSocket。安装入口和 API 不要套用返回 HTML 的 SPA 重写。

换域名之前，先验证新入口的 API、脚本和 WebSocket，再更新现有机器 `config.json` 里的 `endpoint` 并重启 Agent。已有 Agent 不会因为网页换了域名就自动改地址。

## 使用 PostgreSQL

1. 准备 Worker 能连接的 PostgreSQL 数据库和访问凭据。连接 URL 示例：

   ```text
   postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full
   ```

   URL 需使用 `postgres://` 或 `postgresql://` 协议，包含用户名、密码、主机名和数据库名（Worker 侧还要求密码非空且主机为公网可达域名/IP）；查询参数仅支持 `sslmode`（`verify-full` 或 `require`，省略时自动按 `verify-full` 处理）。密码中包含 `@`、`:`、`/`、`?`、`#` 等特殊字符时需先做百分号编码（URL 编码）。
2. 保留 Worker 配置中的 `nodejs_compat`。打开 `/setup`，通过第一步部署检查。
3. 在第二步选择 PostgreSQL，填写连接 URL 和 `ADMIN_TOKEN`，点击“验证并继续”。验证会连接数据库并为新库建表，不会创建管理员账号。
4. 验证通过后，在第三步设置管理员账号。已有数据库缺迁移时，在能连接目标库的终端里设置同一个 `DATABASE_URL`，执行迁移：

```sh
npm run db:migrate:postgres
```

迁移工具读取 `database/schema/postgres/`，逐文件按事务执行并记录结果；没有迁移记录的已有表结构，它不会去猜。后台数据迁移功能也可初始化空的 PostgreSQL 目标库，步骤见[从 D1 迁移到 PostgreSQL](#从-d1-迁移到-postgresql)。

已部署的 `DATABASE_URL` 仍可在初始化时留空复用，页面保存的选择优先。`db:init`、`user:create` 等 D1 工具只针对 D1，不能用于 PostgreSQL。

## 从 D1 迁移到 PostgreSQL

后台的“设置 → 迁移到 PostgreSQL”可将当前 D1 的表数据复制到远程 PostgreSQL。复制完成后应用仍然用 D1，数据库配置要另外切换。

1. 备份当前 D1 数据库和 PostgreSQL 目标库。准备一个专供本次迁移的 PostgreSQL 数据库，连接地址格式如 `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`（需包含用户名、密码和数据库名，并支持通过 TLS 验证证书）。目标 schema 应为空；也可用已按当前版本初始化、但没有业务数据的库。迁移期间目标库必须独占，不允许其他进程写入或创建对象。
2. 暂停所有写 D1 的操作：定时检查、Push、Agent 上报、管理修改都算。管理员仍要能访问设置页。从开始迁移到切换完成，源库一直保持停写。页面检测不到所有源数据变化，复制完成后的写入也不会同步。
3. 进入后台“设置 → 迁移到 PostgreSQL”，填目标连接地址，点“检查数据库”。页面会显示各表行数，并说明目标库是否需要初始化。全空目标库会在执行复制时初始化；有其他对象或已有业务数据的目标库会被拒绝。
4. 确认停写、目标库也准备好了，勾选确认并开始迁移。建表和数据复制在目标库的事务里执行；迁移不会覆盖目标库已有的业务数据。
5. 核对迁移结果、目标库和所需资源，源库继续保持停写。使用默认 D1 初始化且没有活动覆盖记录时，按[使用 PostgreSQL](#使用-postgresql)配置 `DATABASE_TYPE` 和 `DATABASE_URL`，部署更新并验证目标后，再恢复流量和写入。
6. 如果从预配 PostgreSQL 的部署里显式选过 D1，活动覆盖记录优先于部署变量。由有数据库权限的运维人员在停写、备份和复制确认后，核对正确的 D1 账号、数据库和目标 PostgreSQL 配置；把 `DATABASE_TYPE=postgres` 和目标 `DATABASE_URL` 的部署、控制记录切换放在同一个停写窗口里。先只读确认记录，再只删除匹配的活动 D1 记录：

   ```sql
   SELECT id, type, phase FROM _polaris_database WHERE id = 1;
   DELETE FROM _polaris_database WHERE id = 1 AND phase = 'active' AND type = 'd1';
   ```

   查询结果不匹配就不删。绝不能删 `pending` 记录，也不要清空整表或数据库。切换后确认服务真的在用目标 PostgreSQL，再恢复流量和写入；回退前停写，用受保护的 D1 控制数据和数据库备份恢复原配置。

这个功能只复制 D1 表里的数据，不复制 R2 主题文件或 Analytics Engine 数据，也不会持续同步。需要的外部资源要单独保留或迁移。当前每张表最多 5,000 行，合计最多 10,000 行，数据大小按保守值估算；超过限制要另定迁移方案。

页面报错时，先检查目标地址、证书、权限和数据库状态。断线或超时的时候，事务可能已经提交；重试前必须检查目标库的表和数据，确认结果后再决定。不要直接清空已有数据重试。

## 上线检查

- `/api/public/health` 返回 JSON，首页、`/login` 和 `/admin` 深链接能正常打开。
- 完成初始化，重新登录有效，站点语言和图标正常。
- 新建 HTTP 监控，过完一个调度周期后能看到真实检查时间和结果。
- Push POST 生效，GET 不产生心跳。
- `/install.sh` 和 `/install.ps1` 返回脚本，目标平台的清单和二进制能下载。
- Agent 首次上报可见；通知测试成功，分组范围符合预期。
- 启用主题时，上传、预览和激活可用；启用 AE 时，回填状态和凭据一致。

服务没有数据时，先查调度和请求结果，见[常见问题](troubleshooting.md)。

## English

This guide covers a new installation. For an existing deployment, keep its database, secrets and theme storage. Worker deployment is described below; for a server or container, see [Go backend options](backends.md#english) and the [Go guide](../backends/go/README.md).

### Prerequisites

Fork and button deployments require a Cloudflare account and a GitHub account. Manual deployment also needs Node.js 24 and npm. Install the site dependencies with `npm ci` and `npm --prefix frontend ci`.

### Deploy a fork to Cloudflare

1. Fork this repository.
2. In the Cloudflare dashboard, open **Workers & Pages → Create application → GitHub** and select your fork. Set the build command to `npm run build` and the deploy command to `npm run deploy`.
3. When the deployment finishes, open the site. The first step of setup is a deployment check, and each item that fails says how to configure it:
   - **D1 (optional)**: to use D1, add a D1 database in the Worker's **Settings → Bindings** with the variable name `DB`. This binding is not required to continue to the next step.
   - **`ADMIN_TOKEN` (required)**: in **Settings → Variables and Secrets**, add a secret with a long random value.
   - **`THEMES` (optional)**: to install third-party themes, add an R2 bucket in **Settings → Bindings**.
   - **`UPTIME` (required)**: enable Analytics Engine in the dashboard, then add a dataset binding.

   Save and deploy the configuration in Cloudflare, then select **Re-check** on the setup page. **Next** stays disabled until all required items pass; R2 can be added after setup.
4. Once every required item passes, select **Next**, configure and verify the database, then create the administrator account. See [database setup and initialization](#database-setup-and-initialization).

Configure and verify the database in step two. Without D1, PostgreSQL is selected by default and its URL can be entered directly on the page. With D1 bound, either database is available. Step three creates the administrator account; no deployment `DATABASE_URL` is required.

The root `wrangler.jsonc` declares no D1, R2 or Analytics Engine binding, those resources are bound manually. The `SETUP_CONFIG` Durable Object for encrypted configuration is deployed with the Worker. `wrangler deploy` replaces the Worker's bindings with those in the configuration file. Under Workers Builds, `npm run deploy` therefore reads the Worker's existing `DB`, `THEMES` and `UPTIME` bindings through the Cloudflare API and deploys with them. If they cannot be read, the deploy stops instead of removing them. This uses the `CLOUDFLARE_API_TOKEN` that Workers Builds provides. If the build has no `CLOUDFLARE_ACCOUNT_ID` and the token can reach more than one account, set `CLOUDFLARE_ACCOUNT_ID` in the build variables.

`wrangler.jsonc` enables `keep_vars`, so plain variables added in the dashboard survive redeploys. Secrets are not affected by deploys.

To upgrade, select **Sync fork** on GitHub; Workers Builds redeploys automatically.

### Deploy with the Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XingLingQAQ/UptimePolaris)

The button uses the public GitHub repository. Cloudflare creates a new repository in your GitHub account and deploys it. That repository is not a fork, so it cannot be updated with Sync fork.

1. Select the button, sign in to Cloudflare and connect GitHub.
2. Check the account, repository name and Worker name. Do not reuse the name of an existing Worker, or it will be overwritten.
3. Keep the build and deploy commands as `npm run build` and `npm run deploy`.
4. If the page asks for `ADMIN_TOKEN`, enter a long random value. Never commit secrets to the repository.
5. After deployment, open the site, configure a database, `UPTIME` and the setup secret as the check describes, then finish setup. The bindings are the same as for a [fork deployment](#deploy-a-fork-to-cloudflare).

Agent installation requires access to GitHub downloads. See [Agent downloads](#agent-downloads).

### Manual Cloudflare deployment

Authenticate the CF CLI with `npx cf auth login`. For a new installation using D1, create a database with `npx cf d1 create --name uptime-polaris`; if using third-party themes, create an R2 bucket with `npx cf r2 buckets create --name uptime-polaris-themes`. Existing resources need not be recreated. Enable Analytics Engine in the account before declaring the required `UPTIME` binding.

Keep `backends/worker/cloudflare.config.ts` (CF CLI deployment) and `backends/worker/wrangler.toml` (database tools) aligned on the intended resources, variables and schedules. Keep bindings `DB`, `ASSETS`, `THEMES`, `UPTIME` and `SETUP_CONFIG` unchanged where used. For PostgreSQL-only deployment, remove `DB` from both manual configurations and enter the connection URL in setup step two. Retain the `SETUP_CONFIG` export, binding and migration to persist the connection. `ASSETS` serves `public/`; R2 stores third-party theme files, while Analytics Engine provides raw observations and SQL backfill. R2 is optional; built-in themes work without it. The `UPTIME` binding is required for Worker setup. Analytics Engine query credentials are only needed for optional SQL backfill.

The root `wrangler.jsonc` is used by fork and button deployments and is independent of the manual configuration. Direct Wrangler commands prefer it when both formats exist. For the manual environment, explicitly use `--config backends/worker/wrangler.toml` with direct database commands and check the account, database name and ID. Preserve SPA fallback and the configured worker-first routes, including `/api/*` and the installers.

Create an ignored `.secrets/production.json` containing a long random `ADMIN_TOKEN`; add the Analytics Engine query credentials when needed. Enter the PostgreSQL URL in setup step two; a deployment `DATABASE_URL` is not required. See [configuration](configuration.md#english). Then deploy:

```sh
npm run deploy -- --secrets-file .secrets/production.json
```

Manual deployment uses CF CLI; fork and button deployments run Wrangler with the root JSONC in Workers Builds. Verify authentication and resources separately for each path.

### Agent downloads

The installer downloads the latest stable version for the selected platform and verifies file integrity. Installation fails if the release or platform asset is missing or GitHub is unreachable.

Installation and updates require the target machine to reach the GitHub API and release download addresses.

### Database setup and initialization

An empty D1 can establish its schema on the first request. A Worker request can also apply pending migrations to a D1 with a migration ledger. Before upgrading, back up and review migrations in an isolated environment. To apply them before deploying to the manual target, authenticate Wrangler and run `npm run db:init` after confirming the TOML account and database. For fork and button deployments, the Worker creates tables and applies migrations on request; no migration command is needed. Migrations do not create an account.

Open `/setup`. Worker setup has three steps: check the required `ADMIN_TOKEN` and `UPTIME` bindings, configure and verify the database, then create the administrator account. D1 and R2 are optional. Enter `ADMIN_TOKEN` in the database step. Verification initializes an empty database but does not create an account. A username has 2–32 letters, digits or `._-`, normalized to lowercase; a password has at least 8 characters. After setup, use `/login`. Go keeps its single initialization form.

Without D1, Worker offers PostgreSQL only and accepts its URL directly on the page. With D1, either database is available. The encrypted connection is stored in the deployment-provided Durable Object without D1, or the D1 control record with D1. The final step creates the administrator and session in the selected database, which remains active after restarts. Keep connection URLs out of screenshots and public logs. See the [setup API contract](api.md#setup-database-contract).

For Worker PostgreSQL, retain `nodejs_compat` and enter a URL such as `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full` in the database step. Percent-encode special characters in the password; only `sslmode=verify-full` or `sslmode=require` is accepted in the query string. Verification initializes an empty database automatically. For an existing database with outstanding migrations, run `npm run db:migrate:postgres` from a terminal with access to the target and the same URL. D1-only tools such as `db:init` and `user:create` do not operate on PostgreSQL. A deployment-configured `DATABASE_URL` can still be reused.

To copy D1 data to PostgreSQL, use Settings → Migrate to PostgreSQL. Back up both databases first. The target must be empty or initialized to this version without business data, and exclusively owned by the migration. Stop all source writes, including scheduled checks, Push, Agent reports and administration, from the start of migration until cutover. Preview, confirm and copy, then inspect the result while keeping the source stopped. With default D1 setup and no active override, configure `DATABASE_TYPE` and `DATABASE_URL`, deploy and validate the target before resuming traffic and writes.

If setup explicitly selected D1 against a PostgreSQL deployment configuration, an active control record takes precedence. During the same stopped-write window, after backup and verified copy, an operator with database privileges must confirm the D1 account, database, target PostgreSQL configuration and record with the `SELECT` in the Chinese procedure above. Coordinate deploying `DATABASE_TYPE=postgres` and the target `DATABASE_URL` with deleting only the matching record using `DELETE FROM _polaris_database WHERE id = 1 AND phase = 'active' AND type = 'd1';`. Do not run the deletion if the record does not match, delete a pending record, or clear a table or database. Verify the service uses the PostgreSQL target before resuming traffic and writes. For rollback, stop writes and restore the original configuration with protected D1 control and database backups.

Copying does not switch the application or synchronize later writes; it excludes R2 and Analytics Engine. Limits are 5,000 rows per table and 10,000 total, with a conservative size estimate. After a disconnect or timeout, inspect the target before retrying: the transaction may already have committed. Do not clear existing data as a shortcut.

### Domain and release checks

Bind the long-term domain to the Worker. The application runs at the origin root. A reverse proxy must preserve Host, support WebSocket for `/api/public/agent/*`, and avoid rewriting API or installer requests to HTML. Before changing domains, check the new API, installers and WebSocket, then update each Agent's `endpoint` and restart it; existing Agents do not change automatically.

After deployment, check `/api/public/health`, the homepage, `/login` and the `/admin` deep link. Confirm setup and login, run an HTTP monitor, check Push POST and Agent reporting, and send a notification test. If enabled, check theme upload and activation and the Analytics Engine backfill state. Confirm the Agent can be installed on each intended platform. See [troubleshooting](troubleshooting.md#troubleshooting-guide) if data is missing.
