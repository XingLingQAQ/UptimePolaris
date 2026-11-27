# 运维指南

[English](#english)

本指南面向长期运行的生产环境，涵盖调度机制、版本升级、备份恢复、数据库迁移、数据保留与凭据轮换。变更前先确认目标账号、后端类型与数据库。

## 目录

- [调度机制](#调度机制)
- [升级流程](#升级流程)
- [备份与恢复](#备份与恢复)
- [切换数据库后端](#切换数据库后端)
- [数据保留与日志](#数据保留与日志)
- [凭据轮换与域名变更](#凭据轮换与域名变更)

## 调度机制

- **Worker**：默认每分钟 Cron（`* * * * *`）推进到期检查、Push 超时、Agent 状态与通知；UTC `00:10` 后执行每日汇总、AE 归档与清理。监控多到单次预算不足时，可开启 [Worker Queue](queue.md)。单次最多写 250 个 AE 点（超限轮换写入并记录 `history_write_partial`，不影响精确可用率）。
- **Go**：进程内每秒扫描到期任务，启动时和每分钟增量汇总与清理。进程停机即停止调度，巡检时需兼顾最近检查时间与任务日志。

## 升级流程

### Worker

1. 记录当前版本、绑定与数据库类型，备份数据库、主题资源与密钥。
2. 在隔离环境验证迁移（勿对生产库使用重置脚本；回退代码不会自动回退表结构）。
3. 手动 CLI 部署使用 D1 时执行 `npm run db:init`，使用 PostgreSQL 执行 `npm run db:migrate:postgres`；Fork 与按钮部署的 D1 由 Worker 自动应用迁移。
4. 部署新代码（`npm run deploy`、GitHub **Sync fork** 或按钮仓库合并），确认登录、监控、通知与 Agent 正常后再分批升级 Agent。

### Go

官方二进制支持控制台 **立即更新** 与 **自动更新**（每 6 小时检查，默认关闭）；Docker 见 [Go 后端说明：在后台更新](../backends/go/README.md#在后台更新)。手动升级步骤：

1. 停止 Go 后端与重启器，备份数据目录（含 SQLite、主题）与环境配置；PostgreSQL 需同步备份数据库。
2. 在隔离副本验证新版（Go 使用独立的 `polaris_*` 表，**切勿执行 Worker 的 `npm run db:migrate:postgres`**）。
3. 替换二进制或更新 Compose 标签，保留数据目录与配置；曾启用原生后台更新的部署，手动换回二进制前先重命名保留 `updates/native.json`。
4. 启动并验证登录、监控、Push、Agent 与通知后恢复入口流量。

## 备份与恢复

**备份清单**：业务数据库（D1 导出 / 停服后的 SQLite / `pg_dump`）、Worker `CONFIG` KV（`settings` 与 `database` 键）、主题（R2 `THEMES` 或 Go `themes/`）、Go `database.json`、加密密钥（Worker `ADMIN_TOKEN`；Go `ai-credential.key` 或 `POLARIS_AI_KEY_FILE`），以及重要 Agent 的 `config.json` 与 `install.json`。

Worker D1 导出示例（手动部署保留 `--config`；Fork/按钮部署先在控制台查看 `DB` 绑定的实际库名，去掉 `--config` 执行）：

```sh
npx wrangler d1 export DATABASE_NAME --remote --output .secrets/d1-backup.sql --config backends/worker/wrangler.toml
```

`.secrets/` 仅被 Git 忽略，不等于加密。恢复时先在隔离空库导入备份（勿向已初始化库重复导入全量导出），同步恢复主题与 KV、密钥和对应版本服务，验证无误再切生产入口。

## 切换数据库后端

- **Worker（D1 → PostgreSQL）**：使用后台“设置 → 迁移到 PostgreSQL”，详见[部署指南](deployment.md#从-d1-迁移到-postgresql)。
- **Go（SQLite → PostgreSQL）**：使用离线迁移命令，详见[Go 后端说明：数据库迁移](../backends/go/README.md#数据库迁移)。

两种后端的数据库结构与迁移工具互不通用。

## 数据保留与日志

- **保留默认值**：可用率与 Agent 日汇总 `400` 天（`retention.availabilityDays`）、详细指标 `90` 天（`retention.detailDays`）、状态事件 `90` 天（`retention.eventDays`）。Worker AE 明细受平台约 90 天上限约束。清理按周期异步执行，不可逆。
- **日志**：Worker 在 Cloudflare 控制台开启了 observability 日志；Agent 使用 `pa status` 与 `pa logs -f`。共享日志前务必剔除完整 Token、连接串与通知密钥。

## 凭据轮换与域名变更

- **轮换 `ADMIN_TOKEN`**：如果曾通过 Worker `/setup` 保存 PostgreSQL 连接，系统用 `ADMIN_TOKEN` 派生密钥加密该连接；**直接替换会导致无法解密**，轮换前先备份并按[配置参考](configuration.md#worker-绑定与环境变量)准备恢复方案。
- **更换站点域名**：已安装的 Agent 不会自动切换地址，须逐台更新 `config.json` 中的 `endpoint` 并重启服务。

## English

Production operations guide covering scheduling, upgrades, backups, restores, database migration, retention, and credential rotation. Verify your target account, backend, and database before making changes.

### Scheduling

- **Worker**: minute Cron (`* * * * *`) runs due checks, Push timeouts, Agent state, and notifications, plus daily rollups, AE archiving, and pruning after `00:10` UTC. Use [Worker Queue](queue.md#english) when checks exceed single-invocation budgets. AE writes cap at 250 points per tick (`history_write_partial` rotates overflow without affecting exact availability).
- **Go**: in-process 1-second loop for checks and minute/startup leases for rollups and pruning. Stopping the process halts scheduling.

### Upgrade

#### Worker

1. Record versions, bindings, and DB type; back up database, themes, KV, and secrets.
2. Test migrations in isolation (never run reset scripts on production; rolling back code does not revert schema changes).
3. Manual CLI deploys: run `npm run db:init` (D1) or `npm run db:migrate:postgres` (PostgreSQL). Fork/button D1 deployments auto-migrate on request.
4. Deploy code, verify login/checks/notifications/Agents, then upgrade Agents gradually.

#### Go

Official binaries support console **Update now** and opt-in auto-updates (6-hour cadence); Docker uses the updater container ([Go backend guide](../backends/go/README.md#updates-from-the-console)). For manual upgrades: stop Go and restarters, back up data dir and database, verify on a copy (**never run Worker's `npm run db:migrate:postgres`**), replace binary/image while keeping data dir (rename `updates/native.json` when manually replacing a managed native binary), verify, and resume traffic.

### Backup and restore

Back up together: database (D1 export, stopped SQLite, or `pg_dump`), Worker `CONFIG` KV, themes (R2 `THEMES` or Go `themes/`), Go `database.json`, encryption keys (`ADMIN_TOKEN` or `ai-credential.key` / `POLARIS_AI_KEY_FILE`), and critical Agent `config.json` / `install.json`.

```sh
npx wrangler d1 export DATABASE_NAME --remote --output .secrets/d1-backup.sql --config backends/worker/wrangler.toml
```

(Omit `--config` for fork/button deployments after checking the bound `DB` name in Cloudflare.) Test restores into an empty isolated database before cutting over.

### Database migration, retention, and rotation

- **D1 → PostgreSQL (Worker)**: see [Deployment](deployment.md#migrate-from-d1-to-postgresql). **SQLite → PostgreSQL (Go)**: see [Go backend guide](../backends/go/README.md#english).
- **Retention defaults**: 400 days availability (`retention.availabilityDays`), 90 days details (`retention.detailDays`) and events (`retention.eventDays`). Worker AE details cap around 90 days.
- **Rotation & domains**: rotating `ADMIN_TOKEN` directly breaks setup-encrypted PostgreSQL records in `CONFIG` KV—back up first. After changing site domains, update `endpoint` in each Agent's `config.json` and restart. Always redact secrets from shared logs.
