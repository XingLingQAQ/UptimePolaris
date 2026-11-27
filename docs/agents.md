# Agent 手册

[English](#english)

`polaris-agent` 是 Uptime Polaris 的主机探针，日常短命令为 `pa`，两者操作同一套程序、配置与服务。

## 目录

- [安装与首次上报](#安装与首次上报)
- [安装模式](#安装模式)
- [服务管理](#服务管理)
- [全局命令修复](#全局命令修复)
- [本地配置](#本地配置)
- [远程配置与指令](#远程配置与指令)
- [更新、回滚与卸载](#更新回滚与卸载)
- [指标与连通说明](#指标与连通说明)

## 安装与首次上报

1. 在后台 **设置 → 展示设置** 开启机器展示页（如未开启），进入 **Agent 管理** 新建机器。
2. 在正式访问域名下复制对应平台的安装命令并在目标机器执行（系统级安装需管理员权限）。
3. 运行 `pa status` 确认状态，回到控制台查看首次上报。

**提示**：在控制台登记机器后，还需在监控页面新建 **Agent 主机** 监控才会统计在线率与触发资源告警，或在 HTTP/TCP/UDP/ICMP 监控中将其选为“检查来源”。删除监控不会删除机器与历史采样。

Linux / macOS 系统安装示例：

```sh
curl -fsSL 'https://raw.githubusercontent.com/XingLingQAQ/Polaris-Agent/main/install.sh' | sh -s -- --endpoint 'https://status.example.com' --token 'TOKEN' --mode 'system'
```

Windows PowerShell 示例：

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/XingLingQAQ/Polaris-Agent/main/install.ps1'))) -Endpoint 'https://status.example.com' -Token 'TOKEN'
```

目标机器需能访问 `raw.githubusercontent.com` 和 GitHub Releases（自动/手动更新另需访问 GitHub API）。每台机器使用独立 Token；安装命令含凭据，切勿公开分享或截图。

## 安装模式

| 模式 | 适用平台 | 说明 |
| --- | --- | --- |
| `system` | Linux、macOS、Windows | 系统级服务（systemd/OpenRC/launchd/管理员计划任务） |
| `user` | Linux、macOS、Windows | 当前用户服务（Linux 需 `systemd --user`；macOS 注销后停止） |
| `manual` | Linux、macOS、Windows | 仅准备程序与配置，手动前台运行 |
| `docker` | Linux（Compose v2） | 生成并启动 Compose 容器（默认仅采集容器资源视图） |

默认安装目录：POSIX `system` 为 `/usr/local/lib/polaris-agent`，`user` 为 `~/.local/lib/polaris-agent`，Windows 位于 ProgramData 或 LocalAppData。请勿删除配置同目录的 `install.json`。

## 服务管理

```sh
pa status            # 查看服务状态
pa start             # 启动服务
pa stop              # 停止服务
pa restart           # 重启服务（支持 --dry-run 预览）
pa logs              # 查看最后 50 行日志
pa logs -f           # 实时跟踪日志
pa logs -n 200       # 查看指定行数（1–10000）
```

系统级安装可能需要管理员权限（如 `sudo pa restart`）。手动模式无服务管理器时使用前台启动（勿在服务运行中重复启动）：

```sh
polaris-agent run --config /path/to/config.json
```

## 全局命令修复

若终端提示找不到 `pa`，先重开终端刷新 `PATH`；仍不可用时用安装路径下的二进制检查或重注册：

```sh
/path/to/polaris-agent command status --config /path/to/config.json
/path/to/polaris-agent command register --scope user --config /path/to/config.json
```

可用参数：`--scope user|system`、`--directory PATH`、`--no-path`、`--dry-run`。`command unregister` 仅移除命令包装器，不会卸载 Agent。

## 本地配置

配置优先级：**CLI 参数 > `POLARIS_AGENT_*` 环境变量 > JSON 配置文件**。

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

| 字段 | 默认值 / 用途 | CLI / 环境变量 |
| --- | --- | --- |
| `endpoint` | 站点 origin 或 Agent 端点（必填） | `--endpoint` / `POLARIS_AGENT_ENDPOINT` |
| `token` | 机器凭据（必填） | `--token` / `POLARIS_AGENT_TOKEN` |
| `sample_interval` | `5` 秒 | `--sample-interval` / `POLARIS_AGENT_SAMPLE_INTERVAL` |
| `report_interval` | `60` 秒（未显式指定时自适应：Go 按采样实时上报，Worker 60 秒） | `--report-interval` / `POLARIS_AGENT_REPORT_INTERVAL` |
| `include_nics` / `exclude_nics` | 网卡过滤（JSON 数组；CLI/环境逗号分隔） | `--include-nics` 等 / `POLARIS_AGENT_*` |
| `include_mounts` / `exclude_mounts` | 挂载点过滤 | `--include-mounts` 等 / `POLARIS_AGENT_*` |
| `auto_update` | `false`（托管安装可用） | `--auto-update=true` / `POLARIS_AGENT_AUTO_UPDATE` |
| `insecure` | `false`（跳过上报与控制连接证书校验，仅限排查） | `--insecure=true` / `POLARIS_AGENT_INSECURE` |
| `log_file` | 可选日志路径 | `--log-file` |

须满足 `1 <= sample_interval <= report_interval <= 1800`。请保留安装器写入的元数据字段，切勿手改或填入未定义字段。

## 远程配置与指令

需先在控制台开启 **设置 → 安全 → 允许远程 Agent 指令**，且机器在线。

- **远程同步**：支持同步采样/上报间隔、4 组过滤列表（每组 ≤32 项）及 `auto_update`。若主机通过 CLI 参数或环境变量显式覆盖了配置，远程修改会因冲突被拒，需先修改本地启动参数并重启。
- **远程指令**：支持 `re_report`（立即上报）、`restart`（重启）和 `upgrade`（升级）。`restart` 与 `upgrade` 仅限托管安装可用，不支持执行任意 Shell 命令。

## 更新、回滚与卸载

- **控制台更新**：点击“检查更新”仅拉取版本列表（无需机器在线）；有新版本时可在机器在线且开启远程指令后点击“升级”。
- **本地命令**：

```sh
pa update     # 下载校验并升级到最新稳定版
pa rollback   # 回退到本机保留的上一版二进制（不回滚服务端数据）
```

Docker 部署需重建容器升级，不支持就地更新。`run`、`update`、`rollback` 不支持 `--dry-run`。

**卸载**：

```sh
pa uninstall             # 系统安装需提权（sudo / 管理员 PowerShell）；支持 --dry-run 与 --yes
```

Docker 部署请在宿主机执行 `docker compose down`。也可使用原安装脚本带 `--uninstall` / `-Uninstall`（保持与安装时相同的权限、模式和目录）卸载。卸载本机程序不会自动删除控制台条目。

## 指标与连通说明

- **指标语义**：Windows 负载为平滑处理器队列长度，与 Linux/macOS 系统平均负载不可直接横向对比；无权限或平台不支持的指标显示 `—`。
- **缓存与重传**：Agent 优先走 WebSocket 上报，受限时回退 HTTP；短时断网数据会暂存内存并在重连后补传，长时间断网或异常退出可能丢失未确认样本。
- **地区探测**：启动时绕过 HTTP 环境代理通过真实出口网卡探测公网 IP 与地区（Windows 排除常见隧道虚拟网卡），上报连接本身仍尊重环境代理。
- **失联阈值**：`上报间隔 × 3`（限制在 `30–3600` 秒内；默认 60 秒上报时约 180 秒失联）。

## English

`polaris-agent` is the host agent for Uptime Polaris, with `pa` as its short command. Both operate the same binary, config, and service.

### Install and first report

1. Enable the machine page under **Settings → Presentation**, then add a machine under **Agent management**.
2. Copy the platform install command from your production origin and run it on the target host (elevated for `system` mode).
3. Run `pa status` and confirm the first report in `/admin`.

Adding a machine registers credentials only—create an **Agent** monitor for uptime and resource alerts, or select the machine as **Check source** on other monitors.

Linux / macOS:

```sh
curl -fsSL 'https://raw.githubusercontent.com/XingLingQAQ/Polaris-Agent/main/install.sh' | sh -s -- --endpoint 'https://status.example.com' --token 'TOKEN' --mode 'system'
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/XingLingQAQ/Polaris-Agent/main/install.ps1'))) -Endpoint 'https://status.example.com' -Token 'TOKEN'
```

Hosts need access to `raw.githubusercontent.com` and GitHub Releases (plus GitHub API for updates). Use one token per machine and keep install commands private.

### Installation modes

- `system`: system service (`systemd`/OpenRC/`launchd`/elevated Windows Task Scheduler).
- `user`: user service (`systemd --user` on Linux; stops at logout on macOS).
- `manual`: prepares binary and config for foreground runs (`polaris-agent run --config ...`).
- `docker`: Linux Compose v2 deployment (reports container view unless host resources are mounted).

Do not delete `install.json` next to your configuration file.

### Service management & global command

```sh
pa status            # show service status
pa start             # start the service
pa stop              # stop the service
pa restart           # restart the service (--dry-run previews)
pa logs              # last 50 log lines
pa logs -f           # follow logs
pa logs -n 200       # print a given number of lines (1–10000)
```

If `pa` is missing from `PATH`, reopen the shell or run `/path/to/polaris-agent command status --config ...` and `command register --scope user --config ...`. `command unregister` removes only the wrapper.

### Local configuration

Precedence: **CLI flags > `POLARIS_AGENT_*` env vars > JSON file**.

Key fields: `endpoint`, `token`, `sample_interval` (default `5`), `report_interval` (default `60`; adapts to Go per-sample or Worker `60` s unless explicit), `include_nics`/`exclude_nics`, `include_mounts`/`exclude_mounts`, `auto_update` (`false`), `insecure` (`false`, reporting/control TLS skip for troubleshooting only), `log_file`. Constraints: `1 <= sample_interval <= report_interval <= 1800`.

### Remote configuration and commands

Requires **Settings → Security → Allow remote Agent commands** enabled and an online Agent.

- Syncs intervals, NIC/mount filters, and `auto_update` (CLI/env overrides on the host reject conflicting remote updates).
- Supported commands: `re_report`, `restart`, and `upgrade` (`restart`/`upgrade` require a supervised install; arbitrary shell commands are not supported).

### Update, rollback, and uninstall

- `pa update` (GitHub HTTPS download + SHA-256 verify) and `pa rollback` (restores previous local binary only). Docker updates by rebuilding the container.
- `pa uninstall` (elevated for `system`; supports `--dry-run` and `--yes`), or `install.sh --uninstall` / `install.ps1 -Uninstall` with the same scope/directory. Use `docker compose down` for Docker installs.

### Metrics & connectivity

- Windows load (processor queue length) is not directly comparable to Unix load averages; unavailable metrics show `—`.
- Prefers WebSocket with HTTP fallback and short-term in-memory buffering on disconnects.
- Region discovery bypasses HTTP env proxies (ignoring virtual tunnels on Windows) while reporting traffic honors configured proxies.
- Offline timeout is `3 × report_interval` clamped to `30–3600` s (~180 s default).
