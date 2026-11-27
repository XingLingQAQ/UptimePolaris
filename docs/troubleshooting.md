# 常见问题排查

[English](#english)

排查前先确认访问的完整 URL、当前后端（Worker 或 Go）以及目标数据库，避免混淆环境。

## 目录

- [初始化无法继续](#初始化无法继续)
- [忘记管理密码](#忘记管理密码)
- [没有监控数据或 Push 异常](#没有监控数据或-push-异常)
- [Agent 离线、缺指标或命令异常](#agent-离线缺指标或命令异常)
- [安装脚本下载失败或换域名后停报](#安装脚本下载失败或换域名后停报)
- [通知未发送、语言错误或主题异常](#通知未发送语言错误或主题异常)
- [提交排查信息](#提交排查信息)

## 初始化无法继续

- **Worker 依赖未通过**：在 Cloudflare 控制台补齐 `CONFIG` KV、`UPTIME` Analytics Engine 和 `ADMIN_TOKEN` Secret 后保存部署，回到 `/setup` 点击“重新检查”。`DB`（D1）和 `THEMES`（R2）不阻断初始化。
- **Go 缺少初始化密钥**：检查 `.env` 或环境变量 `POLARIS_SETUP_KEY`（回退 `POLARIS_ADMIN_TOKEN`）；两者均未设置时查看最新一次启动日志的 `setup_key` 字段（重启会刷新自动密钥）。
- **KV 同步延迟**：Worker 第二步点击“验证并继续”提示同步中时，保持页面打开约 1 分钟后重试即可。
- **初始化中断**：若数据库选项已锁定，使用原管理员用户名和密码继续提交；持有租约的进程崩溃最多 10 分钟后自动释放。

常见错误码：`deployment_incomplete`（缺 `UPTIME` 绑定）、`invalid_database_url`（核对 PostgreSQL URL 与密码 URL 编码）、`database_connection_failed`（检查网络/防火墙/TLS）、`database_initialization_failed`（检查建表权限与冲突表，切勿清空数据盲试）、`database_configuration_failed`（检查 KV 与 `ADMIN_TOKEN`，见[配置参考](configuration.md)）。

## 忘记管理密码

- **Worker D1**：先备份数据库，再通过命令行重置（Fork/按钮部署需先在本地配置临时填入 `database_id`；勿在共享终端暴露明文密码）：

```sh
npm run user:list -- --remote
npm run user:create -- --remote --username your-name --password 'a-new-strong-password'
```

- **Worker PostgreSQL / Go**：当前无密码重置命令（`POLARIS_ADMIN_TOKEN` 仅用于 API，不能代替登录密码）。请先保留数据库备份并确认其他可用管理员账号。

## 没有监控数据或 Push 异常

- **主动监控无数据**：确认站点 URL、监控已启用、目标与检查来源正确，检查 Worker Cron 或 Go 进程运行日志。图表仅展示监控创建后的数据。
- **Push 地址能打开但无数据**：浏览器访问发出的是 `GET`（固定返回 `405`）。请改用 `POST` 携带 `Authorization: Bearer <PUSH_TOKEN>` 与 `Content-Type: application/json`，确认返回 `200 {"ok":true}`；频繁超时请核对任务周期与主机时钟。

## Agent 离线、缺指标或命令异常

在目标主机依次执行 `pa status`、`pa logs -n 200` 和 `pa command status`：

- **离线或反复波动**：确认 `config.json` 中 `endpoint` 可达、`token` 与控制台匹配（无多实例共用或环境变量覆盖）、代理/防火墙放行 WebSocket，且间隔满足 `1 <= sample_interval <= report_interval <= 1800`（默认 60 秒上报约 180 秒超时）。
- **缺少历史图表（Worker）**：确认绑定了 `UPTIME` 并用包含 `analytics` 的最新配置重部署以提供 `ANALYTICS_SQL`（自定义数据集须同步配置 `UPTIME_DATASET`，切勿新建空数据集）。
- **指标显示 `—` 或负载偏差**：先确认网卡/挂载点过滤规则与系统权限（不可采集显示 `—`，不会补 `0`；Windows 负载为处理器队列长度，并非 CPU %）。
- **找不到 `pa`**：重开终端刷新 `PATH`，或使用安装路径下的二进制执行 `polaris-agent command register --scope user --config /path/to/config.json`。
- **远程指令被拒或排队**：确认后台开启了 **允许远程 Agent 指令**、机器在线并支持对应能力；`restart` 与 `upgrade` 仅限托管安装（Docker 需重建容器；Windows 更新失败日志在程序旁 `polaris-agent.update.log`）。

## 安装脚本下载失败或换域名后停报

- **下载返回 HTML 或校验失败**：确认目标主机能直连 `raw.githubusercontent.com` 与 GitHub Releases（未被代理拦截到登录页），并重新从控制台复制完整命令。
- **换域名后停报**：修改每台主机 `config.json` 中的 `endpoint` 并重启 Agent，确认新域名反代保留 `Host` 且放行 WebSocket。

## 通知未发送、语言错误或主题异常

- **测试成功但实际故障不发**：核对渠道启用状态、分组范围（注意删分组导致空范围的规则变化）、维护窗口、`AUTOMATIC_NOTIFICATIONS_DISABLED`（Worker）以及是否满足重试阈值/Agent 持续时间。
- **通知语言不对**：在对应渠道编辑页单独保存语言（API 更新 `config` 须带完整字段，省略 `language` 默认 `en-US`）。
- **页面显示原始语言键**：确认前端静态资源与后端版本一致并刷新浏览器缓存。
- **主题安装或预览失败**：检查 R2 `THEMES` 或 Go `themes/` 写权限，核对根目录 `polaris-theme.json`（≤500 个文件、解压 ≤32 MiB）。预览受隔离窗口限制，应用后在无痕窗口验证。

## 提交排查信息

整理完整 URL、UTC 时间、监控类型与来源、最后成功时间、HTTP 状态与业务错误码。**共享日志前务必删除 `ADMIN_TOKEN`、Agent Token、Push Token、通知凭据和数据库连接串。**

## English

Confirm your exact URL, active backend (Worker or Go), and target database before troubleshooting.

### Setup and passwords

- **Worker checks fail**: bind `CONFIG` KV, `UPTIME` Analytics Engine (enable AE first), and `ADMIN_TOKEN`, redeploy, and click **Re-check**. Wait ~1 minute and click **Verify and continue** again if KV propagation is still syncing. Crashed setup leases expire in at most 10 minutes.
- **Go missing setup key**: check `POLARIS_SETUP_KEY` (`POLARIS_ADMIN_TOKEN` fallback) or read `setup_key` from the latest startup log.
- **Forgot password**: Worker D1 can reset via `npm run user:list -- --remote` and `npm run user:create -- --remote --username ... --password '...'` (back up first; fork/button repos must temporarily set local `database_id`). Worker PostgreSQL and Go have no password-reset CLI (`POLARIS_ADMIN_TOKEN` is an API token only).

### Monitors, Push, and Agents

- **No monitor data**: confirm monitor enabled state, target, check source, and Cron/Go scheduler logs.
- **Push URL loads with no data**: browsers send `GET` (`405`). Send `POST` with `Authorization: Bearer <PUSH_TOKEN>` and `Content-Type: application/json`, checking for `200 {"ok":true}`.
- **Agent offline or missing data**: inspect `pa status`, `pa logs -n 200`, and `pa command status`. Verify `endpoint`, unique `token`, WebSocket/proxy rules, and `1 <= sample_interval <= report_interval <= 1800`. Unavailable metrics show `—` (never `0`). If Worker reports missing history bindings, keep `UPTIME` and redeploy with `analytics` (`ANALYTICS_SQL`).
- **`pa` missing or remote command rejected**: reopen shell or run `polaris-agent command register --scope user --config ...`; verify `Allow remote Agent commands` and supervised `service_tier: A` (`restart`/`upgrade` fail on manual/Docker installs; check `polaris-agent.update.log` on Windows).
- **Installer HTML / domain change**: confirm direct host access to `raw.githubusercontent.com` and GitHub Releases; after changing site domains, update `endpoint` in each Agent's `config.json` and restart.

### Notifications, UI, and themes

- **Missing alerts**: verify channel state, group scope, maintenance windows, `AUTOMATIC_NOTIFICATIONS_DISABLED` (Worker), and retry/duration thresholds. Edit channel languages per channel (API updates replace the whole `config` object).
- **Raw translation keys**: ensure frontend and backend come from the same build and hard-refresh.
- **Theme errors**: check `THEMES` R2 / Go `themes/` permissions and root `polaris-theme.json` (≤500 files, ≤32 MiB unpacked); verify applied themes while signed out.

Always redact `ADMIN_TOKEN`, Agent tokens, Push tokens, notification credentials, and database URLs before sharing logs.
