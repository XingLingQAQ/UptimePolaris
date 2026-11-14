# 运维指南

[English](#operations-guide)

本指南针对长期运行的 Uptime Polaris。做迁移、恢复或换域名之前，先确认当前账号、数据库和目标环境。

## 目录

- [调度与采集](#调度与采集)
- [升级流程](#升级流程)
- [备份](#备份)
- [恢复](#恢复)
- [切换数据库后端](#切换数据库后端)
- [数据保留](#数据保留)
- [日志与用量](#日志与用量)
- [凭据与公开信息](#凭据与公开信息)

## 调度与采集

Worker 的默认调度在部署配置里保持一致：

| Cron（UTC） | 用途 |
| --- | --- |
| `* * * * *` | 检查到期监控、处理 Push 超时和 Agent 状态、推进通知；UTC 00:10 后执行当天的日汇总、AE 历史归档与回填、保留策略清理 |

监控自己的间隔决定什么时候到期，不是每次 Cron 都会对所有监控发请求。实际吞吐还受请求预算、并发、超时和目标响应影响。

Worker 生产环境由 Cloudflare 调度。

Go 不依赖 Cloudflare Cron：进程每秒检查到期任务，启动时和每分钟尝试增量历史汇总与分批清理，实际执行时机由任务租约决定。服务必须一直运行，停进程也就停了后台调度。两种后端都要检查最近检查时间和任务日志，不能只看 HTTP 是否可以访问。

Worker 把监控观测和 Agent 资源历史写入 AE。实时状态、检查时间和状态变化保存在业务数据库中，状态条按真实检查时间展开，漏检不会补成正常，历史延迟也不会用最新值填充。

每分钟调度在 UTC 00:10（北京时间 08:10）后执行当天的日汇总：读取 AE，向业务数据库写入监控日统计和 Agent 资源日汇总。精确可用率保留原值，AE 仅补充延迟等历史指标。Agent 管理详情可切换“最近 24 小时”和“每日汇总”。任务分批推进并回查最近两天；查询失败后保留进度，下次重试。历史读取使用部署配置中的 `ANALYTICS_SQL` 绑定，无需额外查询凭据。

AE 单次调用最多写入 250 个点。一次 tick 超过上限时，历史写入轮换选取监控并记录 `history_write_partial`，不延长检查间隔；历史明细会有缺口。AE 查询还可能采样，界面会标明采样数据。精确状态、可用率和告警不依赖 AE 查询结果。

## 升级流程

### Worker

1. 记录当前服务版本、Worker 部署版本、数据库后端、绑定和 Agent 版本。
2. 备份数据库、主题资产和密钥，检查备份文件是否可读。
3. 在隔离环境审阅并验证迁移；不要拿重置脚本升级已有数据库。
4. 手动部署的 D1，先确认 `backends/worker/wrangler.toml`，再执行 `npm run db:init`；Fork 部署和按钮部署的 D1 由 Worker 在请求时应用迁移，见[部署指南](deployment.md#上传与初始化)。PostgreSQL 执行 `npm run db:migrate:postgres`。
5. 需要更新 Agent 时，先确认目标版本的下载清单和所需平台文件能访问。
6. 手动部署运行 `npm run deploy`；Fork 部署在 GitHub 上执行 Sync fork，按钮部署把新版本合并到生成的仓库，再由 Workers Builds 自动部署。检查初始化状态、登录、监控采集和通知。
7. 先小范围更新 Agent，确认版本、服务和上报都正常，再推广。

空 D1 会在首次请求时自动建表。已有迁移记录的 D1，Worker 请求也可能自动应用还没记录的迁移，所以要在部署新版本前完成备份和迁移审阅。已有库必须保持迁移记录和结构一致；不要删掉 ledger 让系统去猜结构。

旧版本 Worker 回滚也不会自动回滚数据库结构，恢复方式要结合迁移兼容性和备份来定。

### Go

1. 停止 Go 后端和自动重启器，备份整个数据目录（包括 SQLite、主题）和原配置；PostgreSQL 部署还要备份对应数据库。
2. 在隔离环境用目标版本和备份副本验证启动、账号、历史和主题。Go 使用独立的 `polaris_*` 表，**不要运行 Worker 的 `npm run db:migrate:postgres`**。
3. 准备新版本的 Go 程序或验证过的镜像；替换程序时保留数据目录和配置。Go 启动时会维护自己的表结构。
4. 用原数据目录和正确的数据库配置启动，检查登录、监控、Push、Agent 上报和通知，再恢复入口和自动重启器。

需要回退时，按实际数据库结构和备份选择恢复方式；只换回旧二进制，不保证能读新结构。完整启动和备份路径见 [Go 后端说明](../backends/go/README.md)。

## 备份

至少保留这些内容：

| 对象 | 备份内容 |
| --- | --- |
| 业务数据库 | 账号、Token、监控历史、通知及主题版本元数据 |
| Worker `CONFIG` KV | 后台设置（`settings`）和初始化选库记录（`database`） |
| R2 `THEMES` | 已安装主题的不可变资源，与数据库中的 prefix/revision 对应 |
| Worker 密钥 | `ADMIN_TOKEN`、数据库 URL 和其他已配置的密钥；用独立的受保护渠道保存 |
| Worker 初始化选库记录 | 网页选库所用的 D1 绑定及其控制记录；选择 PostgreSQL 后仍需保留该绑定 |
| Go 数据与配置 | 停止服务后备份整个数据目录、主题、`POLARIS_*` 配置；PostgreSQL 另备份数据库 |
| 部署配置 | 实际使用的配置、域名设置和服务版本 |
| Agent | 重要机器的配置与安装元数据，按敏感文件保存 |

下面的示例适用于原手动部署，`DATABASE_NAME` 换成实际物理名。先确认登录账号和 `backends/worker/wrangler.toml` 里的目标；直接运行 Wrangler 时，根目录的 JSONC 会优先于 TOML，所以必须显式选择配置：

```sh
npx wrangler d1 export DATABASE_NAME --remote --output .secrets/d1-backup.sql --config backends/worker/wrangler.toml
```

先建好受保护的输出目录。`.secrets/` 被 Git 忽略，但忽略不等于加密，也不等于异地备份。D1 导出里有机器凭据、通知配置等敏感数据。

PostgreSQL 用对应服务的快照或 `pg_dump`。R2 用账号支持的对象备份方式，并保持对象 key；只存数据库恢复不了已经丢失的主题文件。

Go 在数据目录的 `database.json` 里保存初始化时的显式选库结果，重启后优先用它。这个文件包含明文数据库连接地址，要和数据库凭据一起保护、一起备份；POSIX 权限为 `0600`，Windows 还要限制文件和数据目录的 ACL。程序文件可以单独分发，运行数据和主题仍要持久保存。

## 恢复

优先在新的隔离数据库和临时入口验证恢复，再切生产绑定：

1. 准备空目标数据库，确认导出文件来自正确的环境。
2. 导入备份；D1 可以用 `wrangler d1 execute` 的 `--file`。原手动部署必须显式指定 `--config backends/worker/wrangler.toml`，并核对目标账号和数据库。
3. 恢复对应的 R2 对象，并核对数据库记录里的资源前缀。
4. 恢复密钥和配置，用对应服务版本启动。
5. 验证账号、监控数量、最新历史、主题入口和 Agent 上报。
6. 再应用验证过的新迁移，最后切正式入口。

不要把一份完整结构导出反复导入已经初始化的库，也不要通过清空原库来测试恢复。D1 服务提供的恢复能力和可用时间窗口取决于账号和服务配置，要在部署时单独确认。

Fork 部署和按钮部署的 `wrangler.jsonc` 不记录 `database_id`。备份或恢复这类环境的 D1 时，先在 Cloudflare 控制台的 Worker **Settings → Bindings** 中查看 `DB` 绑定的数据库名称，再用 `npx wrangler d1 export <数据库名> --remote --output .secrets/d1-backup.sql`（恢复时用 `wrangler d1 execute <数据库名> --remote --file ...`）操作对应数据库。不要沿用手动部署的配置或数据库名。

## 切换数据库后端

首次部署在 `/setup` 选数据库：Worker 在绑定 D1 时提供 D1 和 PostgreSQL 两种选项，未绑定 D1 时只有 PostgreSQL；Go 支持 SQLite 或 PostgreSQL。选 PostgreSQL 后填写连接地址；初始化会把管理员账号和会话写进所选数据库，后续业务也用它。初始化选择只适用于还没创建管理员的环境，不能用来切换已有业务数据。

下面的步骤只适用于 Worker 的 D1 → PostgreSQL。Go 的 SQLite → PostgreSQL 必须走 [Go 离线迁移流程](../backends/go/README.md#数据库迁移)，从复制前到切换完成都要让旧服务停写；两种后端的数据结构和迁移工具不能混用。

Worker 后台迁移可以把当前 D1 的数据一次性复制到空 PostgreSQL 数据库，迁移时会初始化目标结构；也可以用已经初始化、但没有业务数据的目标库。应用不会自动切换数据库。

1. 备份 D1 和目标库。迁移期间目标库独占，不允许其他进程写入或创建对象。
2. 安排停写：暂停实际探测调度、Push/Agent 写流量和管理修改，而不是只把通知调成维护窗口。
3. 在后台设置页面填 PostgreSQL 连接地址，检查数据库并确认迁移。迁移期间和切换完成之前，源数据库必须一直停写；复制之后的写入不会自动同步。

4. 对比关键表数量、账号和历史，再把两份配置里的 `DATABASE_TYPE` 改成 `postgres`，部署正确的 `DATABASE_URL`。默认 D1 初始化不保留活动指针；如果曾从 PostgreSQL 部署显式改选 D1，还要在停写、备份并确认复制完成后，按[部署指南](deployment.md#从-d1-迁移到-postgresql)处理 D1 的活动选库记录。不要删 `pending` 记录。
5. 恢复流量，检查调度、通知和 Agent。R2 资产仍要保留。

后台迁移有数据量限制，超出时不会复制数据。保留源数据库和备份，按数据量制定并验证迁移方案后再切换。

回退时不要让两个数据库同时接收互不同步的写入。需要恢复时，依据备份和迁移后的实际写入制定切换步骤。

## 数据保留

| 类型 | 默认保留 | 后台设置 |
| --- | --- | --- |
| 可用率统计、Agent 资源日汇总 | 400 天 | `retention.availabilityDays` |
| 详细指标 | 90 天 | `retention.detailDays` |
| 状态事件 | 90 天 | `retention.eventDays` |

Worker 的 AE 明细查询最多覆盖最近 90 天，实际保留受 AE 服务限制；`retention.detailDays` 不会延长 AE 的保留期。每日归档按 `retention.availabilityDays` 保留。Worker 由每日 Cron 清理数据库；Go 在进程启动和每分钟汇总时尝试分批清理。缩短保留期不保证旧数据在保存设置的瞬间消失；调大天数也恢复不了已经清掉的数据。

通知待发送队列有独立的尝试次数和时效上限。Agent 的旧快照不会被重复扩展成新历史。展示窗口、保留期和实际覆盖率是三回事。

## 日志与用量

Worker 配置启用了 observability，可以在 Cloudflare 控制台看实际请求和任务日志。排查时记录时间、路由模式、业务错误码和资源绑定，不要输出完整 URL Token 或密钥文件。

Agent 用 `pa status`、`pa logs -f` 和安装元数据定位服务。手动模式的日志可以在终端或指定的 `log_file` 里看。

后台用量页用来观察请求和存储等信息。`USAGE_PLAN` 是手动声明的比较基准，应用不会替账号自动识别或开通计划。价格、配额和计费规则以当前账号控制台为准，容量要按实际负载评估。

## 凭据与公开信息

换了 `ADMIN_TOKEN`，相应的管理脚本也要更新；它和用户密码、Agent Token、Push Token 不是一回事。换机器或 Push 凭据时，要改被监控端的配置并检查新报告，不能只更新网页上的说明。

Worker 通过网页配置 PostgreSQL 时，用 `ADMIN_TOKEN` 派生的密钥加密 `CONFIG` KV 中的连接地址。直接换这个 Token 会让记录无法解密。轮换前保留原 Token 和数据库备份，按[配置参考](configuration.md#初始化时选择数据库)处理连接配置；不要删选库记录来尝试恢复，也不要让服务回退到空 D1。

换域名后，已安装的 Agent 仍用自己的 `endpoint`，需要逐台更新并重启。公开状态页的名称、目标路径和系统信息要按可公开内容维护，脱敏范围见[使用手册](usage.md#公开数据)。

## Operations guide

This English section summarizes the Chinese guide. Detailed migration and recovery procedures are in the linked guides, which may be in Chinese.

Before migration, recovery or domain changes, identify the account, backend, database and target environment. Keep backups and a recovery route before changing a live service.

### Scheduling

Worker runs scheduled checks every minute; the same trigger runs daily aggregation, AE archiving and retention cleanup once per day after 00:10 UTC. A monitor's own interval controls when it is due. Monitor observations and Agent resource history go to AE; live state, actual check times and status changes remain in the business database. Missing checks are not filled with healthy states or copied latency values.

Daily archiving preserves exact availability counts and supplements latency and resource statistics. Agent management details offer recent and daily views. Each run processes a bounded date batch and revisits the last two days; failed queries retain their progress for retry. History reads use the `ANALYTICS_SQL` binding included in the deployment configuration; no additional query credentials are needed.

A Worker invocation can write at most 250 AE points. When a tick exceeds that limit, history writes rotate across monitors and emit `history_write_partial`, without changing check intervals. History will have gaps. AE queries may also return sampled data, which the UI identifies; exact status, availability and alerts do not depend on AE query results.

Go runs scheduling inside its process, checks for due work each second, and attempts incremental aggregation and cleanup at startup and every minute. Stopping the process also stops scheduling. For either backend, inspect recent check times and job logs as well as HTTP health.

### Upgrade

1. Record the running service and deployment versions, backend, database, bindings and Agent versions. Back up the database, theme files, credentials and configuration.
2. Review migrations against a backup in an isolated environment. Worker D1 and PostgreSQL migrations are different from Go's own `polaris_*` tables; never run the Worker PostgreSQL migration for Go.
3. For manual Worker D1 deployments, confirm `backends/worker/wrangler.toml` and use `npm run db:init`; for Worker PostgreSQL use `npm run db:migrate:postgres`. Fork and button deployments apply D1 migrations on request; see [deployment](deployment.md#database-setup-and-initialization). Worker requests can apply outstanding D1 migrations when a migration ledger already exists, so back up and review before deploying.
4. Confirm the intended Agent release and platform downloads are accessible before upgrading Agents.
5. Deploy the intended Worker or replace the Go binary or image while preserving its data directory. Check setup, login, monitoring, notification delivery and Agent reports. Roll out Agent upgrades gradually.

Rolling back an executable or Worker version does not automatically reverse database migrations. Choose recovery using the actual schema and backup. For Go, stop the service and its restarter before backing up or replacing persistent data; see the [Go guide](../backends/go/README.md).

### Backup and restore

Back up the business database, the Worker's `CONFIG` KV namespace (console settings and the setup selection), theme files (`THEMES` R2 objects for Worker or the Go data directory), deployment configuration, required secrets and important Agent configuration. Treat exports as sensitive: they can contain tokens and notification settings. PostgreSQL also needs a database snapshot or `pg_dump`.

For a Worker PostgreSQL connection configured through setup, retain and back up the `CONFIG` KV namespace that stores the encrypted database selection. Go stores an explicit setup selection in the data directory's `database.json`; this file contains the plaintext connection URL and takes precedence on restart. Protect and back it up with the database credentials. It is created with POSIX mode `0600`; restrict Windows file and directory ACLs separately. A single executable does not replace persistent data and theme storage.

For a manually configured Worker D1, after confirming the account and target database, export to a protected directory:

```sh
npx wrangler d1 export DATABASE_NAME --remote --output .secrets/d1-backup.sql --config backends/worker/wrangler.toml
```

Fork and button deployments keep no database ID in `wrangler.jsonc`; confirm which database `DB` points to under the Worker's **Settings → Bindings** before operating on it. Restore first to a separate empty database and temporary entry point, restore matching theme files and secrets, then check accounts, monitors, history and Agent reports before switching production. A complete schema export should not be repeatedly imported into an initialized database.

### Database migration and retention

For a new installation, choose the database at `/setup`: Worker offers D1 and PostgreSQL when D1 is bound and PostgreSQL only otherwise; Go supports SQLite or PostgreSQL. Enter a connection URL for PostgreSQL, for example `postgresql://user:password@db.example.com:5432/polaris?sslmode=verify-full`. The Worker shows its deployment check first; the Go backend goes straight to the setup form. Setup creates the administrator and session in the selected database, which also serves subsequent business requests. This initial choice is not a migration path for an existing installation.

Worker can copy D1 to an empty PostgreSQL database from the settings page; copying does not switch the active database. Stop all source writes, including scheduler, Push, Agent and administrative writes, and keep them stopped through the switch. Back up both databases, keep the target exclusive, verify the copied data, then configure `DATABASE_TYPE=postgres` and `DATABASE_URL`. Default D1 setup leaves no active selection pointer. If setup explicitly selected D1 from a PostgreSQL deployment, also handle the active D1 selection as described in [deployment](deployment.md#database-setup-and-initialization); never delete a pending record. External R2 and Analytics Engine data are not copied.

Go SQLite-to-PostgreSQL uses its own [offline migration procedure](../backends/go/README.md#english); do not interchange the two backends' migration tools. Keep the source and backups until the new service is verified.

Default retention is 400 days for availability and resource daily summaries, and 90 days each for detailed metrics and events. Cleanup is scheduled, not immediate when settings change. Extending retention cannot restore data already removed.

### Credentials and logs

`ADMIN_TOKEN`, account passwords, Agent tokens and Push tokens have different purposes. Update dependent clients when rotating credentials. Agent endpoints remain in each machine's configuration after a domain change. Public names, paths and machine fields should be reviewed for disclosure.

Worker derives the encryption key for a setup-saved PostgreSQL URL from `ADMIN_TOKEN`. Replacing that token directly makes the encrypted KV record unreadable. Preserve the original token and backups, and follow the [database configuration guidance](configuration.md#english) before rotation. Do not delete the selection record or fall back to an empty D1 database as a recovery shortcut.

Inspect Worker observability logs or `pa status` and `pa logs -f` for Agent issues without logging complete secrets. `USAGE_PLAN` is a manually configured comparison baseline, not automatic plan detection.
