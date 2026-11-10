# Agent 手册

[English](#agent-guide)

`polaris-agent` 负责采集主机数据，`pa` 是它的短命令。两者操作同一套程序、配置和服务，`pa` 不会另外启动一个实例。

安装和更新都使用最新稳定版，并校验下载文件的完整性。GitHub 访问不了或被 API 限流时，恢复网络后再重试。

## 目录

- [安装](#安装)
- [安装模式与平台](#安装模式与平台)
- [日常管理](#日常管理)
- [全局命令注册](#全局命令注册)
- [本地配置](#本地配置)
- [远程配置与指令](#远程配置与指令)
- [更新与回滚](#更新与回滚)
- [卸载](#卸载)
- [数据与连接](#数据与连接)

## 安装

1. 登录控制台的 Agent 页面，创建机器条目。
2. 选择平台、安装模式、采样与上报间隔。
3. 保持“注册全局命令”启用，复制生成的短安装命令。
4. 在目标机器上，用对应权限的终端执行。
5. 运行 `pa status`，回到控制台确认首次上报。

添加 Agent 只是在控制台登记机器，不会自动创建监控。要监控在线状态和资源告警，到监控页面新增 Agent 类型并选择这台机器；HTTP/TCP 监控也可单独把它选为检查来源。删除关联监控不会删除机器、凭据或采样历史。

机器公开页默认关闭，新登记的机器只在后台可见。先在展示设置里启用机器页，再在 Agent 管理里逐台或批量设置公开显示。关闭机器页后，所有 Agent 公开控制隐藏，已有选择保留，连接、上报和探测任务不受影响。机器公开状态和 Agent 类型监控的公开状态是两回事。域名配置见[公开页面与域名](usage.md#公开页面与域名)。

启用机器页后，可管理独立的 Agent 分组和标签，并在机器编辑界面里分配。同名的 Agent 分组和监控分组合并显示为通用分组，可统一编辑，也可只删一侧。点击卡片可查看和调整两类成员。监控通知范围不受 Agent 分组影响。

Agent 探测支持 HTTP、TCP、SSL、域名到期和 DNS。SSL 每个 UTC 日通过真实握手读取目标证书，并验证信任链和主机名；到期或验证失败会显示警告。DNS 支持 A、AAAA、CNAME、MX、TXT、NS 和期望值匹配。域名到期从域名注册服务查询；没有公开到期日时显示未知。附加检查和主检查并行，主检查延迟不包含附加检查的等待时间。

页面只展示短安装命令。脚本地址和服务地址由当前访问的 origin 生成，协议、域名和端口都会保留，所以请在正式域名下取命令。

Linux / macOS 的默认系统安装形式：

```sh
(installer=$(curl -fsSL 'https://status.example.com/install.sh') && POLARIS_AGENT_TOKEN='TOKEN' sh -c "$installer" -- --mode 'system')
```

Windows PowerShell 的默认形式：

```powershell
& ([scriptblock]::Create((irm 'https://status.example.com/install.ps1' -ErrorAction Stop))) 'TOKEN' -mode 'system'
```

把站点和 Token 换成控制台给出的实际值。安装命令先完整下载脚本，再执行；Token 不会放进脚本下载 URL。Windows 引导脚本会暂存执行脚本，结束后清理临时文件并恢复凭据环境变量。

安装命令含机器凭据，会留在终端历史或复制记录里。不要把它发到公共讨论或截图。每台机器用独立 Token。下载失败时，先确认所选平台有没有可用版本，见[部署指南](deployment.md#agent-下载)。

## 安装模式与平台

| 模式 | 适用范围 | 行为 |
| --- | --- | --- |
| `system` | Linux、macOS、Windows | 系统级安装，通常需要管理员权限 |
| `user` | 支持的平台与服务管理器 | 当前用户安装，随用户环境的服务机制运行 |
| `manual` | Linux、macOS、Windows | 准备程序和配置，按安装输出前台运行 |
| `docker` | Linux | 生成并启动 Docker Compose 部署，更新通过重建容器完成 |

Linux 会按环境使用 systemd、OpenRC、supervisord、s6 等机制；没有守护进程时，可能退到启动任务或手动模式。用户模式的 POSIX 服务安装目前要求 Linux 的 `systemd --user`；macOS 的用户模式和 Linux 不同，不能照搬。

macOS 系统模式用 launchd；Windows 系统模式和用户模式用计划任务。Windows 系统模式要在管理员 PowerShell 里执行。

默认 POSIX 系统程序目录是 `/usr/local/lib/polaris-agent`，用户程序目录是 `~/.local/lib/polaris-agent`；配置位置随模式变化。Windows 使用安装器确定的 ProgramData 或 LocalAppData 目录。自定义了安装目录或服务名时，以安装输出和旁边的 `install.json` 为准。

Docker 需要 Docker Compose v2。容器里的进程默认只看到容器提供的系统视图；能观察到多少宿主机资源，取决于实际挂载和权限。不要把默认容器视图当成完整的主机指标。

## 日常管理

```sh
pa status
pa start
pa stop
pa restart
pa logs
pa logs -f
pa logs -n 200
```

| 命令 | 作用 |
| --- | --- |
| `status` | 查询当前安装对应的服务状态 |
| `start` / `stop` / `restart` | 调用实际服务管理器 |
| `logs` | 读取日志，默认最后 50 行 |
| `logs -f` | 持续查看新日志，Ctrl+C 结束 |
| `logs -n N` | 指定行数，1–10000 |

系统安装的操作可能需要管理员权限，例如 `sudo pa restart`。结构化子命令同样可用，例如 `polaris-agent service status`。手动运行或只有开机任务的安装不一定支持服务启停，命令会报告实际能力；没有日志文件时，日志命令也读不到内容。

只看将要调用的服务操作：

```sh
pa restart --dry-run
```

前台运行：

```sh
polaris-agent run --config /path/to/config.json
```

已有服务在运行时，不要再启动第二个前台实例。没有子命令时显示帮助，不会自动开始采集。

## 全局命令注册

安装器默认同时注册 `pa` 和 `polaris-agent`。终端识别不到命令时，先重新打开终端，再看安装输出里的注册目录。

要从实际二进制路径恢复或检查注册：

```sh
/path/to/polaris-agent command status --config /path/to/config.json
/path/to/polaris-agent command register --scope user --config /path/to/config.json
```

可用选项：

| 选项 | 作用 |
| --- | --- |
| `--scope user` / `--scope system` | 注册到用户或系统范围 |
| `--directory PATH` | 指定包装器目录 |
| `--no-path` | 只生成包装器，不改 PATH 或 Shell profile |
| `--dry-run` | 查看注册或移除动作 |

`command unregister` 只移除这次安装登记的命令和路径修改，不等于卸载 Agent。注册器会检查文件归属，遇到其他程序占用 `pa` 或目标命令时拒绝覆盖。包装器只保存程序和配置路径，不包含机器 Token。安装元数据 `install.json` 和配置放在一起，管理和卸载都要用到，不要删除。

## 本地配置

配置优先级：**CLI 参数 > `POLARIS_AGENT_*` 环境变量 > JSON 配置文件**。用全局包装器时，会绑定这次安装的配置位置；自己前台运行时，建议显式加 `--config`。

```json
{
  "endpoint": "https://status.example.com",
  "token": "replace-with-machine-token",
  "sample_interval": 5,
  "report_interval": 60,
  "include_nics": [],
  "exclude_nics": ["lo"],
  "include_mounts": [],
  "exclude_mounts": [],
  "auto_update": false,
  "insecure": false
}
```

| JSON 字段 | 默认或用途 | CLI / 环境变量 |
| --- | --- | --- |
| `endpoint` | 站点 origin 或 Agent 端点，必需 | `--endpoint` / `POLARIS_AGENT_ENDPOINT` |
| `token` | 每台机器的凭据，必需 | `--token` / `POLARIS_AGENT_TOKEN` |
| `sample_interval` | 默认 5 秒 | `--sample-interval` / `POLARIS_AGENT_SAMPLE_INTERVAL` |
| `report_interval` | 默认 60 秒 | `--report-interval` / `POLARIS_AGENT_REPORT_INTERVAL` |
| `include_nics` / `exclude_nics` | 网卡过滤列表 | 对应连字符参数 / `POLARIS_AGENT_INCLUDE_NICS`、`POLARIS_AGENT_EXCLUDE_NICS` |
| `include_mounts` / `exclude_mounts` | 挂载点过滤列表 | 对应连字符参数 / `POLARIS_AGENT_INCLUDE_MOUNTS`、`POLARIS_AGENT_EXCLUDE_MOUNTS` |
| `auto_update` | 默认关闭，需要具备自动重启能力的托管安装 | `--auto-update=true` / `POLARIS_AGENT_AUTO_UPDATE` |
| `insecure` | 默认 false，跳过上报和控制连接的证书校验；不影响独立目标探测客户端，只用于受控排查 | `--insecure=true` / `POLARIS_AGENT_INSECURE` |
| `log_file` | 可选日志文件路径 | `--log-file` |

采样和上报间隔必须满足 `1 <= sample_interval <= report_interval <= 1800`，单位秒。JSON 里的过滤值用数组，CLI 和环境变量用逗号分隔。不要填旧格式字段；未知字段会被拒绝。

`POLARIS_AGENT_CONFIG` 或 `--config` 用于指定文件路径。安装过程还会管理 `service_tier`、`runtime_revision` 等元数据，这些字段要保留，不要靠手改服务等级绕过能力检查。

## 远程配置与指令

编辑运行配置时，如果其他管理员先保存了新版本，控制台会保留你的草稿并提示冲突。选“加载最新配置”会丢掉当前运行配置草稿；重新检查、修改后再保存。其他已经保存成功的项目不会回滚。

后台设置 `security.allowAgentCommands` 默认关闭。启用后，远程配置要求 Agent 先上报受支持的配置；下发指令还要求 Agent 在线并声明相应能力。

可同步的运行配置只有七项：`sample_interval_secs`、`report_interval_secs`、`include_nics`、`exclude_nics`、`include_mounts`、`exclude_mounts`、`auto_update`。接口用 `_secs` 名称，本地 JSON 用 `sample_interval` 和 `report_interval`，不要把两套名字混写。

CLI 参数和环境变量的显式覆盖，在远程修改时仍然优先。远程版本和这些值冲突时，Agent 会拒绝整个版本，保留原运行配置和文件，并回报冲突字段。先改服务的启动参数或环境并重启，再重新检查远程配置。后台显示“已保存”不等于机器“已应用”；只有运行配置实际提交并确认后，才会显示同步完成。

四组过滤列表按大小写敏感的成员比较；重排或去重不改变过滤范围，也不会阻止其他运行参数同步。

保存运行配置时，请求要带完整 `config` 和读到的 `expected_revision`。每个过滤列表最多 32 项，每项最多 256 字符，不能包含控制字符。`agent_config_conflict` 表示版本已经变化，要重新读取并合并；`agent_config_unsupported` 表示机器还没上报可同步配置；`commands_disabled` 表示远程功能没开。

| 动作 | 用途 |
| --- | --- |
| `re_report` | 请求尽快重新上报 |
| `check_update` | 检查可用版本 |
| `restart` | 在具备退出后重启能力的服务管理器下重启 |
| `upgrade` | 下载并应用受支持的升级 |

指令入队只代表服务端接受了任务，还要看执行记录和回执。这里没有任意 Shell 命令执行功能。`restart` 和 `upgrade` 只允许在 Agent 确认为 `service_tier: A` 的托管环境执行；手动运行等环境会拒绝这类可能导致机器永久停报的动作。

## 更新与回滚

```sh
pa update
pa rollback
```

更新会下载稳定版并校验文件完整性。Linux、macOS 和 Windows 的托管安装可在控制台主动开启自动更新，默认关闭。检查在成功上报后执行，每天最多一次。更新后看 `pa status`、日志，以及控制台里的版本和最新报告时间。

更新下载使用固定的 GitHub HTTPS 地址，和 `endpoint` 用 HTTP 还是 HTTPS 无关。机器必须能访问 GitHub API 和 Release 资产；自动更新还要求托管安装具备安全重启条件。

Windows 托管安装会先校验新程序，等当前进程退出后替换程序，再启动原来的计划任务。启动失败会尝试恢复原程序并重新启动，错误写进程序旁的更新日志。手动执行 `pa update` 时仍按输出暂存文件，供停止任务后自行替换。Docker 不支持就地升级，要用对应镜像或安装器生成的构建目录重建并替换容器。

自动更新开关不可用时，看开关下方的原因。启用远程指令只授予配置权限，还需要 Agent 自己声明能安全更新。已有的 Windows 安装要先通过控制台的重新安装命令，拿到支持这套流程的 Agent。

回滚依赖本机保留的上一份可用二进制；没有备份就回滚不了。它不回滚服务端数据库、机器配置或监控历史。

POSIX 安装脚本重新安装时，会在替换配置和程序前保存私有恢复记录。安装中断时，先停止已有 Agent 服务，再用原来的权限、服务名、目录和模式重新运行安装脚本；脚本会在下载前恢复未完成的交接。同一个程序目录的活动安装互斥，有未完成事务时卸载会先拒绝。提示备份缺失时，保留事务目录并检查，不要删掉恢复记录后强推。

脚本提示遗留锁时，先确认没有安装器还在运行，再按提示处理空 gate 或失效 PID 锁。锁是保护并发安装用的，不是普通缓存，不能随手删。

`run`、`update` 和 `rollback` 不支持 `--dry-run`，不要把它当成所有命令通用的安全开关。

## 卸载

卸载由安装脚本执行，没有 `pa uninstall` 子命令。先下载当前站点的脚本，再传卸载选项：

```sh
curl -fsSL 'https://status.example.com/install.sh' -o install.sh
sh install.sh --uninstall
```

Windows 下载实际执行的脚本：

```powershell
Invoke-WebRequest 'https://status.example.com/api/public/agent/download/install.ps1' -OutFile install.ps1
& ./install.ps1 -Uninstall
```

权限、模式、服务名和安装目录要和安装时一致；自定义安装要传回对应选项。卸载器按安装归属检查服务、程序、注册命令和配置。卸载主机程序不会删除控制台的监控条目，后台删除条目也不会远程卸载机器程序。

## 数据与连接

Agent 在连接中断或切换传输方式时继续采样，并重试尚未确认的报告。服务端确认报告后，Agent 才移除对应的待发送数据；重复收到的分钟摘要按时间桶去重。停机或自动更新前，Agent 会在有限时间内尽量发送已完成的摘要和最新快照。

服务端用自己的时钟判断报告时间。超过 24 小时的报告会被确认并忽略，不会阻塞后续报告。报告时间超前服务端超过 5 分钟时，服务端要求 Agent 暂缓这条报告；后续有效报告仍可发送。暂缓的报告会继续重试，直到时间进入服务端允许的范围。单个报告里的过期摘要会被跳过，仍在有效期内的摘要仍可保存。

待发送快照和分钟摘要只存在内存里。采样缓冲最多 4096 条，待发送快照最多 60 帧，其中暂缓的未来帧最多占 30 帧，已完成的分钟摘要最多 128 桶。缓冲区满时，Agent 会记录告警，并可能丢弃数据。异常退出会丢失内存里尚未确认的数据；正常退出时网络不可用或发送超时，也可能丢数据。当前还没走完的分钟不会当作完整分钟补报。

Agent 优先走站点支持的连接方式，受限网络下改用相应的 HTTP 路径。代理需要放行 Agent API 和 WebSocket，机器要能解析并访问站点域名。

Agent 启动时通过真实网卡出口发现公网 IP，再按这个 IP 查询国家、地区和 ISP。IP 采集不走 HTTP 环境代理；遇到 Fake-IP 时，重新解析查询服务的真实地址。Windows 会排除 Clash、Mihomo、Tailscale 等隧道网卡，使用以太网或无线网卡。

上报连接仍然使用原有代理。服务端只保存 Agent 自报的网络信息，不再用上报连接的来源 IP 或地区补全机器身份。无法确认真实出口或查询失败时保留未知。更新 Agent 后重启一次，重新采集地区信息。

在线超时按报告间隔的三倍计算，下限 30 秒，上限 3600 秒。默认 60 秒上报时，超过约 180 秒没有报告会进入失联判断。离线不会生成新的主机指标。

网卡和挂载点数据受操作系统能力、权限和过滤规则影响。先确认过滤配置，再看系统实际能读到什么。排查顺序见[常见问题](troubleshooting.md#agent-没有数据或反复离线)。

## Agent guide

`polaris-agent` collects host metrics for Uptime Polaris. `pa` is its short command; both operate the same installation and configuration, and `pa` does not create a second Agent.

### Install and manage

1. Create a machine in the Agent console, select the platform, mode and intervals, and copy the generated command from the production origin.
2. Run it with the permissions required by that mode. Each machine has its own token; keep installation commands and configuration private.
3. Run `pa status` and confirm the first report in the console. Create a separate Agent-type monitor if online status and resource alerts are needed.

System mode is available on Linux, macOS and Windows. User mode depends on the platform's service manager; POSIX user services currently require Linux `systemd --user`. Manual mode prepares files for foreground operation. Linux Docker mode uses Compose; its default system view is the container view unless host resources are explicitly mounted and permitted.

Use `pa start`, `pa stop`, `pa restart`, `pa status`, `pa logs`, `pa logs -f` or `pa logs -n 200` for supported installations. System services may require administrator privileges. `pa restart --dry-run` previews a service operation; `run`, `update` and `rollback` do not support that flag. `polaris-agent run --config /path/to/config.json` runs in the foreground; do not start a second instance alongside an existing service.

The installer normally registers `pa` and `polaris-agent`. `polaris-agent command status`, `command register` and `command unregister` manage the wrappers. Registration refuses to overwrite files owned by another program. Keep `install.json` with the configuration for management and uninstall.

### Configuration and remote commands

Configuration precedence is CLI flags, then `POLARIS_AGENT_*` environment variables, then JSON. `endpoint` and the per-machine `token` are required. Local interval fields are `sample_interval` and `report_interval`, in seconds; `1 <= sample_interval <= report_interval <= 1800`. Filters use `include_nics`, `exclude_nics`, `include_mounts` and `exclude_mounts`. `auto_update` defaults to false. `insecure` disables certificate verification for reporting and control connections, not the separate probe-target client, and is intended only for controlled diagnosis. Keep the installer-managed `service_tier` and `runtime_revision` metadata.

`security.allowAgentCommands` is off by default. Remote configuration has seven fields: `sample_interval_secs`, `report_interval_secs`, the four filter lists and `auto_update`. Submit the complete configuration with the current `expected_revision`; each filter has at most 32 entries of at most 256 characters without control characters. Reload and merge after `agent_config_conflict`. A saved desired revision is not proof of application: wait for a matching Agent report. Explicit CLI or environment overrides take precedence and can cause the Agent to reject the entire remote version.

Supported actions are `re_report`, `check_update`, `restart` and `upgrade`. The Agent must be online and advertise command support. Restart and upgrade require a supervised `service_tier: A` installation. Queued commands are not confirmation of execution; inspect the command record and receipt. Arbitrary shell execution is not supported.

### Update, rollback and uninstall

`pa update` downloads a stable release and verifies file integrity. Downloads use fixed GitHub HTTPS addresses independently of the site's `endpoint` scheme. The machine needs access to the GitHub API and release assets. Managed Linux, macOS and Windows installations can opt into automatic updates, which are checked after a successful report at most once a day. Check the service, logs, reported version and latest report after updating. Docker installations update by rebuilding and replacing the container.

`pa rollback` requires the previous binary on the machine; it does not revert server data or configuration. A Windows managed update attempts to restore the previous binary if restarting the scheduled task fails. POSIX reinstallers keep private recovery records; after an interruption, stop the service and rerun the installer with the original privileges, mode, service name and directory. Preserve the transaction directory if a backup is missing.

Uninstall uses the site's installer, not `pa uninstall`. Download `/install.sh` and run it with `--uninstall`, or download `/api/public/agent/download/install.ps1` and run it with `-Uninstall`. Use the original installation scope, service name and directory. Removing the host program does not delete console monitors; deleting a console entry does not uninstall the host program.

### Data and connectivity

The Agent keeps sampling during connection interruptions and retries unacknowledged reports. Pending snapshots and minute summaries are held in memory, so an abnormal exit or an unsuccessful shutdown flush can lose them. Reports older than 24 hours are acknowledged and ignored; reports more than 5 minutes ahead are deferred until their timestamps fall within the accepted window. The server deduplicates repeated minute summaries by time bucket.

Allow the Agent API and WebSocket through the network path. Online timeout is three times the report interval, bounded to 30–3600 seconds. Public network identity is reported by the Agent; failed discovery remains unknown rather than being inferred from the reporting connection. Interface and mount metrics depend on OS support, permissions and filters. See [troubleshooting](troubleshooting.md#missing-checks-or-agent-data) for missing or intermittent reports.
