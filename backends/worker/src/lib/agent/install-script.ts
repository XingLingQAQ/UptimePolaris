/**
 * The probe install scripts, as source.
 *
 * Kept out of `download.ts` because they are long and their logic is the
 * interesting part: each one probes the host, decides how the probe should be
 * kept alive there, and says plainly which of those it managed. Inlining them
 * made that logic invisible inside a template literal.
 *
 * Both scripts take the endpoint and token, with separate sample/report cadences.
 * differ only in what a host offers. Everything else is detection.
 * Agent 安装脚本的源码。脚本较长且逻辑是重点，因此独立于 `download.ts`：每个脚本探测主机、
 * 选择 Agent 保活方式并明确报告最终达到的方式；内联会使这些逻辑隐藏在模板字面量中。
 * 两个脚本均接收端点、令牌及独立的采样和上报间隔；
 * 差异取决于主机提供的功能，其余由探测决定。
 */

import { AGENT_SHORT_COMMAND } from '../../../../../shared/project';
import { powershellQuote } from '../../../../../shared/agent-install';

export interface InstallParams {
  /** Origin of the deployment serving the script, e.g. https://uptime-polaris.example / 提供脚本的部署源地址，例如 https://uptime-polaris.example */
  base: string;
}

/**
 * The POSIX installer.
 *
 * Structure, in order, and the order matters:
 *   1. parse args
 *   2. probe the host (container? root? init? supervisor? package manager?)
 *   3. print the plan
 *   4. fetch the binary, with a fallback if curl is missing
 *   5. install with the best persistence the host allows
 *   6. report which tier was reached
 *
 * Step 3 exists so an operator can see what it decided before it acts. Every
 * other installer in this space runs silently and then either works or does
 * not; the silent version is what makes "why did it not survive a reboot" so
 * hard to answer.
 * POSIX 安装器按顺序解析参数、探测主机（容器、root、init、守护进程及包管理器）、
 * 打印计划、下载二进制文件（缺少 curl 时使用备用方案）、选择最佳保活方式并报告结果。
 * 第 3 步让管理员在执行前看到决策；同类其他安装器往往静默运行，最后只表现为成功
 * 或失败，因此很难回答“为何重启后没有继续运行”。
 */
export function installSh({ base }: InstallParams): string {
  return `#!/bin/sh
# Uptime Polaris Agent installer.
# Uptime Polaris Agent 安装器。
#
#   curl -fsSL ${base}/api/public/agent/download/install.sh | sh
#   curl -fsSL ... | sh -s -- --endpoint ${base} --token <TOKEN>
#
# POSIX sh, not bash: Alpine, BusyBox and most container base images ship ash
# and often no bash at all, and this script is meant to run on exactly those.
# 使用 POSIX sh 而非 bash：Alpine、BusyBox 和多数容器基础镜像提供 ash，
# 往往没有 bash；此脚本正是为这些环境设计的。
set -eu

AGENT_NAME="polaris-agent"

ENDPOINT="${base}"
TOKEN=""
ENDPOINT_SET=0
TOKEN_SET=0
SAMPLE_INTERVAL=""
REPORT_INTERVAL=""
MODE="auto"
INCLUDE_NICS=""
EXCLUDE_NICS=""
INCLUDE_MOUNTS=""
EXCLUDE_MOUNTS=""
INSTALL_DIR=""
SERVICE_NAME="$AGENT_NAME"
PLATFORM=""
UNINSTALL=0
AUTO_UPDATE=""
REGISTER_COMMAND=1

# A credential may arrive in the environment rather than in argv. argv is
# world-readable through ps and /proc/<pid>/cmdline; /proc/<pid>/environ is
# owner-only, so this keeps the token out of every other user's view. The
# pasted command still lands in the caller's own shell history - that part
# cannot be fixed from inside the script, so the docs say so.
# 凭据可以通过环境传入，而非 argv。其他用户可通过 ps 和 /proc/<pid>/cmdline
# 读取 argv，但 /proc/<pid>/environ 仅限所有者读取，从而避免其他用户看到令牌。
# 粘贴的命令仍会进入调用者自己的 shell 历史，脚本无法解决此问题，文档会说明。
#
# process environment variable, and reusing the name would imply a link that
# does not exist.
# 进程环境变量；复用名称会暗示一个实际上不存在的关联。
if [ -z "$TOKEN" ] && [ -n "\${POLARIS_AGENT_TOKEN:-}" ]; then TOKEN="$POLARIS_AGENT_TOKEN"; TOKEN_SET=1; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint)  ENDPOINT="\${2:-}"; ENDPOINT_SET=1; shift 2 ;;
    --token)     TOKEN="\${2:-}";    TOKEN_SET=1; shift 2 ;;
    --sample-interval) SAMPLE_INTERVAL="\${2:-}"; shift 2 ;;
    --report-interval) REPORT_INTERVAL="\${2:-}"; shift 2 ;;
    --mode) MODE="\${2:-}"; shift 2 ;;
    --include-nics) INCLUDE_NICS="\${2:-}"; shift 2 ;;
    --exclude-nics) EXCLUDE_NICS="\${2:-}"; shift 2 ;;
    --include-mounts) INCLUDE_MOUNTS="\${2:-}"; shift 2 ;;
    --exclude-mounts) EXCLUDE_MOUNTS="\${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="\${2:-}"; shift 2 ;;
    --service-name) SERVICE_NAME="\${2:-}"; shift 2 ;;
    --platform) PLATFORM="\${2:-}"; shift 2 ;;
    --auto-update) AUTO_UPDATE=1; shift ;;
    --disable-auto-update) AUTO_UPDATE=0; shift ;;
    --register-command) REGISTER_COMMAND=1; shift ;;
    --no-register-command) REGISTER_COMMAND=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      echo "usage: install.sh --endpoint URL --token TOKEN [--sample-interval SEC] [--report-interval SEC] [--uninstall]"
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done


say()  { printf '%s\\n' "$*"; }
warn() { printf '%s\\n' "$*" >&2; }
die()  { printf '%s\\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Probe the host
# 1. 探测主机
# ---------------------------------------------------------------------------

# In a container? PID 1 is the giveaway on modern Docker (it may be the app,
# not an init), and the two marker files cover older runtimes.
# 检测容器：现代 Docker 可通过 PID 1 判断（它可能是应用而非 init），
# 两个标记文件则覆盖较旧的运行时。
IN_CONTAINER=0
[ -f /.dockerenv ] && IN_CONTAINER=1
[ -f /run/.containerenv ] && IN_CONTAINER=1
if [ -r /proc/1/cgroup ]; then
  case "$(cat /proc/1/cgroup 2>/dev/null)" in
    *docker*|*kubepods*|*containerd*|*lxc*) IN_CONTAINER=1 ;;
  esac
fi

# Root? Everything about where files can go depends on it.
# 是否为 root 决定文件可以放置的位置。
IS_ROOT=0
[ "$(id -u 2>/dev/null || echo 1)" = "0" ] && IS_ROOT=1
[ "$MODE" != system ] || [ "$IS_ROOT" = 1 ] || die "system mode needs root; use sudo or select --mode user"

# An init system we can hand the job to. systemd is checked by whether the
# *system bus* answers, not by whether the binary exists: a container often
# has /usr/bin/systemctl with no PID 1 to talk to, and 'systemctl enable'
# there fails with a confusing "System has not been booted with systemd".
# 通过系统总线是否响应来检测 systemd，而不只是检查二进制文件：容器常有
# /usr/bin/systemctl，却没有可通信的 PID 1，此时 'systemctl enable' 会报出
# 容易令人困惑的 "System has not been booted with systemd"。
HAVE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && [ "$IN_CONTAINER" = "0" ]; then
  if systemctl is-system-running >/dev/null 2>&1 || [ -d /run/systemd/system ]; then
    HAVE_SYSTEMD=1
  fi
fi

HAVE_OPENRC=0
command -v rc-update >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1 && HAVE_OPENRC=1

# Supervisors that watch a process and restart it. This is what makes a
# container install survive the app crashing, and on a container that has one
# it is strictly better than nohup.
# 检测可监视并重启进程的管理器。容器中有管理器时，它比 nohup 更可靠，
# 能在应用崩溃后重新启动 Agent。
HAVE_SUPERVISORD=0
command -v supervisorctl >/dev/null 2>&1 && HAVE_SUPERVISORD=1
[ -d /etc/supervisor/conf.d ] && HAVE_SUPERVISORD=1
HAVE_S6=0
[ -d /etc/s6-overlay ] || [ -d /run/s6 ] && HAVE_S6=1

# A crontab that honours @reboot. BusyBox crond ignores it, so its presence is
# not enough - but a false positive here only costs a failed start attempt,
# while a false negative costs persistence we could have had.
# 检测支持 @reboot 的 crontab。BusyBox crond 会忽略它，因此存在 crontab
# 并不足以保证支持；误判只会导致一次启动失败，漏判则会错失可用的保活方式。
HAVE_CRON=0
command -v crontab >/dev/null 2>&1 && HAVE_CRON=1

# How to fetch. curl is preferred only because it fails loudly on HTTP errors
# without extra flags; wget is the fallback and is what slim images ship.
# 下载优先使用 curl，因为它无需额外参数即可明确报告 HTTP 错误；精简镜像可回退到 wget。
FETCH=""
if command -v curl >/dev/null 2>&1; then FETCH="curl"
elif command -v wget >/dev/null 2>&1; then FETCH="wget"
elif command -v busybox >/dev/null 2>&1 && busybox wget --help >/dev/null 2>&1; then FETCH="busybox-wget"
fi

# Package manager, for installing a missing downloader.
# 检测包管理器，用于安装缺失的下载工具。
PKG=""
for c in apt-get apk dnf yum zypper pacman; do
  command -v "$c" >/dev/null 2>&1 && { PKG="$c"; break; }
done

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
# uname -s is not a platform name: it reports "Darwin" on macOS, and on
# Git Bash / MSYS / Cygwin it reports things like "mingw64_nt-10.0-26100".
# Everything unrecognised is treated as Linux, the honest default for a POSIX
# shell on a machine this installer is meant for.
# uname -s 返回的不是平台名：macOS 返回 "Darwin"，Git Bash、MSYS 和 Cygwin
# 返回类似 "mingw64_nt-10.0-26100" 的值。未识别的环境按 Linux 处理，
# 这是本安装器目标 POSIX 主机的合理默认值。
case "$OS" in
  darwin)                OS="darwin" ;;
  mingw*|msys*|cygwin*|windows*) OS="windows" ;;
  *)                     OS="linux" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  # 32-bit ARM and i686 have no prebuilt probe. Saying so here is better than
  # requesting a file that cannot exist.
  # 32 位 ARM 和 i686 没有预构建 Agent；在这里提示，而不是请求不存在的文件。
  *) die "unsupported architecture: $ARCH
Prebuilt probes exist for x86_64 and aarch64. To use another, build one with
'npm run build' in the polaris-agent repository and host the binary yourself." ;;
esac
DETECTED_PLATFORM="$OS-$ARCH"
[ -z "$PLATFORM" ] || [ "$PLATFORM" = "$DETECTED_PLATFORM" ] || die "selected build $PLATFORM does not match this host ($DETECTED_PLATFORM)"

# ---------------------------------------------------------------------------
# 2. State the plan
# 2. 显示计划
# ---------------------------------------------------------------------------

say "Uptime Polaris Agent installer"
say "  host        : $OS/$ARCH"
say "  container   : $([ "$IN_CONTAINER" = 1 ] && echo yes || echo no)"
say "  root        : $([ "$IS_ROOT" = 1 ] && echo yes || echo no)"
say "  init        : $([ "$HAVE_SYSTEMD" = 1 ] && echo systemd || { [ "$HAVE_OPENRC" = 1 ] && echo openrc || echo none; })"
say "  supervisor  : $([ "$HAVE_SUPERVISORD" = 1 ] && echo supervisord || { [ "$HAVE_S6" = 1 ] && echo s6 || echo none; })"
say "  downloader  : \${FETCH:-none}"
say ""

# ---------------------------------------------------------------------------
# 3. Where files go
# 3. 文件存放位置
# ---------------------------------------------------------------------------

case "$SERVICE_NAME" in *[!A-Za-z0-9_.@-]*|'' ) die "invalid service name" ;; esac
if [ -n "$INSTALL_DIR" ]; then
  case "$INSTALL_DIR" in /*) ;; *) die "install directory must be an absolute path" ;; esac
  case "$INSTALL_DIR" in *'
'*) die "install directory cannot contain a newline" ;; esac
  printf '%s' "$INSTALL_DIR" | LC_ALL=C grep -Eq '^[A-Za-z0-9._/ -]+$' || die "install directory may contain only letters, digits, spaces, '.', '_', '-', and '/'"
  BIN_DIR="$INSTALL_DIR/bin"
  CFG_DIR="$INSTALL_DIR/config"
elif [ "$IS_ROOT" = 1 ]; then
  BIN_DIR="/usr/local/lib/polaris-agent"
  CFG_DIR="/etc/$AGENT_NAME"
else
  BIN_DIR="\${HOME:-/tmp}/.local/lib/polaris-agent"
  CFG_DIR="\${XDG_CONFIG_HOME:-\${HOME:-/tmp}/.config}/$AGENT_NAME"
fi
DEST="$BIN_DIR/$AGENT_NAME"

# The token goes in a file, not on the command line. A command line is visible
# to every user via /proc and ps, and ends up in shell history and in the
# unit file - a credential in three places it does not need to be.
# 令牌写入文件而不是命令行：所有用户可通过 /proc 和 ps 查看命令行，
# 它还会进入 shell 历史和服务单元文件，让凭据暴露在不必要的位置。
CFG="$CFG_DIR/config.json"
LOG_PATH="$CFG_DIR/agent.log"
DOCKER_DIR="$CFG_DIR/docker-$SERVICE_NAME"
INSTALL_MARKER="$CFG_DIR/.$AGENT_NAME-managed"
CRON_MARKER="# $AGENT_NAME-managed:$SERVICE_NAME:$INSTALL_DIR"
SERVICE_MARKER="# $AGENT_NAME-managed:$SERVICE_NAME:$INSTALL_DIR"

filter_owned_cron() {
  awk -v marker="$CRON_MARKER" 'length($0) >= length(marker) && substr($0, length($0) - length(marker) + 1) == marker { next } { print }'
}


mkdir -p "$BIN_DIR" "$CFG_DIR" 2>/dev/null || die "cannot create $BIN_DIR (need write permission or root)"
umask 077
LOCK_DIR="$BIN_DIR/.polaris-agent-install.lock"
LOCK_GATE="$BIN_DIR/.polaris-agent-install.gate"
cleanup_install_temp() {
  if [ "\${TX_PREPARING:-0}" = 1 ]; then
    rm -f "$TX_DIR/state.tmp" "$TX_DIR/config" "$TX_DIR/binary"
    rmdir "$TX_DIR" 2>/dev/null || true
  fi
  [ -z "\${CFG_NEW:-}" ] || rm -f "$CFG_NEW"
  [ -z "\${CFG_MERGED:-}" ] || rm -f "$CFG_MERGED"
  [ -z "\${BIN_NEW:-}" ] || rm -f "$BIN_NEW"
  [ -z "\${TMP_DIR:-}" ] || rm -rf "$TMP_DIR"
  if [ "\${LOCK_HELD:-0}" = 1 ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  if [ "\${GATE_HELD:-0}" = 1 ]; then rmdir "$LOCK_GATE" 2>/dev/null || true; fi
  if [ "$UNINSTALL" = 1 ]; then rmdir "$BIN_DIR" "$CFG_DIR" 2>/dev/null || true; fi
}
trap cleanup_install_temp 0
trap 'exit 1' HUP INT TERM
mkdir "$LOCK_GATE" 2>/dev/null || die "another installer is acquiring the lock, or $LOCK_GATE is left by an interrupted lock acquisition; verify no installer is running before removing that empty directory"
GATE_HELD=1
if [ -e "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
  [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] && [ -f "$LOCK_DIR/pid" ] || die "invalid installer lock $LOCK_DIR; verify no installer is running before removing it"
  lock_pid=$(cat "$LOCK_DIR/pid")
  case "$lock_pid" in ''|*[!0-9]*|0) die "invalid installer lock owner" ;; esac
  if kill -0 "$lock_pid" 2>/dev/null || ps -p "$lock_pid" -o pid= 2>/dev/null | grep -q '[0-9]'; then
    die "another installer is running (pid $lock_pid)"
  fi
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" || die "cannot remove stale installer lock"
fi
mkdir "$LOCK_DIR" || die "cannot acquire installer lock"
LOCK_HELD=1
printf '%s\n' "$$" > "$LOCK_DIR/pid"
rmdir "$LOCK_GATE" || die "cannot release installer lock gate"
GATE_HELD=0

if [ "$UNINSTALL" = 1 ]; then
  if [ -e "$CFG_DIR/.polaris-agent-transaction" ] || [ -L "$CFG_DIR/.polaris-agent-transaction" ]; then
    die "unfinished installation transaction; rerun the installer without --uninstall to recover it first"
  fi
  if [ -f "$CFG_DIR/install.json" ] && [ -x "$DEST" ]; then
    "$DEST" command unregister --config "$CFG" || die "cannot remove the registered terminal command"
  fi
  say "→ removing"
  if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ] && grep -Fxq "$SERVICE_MARKER" "/etc/systemd/system/$SERVICE_NAME.service"; then systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true; rm -f "/etc/systemd/system/$SERVICE_NAME.service"; systemctl daemon-reload >/dev/null 2>&1 || true; fi
  user_unit="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME.service"
  if [ -f "$user_unit" ] && grep -Fxq "$SERVICE_MARKER" "$user_unit"; then systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true; rm -f "$user_unit"; systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
  if [ "$OS" = "darwin" ]; then
    for plist in "/Library/LaunchDaemons/$SERVICE_NAME.plist" "$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"; do
      if [ -f "$plist" ] && grep -Fxq "<!-- $SERVICE_MARKER -->" "$plist"; then domain="gui/$(id -u)"; case "$plist" in /Library/LaunchDaemons/*) domain="system" ;; esac; launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || true; rm -f "$plist"; fi
    done
  fi
  if [ -f "/etc/init.d/$SERVICE_NAME" ] && grep -Fxq "$SERVICE_MARKER" "/etc/init.d/$SERVICE_NAME"; then rc-service "$SERVICE_NAME" stop >/dev/null 2>&1 || true; rc-update del "$SERVICE_NAME" >/dev/null 2>&1 || true; rm -f "/etc/init.d/$SERVICE_NAME"; fi
  if [ -f "/etc/supervisor/conf.d/$SERVICE_NAME.conf" ] && grep -Fxq "$SERVICE_MARKER" "/etc/supervisor/conf.d/$SERVICE_NAME.conf"; then rm -f "/etc/supervisor/conf.d/$SERVICE_NAME.conf"; fi
  if [ -f "/etc/services.d/$SERVICE_NAME/run" ] && grep -Fxq "$SERVICE_MARKER" "/etc/services.d/$SERVICE_NAME/run"; then rm -f "/etc/services.d/$SERVICE_NAME/run"; rmdir "/etc/services.d/$SERVICE_NAME" 2>/dev/null || true; fi
  [ "$HAVE_CRON" = 1 ] && { crontab -l 2>/dev/null | filter_owned_cron | crontab - 2>/dev/null || true; }
  if [ -f "$DOCKER_DIR/.$AGENT_NAME-managed" ] && [ "$(cat "$DOCKER_DIR/.$AGENT_NAME-managed")" = "$SERVICE_NAME:$INSTALL_DIR" ]; then
    (cd "$DOCKER_DIR" && docker compose down >/dev/null 2>&1) || true
    rm -f "$DOCKER_DIR/Dockerfile" "$DOCKER_DIR/compose.yaml" "$DOCKER_DIR/.dockerignore" "$DOCKER_DIR/$AGENT_NAME" "$DOCKER_DIR/.$AGENT_NAME-managed"
    rmdir "$DOCKER_DIR" 2>/dev/null || true
  fi
  if [ -f "$INSTALL_MARKER" ] && [ "$(cat "$INSTALL_MARKER")" = "$SERVICE_NAME:$INSTALL_DIR" ]; then
    rm -f "$DEST" "$CFG" "$INSTALL_MARKER" "$CFG_DIR/install.json"
    rmdir "$BIN_DIR" "$CFG_DIR" 2>/dev/null || true
  fi
  say "  removed $DEST and $CFG"
  exit 0
fi


if [ -f "$INSTALL_MARKER" ]; then
  [ "$(cat "$INSTALL_MARKER")" = "$SERVICE_NAME:$INSTALL_DIR" ] || die "install directory belongs to another agent configuration
  marker : $INSTALL_MARKER
  says   : $(cat "$INSTALL_MARKER")
  wants  : $SERVICE_NAME:$INSTALL_DIR
  Re-run with the service name and install directory the marker records, or run this script with --uninstall first."
elif [ -e "$DEST" ] || [ -e "$CFG" ]; then
  die "refusing to overwrite existing files without an $AGENT_NAME ownership marker
  found  : $([ -e "$DEST" ] && printf '%s ' "$DEST")$([ -e "$CFG" ] && printf '%s' "$CFG")
  marker : $INSTALL_MARKER (absent)
  These are leftover files from an earlier install whose marker was removed. Delete them and re-run:
    rm -f '$DEST' '$CFG'"
fi

TX_DIR="$CFG_DIR/.polaris-agent-transaction"
remove_transaction() {
  rm -f "$TX_DIR/active" "$TX_DIR/state.tmp" "$TX_DIR/config" "$TX_DIR/binary"
  rmdir "$TX_DIR" || die "cannot remove transaction directory $TX_DIR"
}
recover_transaction() {
  [ -d "$TX_DIR" ] && [ ! -L "$TX_DIR" ] || die "invalid transaction directory: $TX_DIR"
  if [ ! -f "$TX_DIR/active" ]; then
    remove_transaction
    return
  fi
  [ -f "$INSTALL_MARKER" ] && [ "$(cat "$INSTALL_MARKER")" = "$SERVICE_NAME:$INSTALL_DIR" ] || die "transaction has no matching ownership marker"
  state=$(cat "$TX_DIR/active")
  case "$state" in
    present:present|present:absent|absent:present|absent:absent) ;;
    *) die "invalid installation transaction state" ;;
  esac
  case "$state" in present:*) [ -f "$TX_DIR/config" ] && [ ! -L "$TX_DIR/config" ] || die "transaction config backup is missing" ;; esac
  case "$state" in *:present) [ -f "$TX_DIR/binary" ] && [ ! -L "$TX_DIR/binary" ] || die "transaction binary backup is missing" ;; esac
  case "$state" in
    *:present)
      restore_bin=$(mktemp "$BIN_DIR/.polaris-restore.XXXXXX") || die "cannot stage binary recovery"
      cp -p "$TX_DIR/binary" "$restore_bin" && mv -f "$restore_bin" "$DEST" || { rm -f "$restore_bin"; die "cannot restore previous binary"; }
      ;;
    *:absent) rm -f "$DEST" || die "cannot remove unfinished binary" ;;
  esac
  case "$state" in
    present:*)
      restore_cfg=$(mktemp "$CFG_DIR/.config-restore.XXXXXX") || die "cannot stage configuration recovery"
      cp -p "$TX_DIR/config" "$restore_cfg" && mv -f "$restore_cfg" "$CFG" || { rm -f "$restore_cfg"; die "cannot restore previous configuration"; }
      ;;
    absent:*) rm -f "$CFG" || die "cannot remove unfinished configuration" ;;
  esac
  sync || die "cannot sync recovered installation"
  rm -f "$TX_DIR/active"
  sync || die "cannot sync recovery completion"
  remove_transaction
  say "  recovered previous installation"
}
if [ -e "$TX_DIR" ] || [ -L "$TX_DIR" ]; then recover_transaction; fi

if [ -z "$ENDPOINT" ] && [ -f "$CFG" ] && [ "$ENDPOINT_SET" = 0 ]; then
  ENDPOINT="${base}"
elif [ -z "$ENDPOINT" ]; then
  printf 'Endpoint [%s]: ' "${base}"
  read -r ENDPOINT || true
  [ -z "$ENDPOINT" ] && ENDPOINT="${base}"
fi
[ -z "$TOKEN" ] && { [ ! -f "$CFG" ] || [ "$TOKEN_SET" = 1 ]; } && { printf 'Agent token: '; read -r TOKEN || true; }
[ -z "$TOKEN" ] && [ ! -f "$CFG" ] && die "an Agent token is required"
[ "$MODE" = "auto" ] || [ "$MODE" = "system" ] || [ "$MODE" = "user" ] || [ "$MODE" = "manual" ] || [ "$MODE" = "docker" ] || die "mode must be system, user, manual, or docker"
[ "$MODE" != docker ] || [ "$AUTO_UPDATE" != 1 ] || die "automatic updates are disabled in Docker; rebuild and replace the image"
EFFECTIVE_SAMPLE="\${SAMPLE_INTERVAL:-5}"
EFFECTIVE_REPORT="\${REPORT_INTERVAL:-60}"
case "$EFFECTIVE_SAMPLE:$EFFECTIVE_REPORT" in *[!0-9:]*|:*|*:) die "intervals must be positive integers" ;; esac
[ "$EFFECTIVE_SAMPLE" -ge 1 ] && [ "$EFFECTIVE_REPORT" -ge "$EFFECTIVE_SAMPLE" ] && [ "$EFFECTIVE_REPORT" -le 1800 ] || die "require 1 <= sample <= report <= 1800"

if [ "$HAVE_SYSTEMD" = 1 ] && [ "$IS_ROOT" = 1 ] && [ "$MODE" != user ]; then
  case "$DEST" in /home|/home/*|/root|/root/*|/run/user/*) die "systemd ProtectHome=true hides $DEST; choose a path outside /home, /root, and /run/user" ;; esac
  case "$CFG" in /home|/home/*|/root|/root/*|/run/user/*) die "systemd ProtectHome=true hides $CFG; choose a path outside /home, /root, and /run/user" ;; esac
fi

# This script runs under a POSIX shell, so a Windows host here means Git Bash,
# Cygwin or MSYS. The probe it would install is a Linux ELF, which that shell
# can download but the OS cannot execute - so send the operator to the
# PowerShell installer instead of leaving them with a file that will not run.
# 此脚本运行在 POSIX shell 中，因此 Windows 主机指的是 Git Bash、Cygwin 或 MSYS。
# 它们可以下载 Linux ELF Agent，但系统无法执行；应转用 PowerShell 安装器，
# 而不是留下无法运行的文件。
if [ "$OS" = "windows" ]; then
  die "this is a POSIX shell on Windows ($(uname -s)).
Use the PowerShell installer instead, from an elevated PowerShell:

  (irm $ENDPOINT/api/public/agent/download/install.ps1).TrimStart([char]0xFEFF) | iex"
fi

# ---------------------------------------------------------------------------
# 4. Fetch the binary
# 4. 下载二进制文件
# ---------------------------------------------------------------------------

if [ -z "$FETCH" ]; then
  say "→ no curl or wget; trying $PKG"
  case "$PKG" in
    apt-get) apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl >/dev/null 2>&1 ;;
    apk)     apk add --no-cache curl >/dev/null 2>&1 ;;
    dnf)     dnf install -y -q curl >/dev/null 2>&1 ;;
    yum)     yum install -y -q curl >/dev/null 2>&1 ;;
    zypper)  zypper -q install -y curl >/dev/null 2>&1 ;;
    pacman)  pacman -S --noconfirm --quiet curl >/dev/null 2>&1 ;;
  esac
  command -v curl >/dev/null 2>&1 && FETCH="curl"
  command -v wget >/dev/null 2>&1 && [ -z "$FETCH" ] && FETCH="wget"
fi
[ -z "$FETCH" ] && die "cannot download: no curl, no wget, and could not install one.
Install curl by hand and re-run, or copy the binary to $DEST yourself."

URL="$ENDPOINT/api/public/agent/download/$AGENT_NAME-$OS-$ARCH"
say "→ downloading $URL"

TMP_DIR=$(mktemp -d "\${TMPDIR:-/tmp}/polaris-agent.XXXXXX") || die "cannot create private temporary directory"
TMP="$TMP_DIR/binary"
fetch() {
  case "$FETCH" in
    curl) curl -fsSL "$1" -o "$2" ;;
    wget) wget -q -O "$2" "$1" ;;
    busybox-wget) busybox wget -q -O "$2" "$1" ;;
  esac
}

if ! fetch "$URL" "$TMP"; then
  rm -f "$TMP"
  die "download failed. The Agent GitHub repository needs a published stable release
with an asset for $OS/$ARCH; also check GitHub network access and API rate limits. Check
$ENDPOINT/api/public/agent/download/$AGENT_NAME-$OS-$ARCH in a browser:
the response reports the release error."
fi

# A prebuilt probe is an ELF/Mach-O/PE binary. Verify that before installing
# anything: the download route once answered with the site's index.html when a
# binary was missing, and installing a web page as a daemon fails in a way
# that is very hard to read.
# 预构建 Agent 是 ELF、Mach-O 或 PE 二进制文件。安装前先验证：下载路由曾在
# 文件缺失时返回网站 index.html，把网页当作守护进程安装会导致难以理解的错误。
if [ "$OS" = darwin ] && head -c 4 "$TMP" 2>/dev/null | od -An -tx1 2>/dev/null | grep -qiE 'cf fa ed fe|fe ed fa cf|ca fe ba be'; then
  : # Mach-O
elif head -c 4 "$TMP" 2>/dev/null | od -An -tx1 2>/dev/null | grep -qi '7f 45 4c 46'; then
  : # ELF, as expected
elif head -c 2 "$TMP" 2>/dev/null | od -An -tx1 2>/dev/null | grep -qi '4d 5a'; then
  : # PE
else
  FIRST="$(head -c 60 "$TMP" 2>/dev/null | tr -d '\\000' || true)"
  rm -f "$TMP"
  die "the downloaded file is not an executable (starts with: $FIRST)
This means the server did not serve a probe binary. Report it."
fi

# The magic-byte check above only says the file looks like an executable for
# this OS. It cannot tell a probe this project built from something else that
# starts with the same bytes, so the release manifest's sha256 is compared too.
# 上述魔数字节检查只能说明文件看起来像该系统的可执行文件，无法区分本项目构建的
# Agent 和具有相同开头的其他文件，因此还要比较发布清单中的 sha256。
#
SHA_CMD=""
if command -v sha256sum >/dev/null 2>&1; then SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA_CMD="shasum -a 256"
elif command -v openssl >/dev/null 2>&1; then SHA_CMD="openssl dgst -sha256"
fi

# One line on purpose: a trailing backslash inside a template literal is easy
# to double and then the continuation silently becomes a new statement.
# 故意写成一行：模板字面量中的行尾反斜杠容易被重复转义，使续行悄然变成新语句。
manifest_sha() {
  tr -d '\\n\\r' | tr '{' '\\n' | grep -E '"key"[[:space:]]*:[[:space:]]*"'"$DETECTED_PLATFORM"'"' | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\\([a-fA-F0-9]\\{64\\}\\)".*/\\1/p' | head -n 1
}

MANIFEST_TMP="$TMP_DIR/manifest"
EXPECTED_SHA=""
for candidate in "$ENDPOINT/api/public/agent/manifest"; do
  if fetch "$candidate" "$MANIFEST_TMP" 2>/dev/null; then
    EXPECTED_SHA=$(manifest_sha < "$MANIFEST_TMP" || true)
    [ -z "$EXPECTED_SHA" ] || break
  fi
done
rm -f "$MANIFEST_TMP"

if [ -z "$SHA_CMD" ]; then
  die "download verification requires sha256sum, shasum, or openssl"
elif [ -z "$EXPECTED_SHA" ]; then
  die "release manifest has no valid SHA-256 for $DETECTED_PLATFORM"
else
  ACTUAL_SHA=$($SHA_CMD "$TMP" 2>/dev/null | grep -oE '[a-fA-F0-9]{64}' | head -n 1 | tr 'A-F' 'a-f')
  EXPECTED_SHA=$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    rm -f "$TMP"
    die "sha256 mismatch for $DETECTED_PLATFORM
  expected: $EXPECTED_SHA
  actual:   \${ACTUAL_SHA:-none}
The downloaded file is not the build this deployment's manifest describes.
That is a replaced or corrupted binary; refusing to install it."
  fi
  say "  verified    : sha256 $ACTUAL_SHA"
fi

# ---------------------------------------------------------------------------
# 5. Config
# 5. 配置
# ---------------------------------------------------------------------------

umask 077
json_escape() {
  printf '%s' "$1" | LC_ALL=C od -An -tu1 | LC_ALL=C awk '{ for (i=1; i<=NF; i++) { n=$i+0; if (n==34 || n==92) printf "%c%c", 92, n; else if (n==10) printf "%c%c", 92, 110; else if (n==13) printf "%c%c", 92, 114; else if (n==9) printf "%c%c", 92, 116; else if (n<32 || n==127) { printf "%c", 92; printf "u%04x", n } else printf "%c", n } }'
}
CFG_NEW=$(mktemp "$CFG_DIR/.config.XXXXXX") || die "cannot stage config in $CFG_DIR"
  printf '{\n  "endpoint": "%s",\n  "token": "%s"' "$(json_escape "$ENDPOINT")" "$(json_escape "$TOKEN")" > "$CFG_NEW"
if [ -n "$SAMPLE_INTERVAL" ]; then printf ',\n  "sample_interval": %s' "$SAMPLE_INTERVAL" >> "$CFG_NEW"
elif [ ! -f "$CFG" ]; then printf ',\n  "sample_interval": %s' "$EFFECTIVE_SAMPLE" >> "$CFG_NEW"; fi
if [ -n "$REPORT_INTERVAL" ]; then printf ',\n  "report_interval": %s' "$REPORT_INTERVAL" >> "$CFG_NEW"
elif [ ! -f "$CFG" ]; then printf ',\n  "report_interval": %s' "$EFFECTIVE_REPORT" >> "$CFG_NEW"; fi

for pair in "include_nics:$INCLUDE_NICS" "exclude_nics:$EXCLUDE_NICS" "include_mounts:$INCLUDE_MOUNTS" "exclude_mounts:$EXCLUDE_MOUNTS"; do
  key=\${pair%%:*}; value=\${pair#*:}
  [ -n "$value" ] || continue
  escaped=$(json_escape "$value" | sed 's/,/","/g')
  printf ',\n  "%s": ["%s"]' "$key" "$escaped" >> "$CFG_NEW"
done
if [ -n "$AUTO_UPDATE" ]; then printf ',\n  "auto_update": %s' "$([ "$AUTO_UPDATE" = 1 ] && echo true || echo false)" >> "$CFG_NEW"; fi
# service_tier is filled in by section 6, once the host's persistence
# mechanism is known. It is written here as a placeholder so the JSON stays
# one object: rewriting a finished file is how a half-written config happens
# when a later step dies.
# service_tier 在第 6 节确定主机保活机制后填写。此处先写占位符以保持单个 JSON 对象；
# 重写完整文件时若后续步骤失败，可能留下写到一半的配置。
printf ',\n  "service_tier": "C"' >> "$CFG_NEW"
printf '\n}\n' >> "$CFG_NEW"
if [ -f "$CFG" ]; then
  command -v python3 >/dev/null 2>&1 || { rm -f "$CFG_NEW" "$TMP"; die "python3 is required to preserve the existing config during upgrade"; }
  CFG_MERGED=$(mktemp "$CFG_DIR/.config-merged.XXXXXX") || { rm -f "$CFG_NEW"; die "cannot stage merged config"; }
  if ! EFFECTIVE_AUTO_UPDATE=$(python3 - "$CFG" "$CFG_NEW" "$CFG_MERGED" "$ENDPOINT_SET" "$TOKEN_SET" "$EFFECTIVE_SAMPLE" "$EFFECTIVE_REPORT" <<'PY'
import json, os, sys
with open(sys.argv[1], encoding="utf-8") as f: saved = json.load(f)
with open(sys.argv[2], encoding="utf-8") as f: update = json.load(f)
if not isinstance(saved, dict): raise ValueError("config must be an object")
allowed = {"endpoint", "token", "sample_interval", "report_interval", "include_nics", "exclude_nics", "include_mounts", "exclude_mounts", "insecure", "auto_update", "log_file", "runtime_revision", "service_tier"}
if (saved.keys() | update.keys()) - allowed: raise ValueError("configuration contains unsupported fields")
if sys.argv[4] != "1": update["endpoint"] = saved.get("endpoint", update["endpoint"])
if sys.argv[5] != "1" and "token" in update: update["token"] = saved.get("token", update["token"])
saved.update(update)
sample = saved.get("sample_interval", int(sys.argv[6]))
report = saved.get("report_interval", int(sys.argv[7]))
if not isinstance(sample, int) or isinstance(sample, bool) or not isinstance(report, int) or isinstance(report, bool) or not 1 <= sample <= report <= 1800:
    raise ValueError("require 1 <= sample <= report <= 1800")
if not isinstance(saved.get("endpoint"), str) or not saved["endpoint"] or not (isinstance(saved.get("token"), str) and saved["token"]):
    raise ValueError("endpoint and Agent token must be nonempty strings")
auto_update = saved.get("auto_update", False)
if not isinstance(auto_update, bool): raise ValueError("auto_update must be a boolean")
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump(saved, f, indent=2); f.write("\\n"); f.flush(); os.fsync(f.fileno())
print("1" if auto_update else "0")
PY
  ); then rm -f "$CFG_NEW" "$CFG_MERGED" "$TMP"; die "existing config is invalid or has invalid intervals; refusing to overwrite it"; fi
  rm -f "$CFG_NEW"
  CFG_NEW="$CFG_MERGED"
else
  EFFECTIVE_AUTO_UPDATE="\${AUTO_UPDATE:-0}"
fi
[ "$MODE" != docker ] || [ "$EFFECTIVE_AUTO_UPDATE" != 1 ] || die "automatic updates are disabled in Docker; rebuild and replace the image"
chmod 600 "$CFG_NEW"
BIN_NEW=$(mktemp "$BIN_DIR/.polaris-agent.XXXXXX") || die "cannot stage binary in $BIN_DIR"
cp "$TMP" "$BIN_NEW" && chmod 755 "$BIN_NEW" || { rm -f "$BIN_NEW"; die "cannot stage binary"; }
if [ ! -f "$INSTALL_MARKER" ]; then
  printf '%s:%s\n' "$SERVICE_NAME" "$INSTALL_DIR" > "$INSTALL_MARKER"
  chmod 600 "$INSTALL_MARKER"
  sync || die "cannot sync installation marker"
fi
mkdir -m 700 "$TX_DIR" || die "cannot create installation transaction"
TX_PREPARING=1
config_state=absent
binary_state=absent
if [ -f "$CFG" ]; then
  cp -p "$CFG" "$TX_DIR/config" || die "cannot back up config"
  config_state=present
fi
if [ -f "$DEST" ]; then
  cp -p "$DEST" "$TX_DIR/binary" || die "cannot back up binary"
  binary_state=present
fi
printf '%s:%s\n' "$config_state" "$binary_state" > "$TX_DIR/state.tmp"
sync || die "cannot sync installation backups"
mv "$TX_DIR/state.tmp" "$TX_DIR/active"
TX_PREPARING=0
sync || die "cannot sync installation transaction"
if ! mv -f "$CFG_NEW" "$CFG"; then
  recover_transaction
  die "cannot replace config; previous installation restored"
fi
if ! mv -f "$BIN_NEW" "$DEST"; then
  recover_transaction
  die "cannot replace binary; previous configuration restored"
fi
sync || die "cannot sync installed files; rerun the installer to restore the previous installation"
rm -f "$TX_DIR/active"
sync || die "cannot sync installation completion"
remove_transaction
say "  installed $DEST"
printf '%s:%s\n' "$SERVICE_NAME" "$INSTALL_DIR" > "$INSTALL_MARKER"
chmod 600 "$INSTALL_MARKER"
say "  wrote $CFG (mode 600 - it holds the token)"

RUN="\"$DEST\" run --config \"$CFG\""

check_unit_paths() {
  printf '%s\n%s' "$DEST" "$CFG" | LC_ALL=C grep -Eq '[^A-Za-z0-9._/ -]' && die "service paths contain characters unsupported by systemd unit quoting"
}

# ---------------------------------------------------------------------------
# 6. Keep it alive, with the best mechanism this host has
# 6. 使用主机提供的最佳机制保活
# ---------------------------------------------------------------------------

set_service_tier() {
  # Rewrite the placeholder written in section 5. sed on a single line of a
  # file this script itself just wrote; the alternative (python3) is not
  # guaranteed on a minimal host, and the merge path below already requires it
  # only when an existing config is being preserved.
  # 重写第 5 节写入的占位符。对本脚本刚写出的文件使用单行 sed；
  # 精简主机不一定有 python3，下方合并路径仅在保留现有配置时才需要它。
  new=$(mktemp "$CFG_DIR/.config-tier.XXXXXX") || die "cannot stage config update in $CFG_DIR"
  sed 's/"service_tier": "[A-Za-z]*"/"service_tier": "'"$1"'"/' "$CFG" > "$new" || { rm -f "$new"; die "cannot rewrite service_tier"; }
  chmod 600 "$new"
  mv -f "$new" "$CFG" || { rm -f "$new"; die "cannot replace service configuration"; }
}

TIER=""
NOTE=""
SERVICE_MANAGER="manual"

if [ "$MODE" = "manual" ]; then
  SERVICE_MANAGER="manual"
  TIER="C"
  set_service_tier "$TIER"
  NOTE="manual mode selected; run $RUN in the foreground"
elif [ "$MODE" = "docker" ]; then
  SERVICE_MANAGER="docker"
  [ "$OS" = "linux" ] || die "Docker mode requires a Linux probe build"
  if [ -e "$DOCKER_DIR" ]; then
    [ -f "$DOCKER_DIR/.$AGENT_NAME-managed" ] && [ "$(cat "$DOCKER_DIR/.$AGENT_NAME-managed")" = "$SERVICE_NAME:$INSTALL_DIR" ] || die "Docker output directory is not owned by this agent: $DOCKER_DIR"
  else
    mkdir -m 700 "$DOCKER_DIR"
    printf '%s:%s\n' "$SERVICE_NAME" "$INSTALL_DIR" > "$DOCKER_DIR/.$AGENT_NAME-managed"
  fi
  cat > "$DOCKER_DIR/Dockerfile" <<DOCKERFILE
FROM alpine:3.20
COPY $AGENT_NAME /usr/local/bin/$AGENT_NAME
ENTRYPOINT ["/usr/local/bin/$AGENT_NAME", "run", "--config", "/etc/$AGENT_NAME/config.json"]
DOCKERFILE
  cp "$DEST" "$DOCKER_DIR/$AGENT_NAME"
  cfg_source=$(printf '%s' "$CFG_DIR" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/[$]/$$/g')
  cfg_mount="        source: \\\"$cfg_source\\\"
        target: /etc/$AGENT_NAME"
  cfg_read_only=""
  cat > "$DOCKER_DIR/compose.yaml" <<COMPOSE
services:
  $SERVICE_NAME:
    build: .
    restart: unless-stopped
    volumes:
      - type: bind
$cfg_mount
$cfg_read_only
COMPOSE
  printf 'config.json\n' > "$DOCKER_DIR/.dockerignore"
  quoted_docker_dir=$(printf '%s' "$DOCKER_DIR" | sed "s/'/'\\\\\\\\''/g")
  docker_command="cd '$quoted_docker_dir' && docker compose up -d --build"
  say "run: $docker_command"
  command -v docker >/dev/null 2>&1 || die "Docker was not found. Run the printed command after installing Docker Compose v2."
  # The container bind-mounts this same config, so the tier must be right
  # before the container starts reading it.
  # 容器绑定挂载同一份配置，所以必须在容器开始读取前设置正确的 tier。
  TIER="A"
  set_service_tier "$TIER"
  (cd "$DOCKER_DIR" && docker compose up -d --build) || die "Docker Compose failed; generated files remain in $DOCKER_DIR"
  NOTE="local Docker image built; container metrics describe its namespace; awaiting first server report"
elif [ "$MODE" = "user" ] && [ "$HAVE_SYSTEMD" = 1 ]; then
  SERVICE_MANAGER="systemd"
  [ "$EFFECTIVE_AUTO_UPDATE" = 0 ] || [ -w "$BIN_DIR" ] || die "automatic updates need write access to $BIN_DIR for the user service"
  check_unit_paths
  user_unit="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME.service"
  [ ! -e "$user_unit" ] || grep -Fxq "$SERVICE_MARKER" "$user_unit" || die "refusing to overwrite existing user service"
  mkdir -p "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  cat > "$user_unit" <<UNIT
$SERVICE_MARKER
[Unit]
Description=Uptime Polaris Agent ($SERVICE_NAME)
After=network-online.target
[Service]
ExecStart=$RUN
Restart=always
[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  set_service_tier "A"
  systemctl --user enable --now "$SERVICE_NAME"
  TIER="A"
  if command -v loginctl >/dev/null 2>&1 && loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    NOTE="registered as a user systemd service with lingering enabled"
  else
    NOTE="registered as a user systemd service; it stops after logout unless lingering is enabled"
  fi
elif [ "$OS" = "darwin" ] && { [ "$MODE" = "user" ] || [ "$MODE" = "system" ] || [ "$MODE" = "auto" ]; }; then
  SERVICE_MANAGER="launchd"
  if [ "$MODE" = "system" ] || { [ "$MODE" = "auto" ] && [ "$IS_ROOT" = 1 ]; }; then
    [ "$IS_ROOT" = 1 ] || die "macOS system mode requires administrator rights"
    PLIST_DIR="/Library/LaunchDaemons"
    DOMAIN="system"
  else
    PLIST_DIR="$HOME/Library/LaunchAgents"
    DOMAIN="gui/$(id -u)"
  fi
  PLIST="$PLIST_DIR/$SERVICE_NAME.plist"
  [ ! -e "$PLIST" ] || grep -Fxq "<!-- $SERVICE_MARKER -->" "$PLIST" || die "refusing to overwrite unrelated launchd job"
  mkdir -p "$PLIST_DIR"
  xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- $SERVICE_MARKER -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$(xml_escape "$SERVICE_NAME")</string>
<key>ProgramArguments</key><array><string>$(xml_escape "$DEST")</string><string>run</string><string>--config</string><string>$(xml_escape "$CFG")</string></array>
<key>StandardOutPath</key><string>$(xml_escape "$LOG_PATH")</string>
<key>StandardErrorPath</key><string>$(xml_escape "$LOG_PATH")</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
PLISTEOF
  set_service_tier "A"
  launchctl bootstrap "$DOMAIN" "$PLIST"
  TIER="A"
  NOTE="registered with launchd ($DOMAIN)"
elif [ "$MODE" = "system" ] && [ "$HAVE_SYSTEMD" = 0 ] && [ "$HAVE_OPENRC" = 0 ] && [ "$HAVE_SUPERVISORD" = 0 ] && [ "$HAVE_S6" = 0 ]; then
  die "system mode requires a supported service manager; use manual mode on this host"
elif [ "$MODE" = "user" ] && [ "$HAVE_SYSTEMD" = 0 ]; then
  die "user mode currently requires Linux systemd --user"
elif [ "$HAVE_SYSTEMD" = 1 ] && [ "$IS_ROOT" = 1 ]; then
  SERVICE_MANAGER="systemd"
  check_unit_paths
  [ ! -e "/etc/systemd/system/$SERVICE_NAME.service" ] || grep -Fxq "$SERVICE_MARKER" "/etc/systemd/system/$SERVICE_NAME.service" || die "refusing to overwrite existing service"
  UNIT_WRITE_PATHS="/run"
  if [ "$EFFECTIVE_AUTO_UPDATE" = 1 ]; then
    escaped_bin_dir=$(printf '%s' "$BIN_DIR" | sed 's/ /\\x20/g')
    UNIT_WRITE_PATHS="$UNIT_WRITE_PATHS $escaped_bin_dir"
  fi
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
$SERVICE_MARKER
[Unit]
Description=Uptime Polaris Agent ($SERVICE_NAME)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$RUN
Restart=always
RestartSec=5
# The probe reads host metrics and nothing else; it needs no privileges and
# no writable filesystem.
# Agent 仅读取主机指标，不需要特权或可写文件系统。
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$UNIT_WRITE_PATHS

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload >/dev/null 2>&1 || true
  # Write the expected tier first: the process may start and read its config
  # before the is-active check below can decide anything.
  # 先写入预期 tier：进程可能在下方 is-active 检查作出判断前启动并读取配置。
  set_service_tier "A"
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  if systemctl is-active "$SERVICE_NAME" >/dev/null 2>&1; then
    TIER="A"
    NOTE="systemd service is running and will start on boot"
  else
    TIER="C"
    set_service_tier "$TIER"
    NOTE="systemd unit was written but did not start; check: journalctl -u $SERVICE_NAME"
  fi

elif [ "$HAVE_OPENRC" = 1 ] && [ "$IS_ROOT" = 1 ]; then
  SERVICE_MANAGER="openrc"
  LOG_PATH="/var/log/$AGENT_NAME.log"
  [ ! -e "/etc/init.d/$SERVICE_NAME" ] || grep -Fxq "$SERVICE_MARKER" "/etc/init.d/$SERVICE_NAME" || die "refusing to overwrite existing service"
  cat > "/etc/init.d/$SERVICE_NAME" <<UNIT
#!/sbin/openrc-run
$SERVICE_MARKER
name="$AGENT_NAME"
command="$DEST"
command_args="run --config \"$CFG\""
command_background=true
pidfile="/run/$AGENT_NAME.pid"
respawn_delay=5
output_log="/var/log/$AGENT_NAME.log"
error_log="/var/log/$AGENT_NAME.log"
depend() { need net; after firewall; }
UNIT
  chmod 755 "/etc/init.d/$SERVICE_NAME"
  rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  set_service_tier "A"
  rc-service "$SERVICE_NAME" start >/dev/null 2>&1 || true
  TIER="A"
  NOTE="openrc service is running and will start on boot"

elif [ "$HAVE_SUPERVISORD" = 1 ] && [ "$IS_ROOT" = 1 ]; then
  SERVICE_MANAGER="supervisord"
  # Container with a supervisor. This is the good case inside a container:
  # supervisord restarts the probe if it dies, and supervisord itself is
  # started by the image, so the probe comes back when the container does.
  # 容器中有管理器时的优选方案：supervisord 在 Agent 退出后重启它，
  # 镜像会启动 supervisord，因此容器重启时 Agent 也会恢复。
  mkdir -p /etc/supervisor/conf.d
  [ ! -e "/etc/supervisor/conf.d/$SERVICE_NAME.conf" ] || grep -Fxq "$SERVICE_MARKER" "/etc/supervisor/conf.d/$SERVICE_NAME.conf" || die "refusing to overwrite existing supervisor program"
  cat > "/etc/supervisor/conf.d/$SERVICE_NAME.conf" <<UNIT
$SERVICE_MARKER
[program:$SERVICE_NAME]
command=$RUN
autostart=true
autorestart=true
startsecs=5
redirect_stderr=true
stdout_logfile=$LOG_PATH
stdout_logfile_maxbytes=5MB
stdout_logfile_backups=2
UNIT
  supervisorctl reread >/dev/null 2>&1 || true
  set_service_tier "A"
  supervisorctl update >/dev/null 2>&1 || true
  supervisorctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
  TIER="A"
  NOTE="registered with supervisord - it restarts the probe if it exits, and the image starts supervisord"

elif [ "$HAVE_S6" = 1 ] && [ "$IS_ROOT" = 1 ]; then
  SERVICE_MANAGER="s6"
  mkdir -p "/etc/services.d/$SERVICE_NAME"
  [ ! -e "/etc/services.d/$SERVICE_NAME/run" ] || grep -Fxq "$SERVICE_MARKER" "/etc/services.d/$SERVICE_NAME/run" || die "refusing to overwrite existing s6 service"
  cat > "/etc/services.d/$SERVICE_NAME/run" <<UNIT
$SERVICE_MARKER
#!/bin/sh
exec $RUN --log-file "$LOG_PATH"
UNIT
  chmod 755 "/etc/services.d/$SERVICE_NAME/run"
  TIER="A"
  set_service_tier "$TIER"
  NOTE="registered with s6-overlay - it will run the probe and restart it"

elif [ "$HAVE_CRON" = 1 ] && [ "$HAVE_SYSTEMD" = 0 ] && [ "$IN_CONTAINER" = 0 ]; then
  SERVICE_MANAGER="cron"
  # Only outside a container: crond inside one is usually not running at all,
  # and even when it is, @reboot fires on the *container's* boot which is not
  # a thing that happens again.
  # 仅在容器外使用：容器内 crond 通常未运行；即使运行，@reboot 也是
  # 在容器启动时触发，而容器本身不会再次经历这种启动。
  ( crontab -l 2>/dev/null | filter_owned_cron ; \
    echo "@reboot $RUN >/dev/null 2>&1 $CRON_MARKER" ) | crontab - 2>/dev/null || true
  TIER="B"
  set_service_tier "B"
  nohup "$DEST" run --config "$CFG" >>"$LOG_PATH" 2>&1 &
  NOTE="started now, and a crontab @reboot entry will start it after a reboot"
fi

if [ -z "$TIER" ]; then
  # Nothing here supervises anything. Start it detached and be honest: this
  # survives the shell exiting, and nothing else.
  # 此处没有管理器；分离启动只能保证进程在 shell 退出后继续运行。
  nohup "$DEST" run --config "$CFG" >>"$LOG_PATH" 2>&1 &
  sleep 2
  if pgrep -f "$DEST" >/dev/null 2>&1; then
    TIER="C"
    set_service_tier "$TIER"
  if [ "$OS" = darwin ]; then
    NOTE="installed without launchd persistence; start manually with: $RUN"
  elif [ "$IS_ROOT" = 0 ]; then
    NOTE="started in the background; no user service manager was available, so it will NOT return after restart"
  else
    NOTE="started in the background; it will NOT come back after this host or container restarts"
  fi
  else
    TIER="D"
    set_service_tier "$TIER"
    NOTE="failed to stay running - run it by hand to see why: $RUN"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Register command and report installation
# 7. 注册命令并报告安装信息
# ---------------------------------------------------------------------------

scope="user"
[ "$IS_ROOT" = 0 ] || scope="system"
[ "$MODE" != user ] || scope="user"
SERVICE_EXTRA_PATH="$DOCKER_DIR/compose.yaml"
if [ "$SERVICE_MANAGER" = launchd ]; then SERVICE_EXTRA_PATH="$PLIST"; fi
"$DEST" record-installation --config "$CFG" --manager "$SERVICE_MANAGER" --service-name "$SERVICE_NAME" --scope "$scope" --mode "$MODE" --install-dir "$INSTALL_DIR" --log-path "$LOG_PATH" --extra-path "$SERVICE_EXTRA_PATH" --user-id "$(id -u)" || die "cannot save installation information"
if [ "$REGISTER_COMMAND" = 1 ]; then
  "$DEST" command register --config "$CFG" --scope "$scope" || die "cannot register the terminal command; use --no-register-command to skip registration"
fi
if [ "$MODE" = manual ]; then
  say "run: $RUN"
elif [ "$REGISTER_COMMAND" = 1 ]; then
  say "manage: ${AGENT_SHORT_COMMAND} status | restart | logs -f"
else
  say "status: \"$DEST\" status --config \"$CFG\""
fi

sleep 1
if [ "$MODE" = manual ]; then
  :
elif pgrep -f "$DEST" >/dev/null 2>&1; then
  say ""
  say "process is running ($DEST); awaiting first report from the server"
else
  say ""
  warn "! probe does not appear to be running"
fi

say ""
say "persistence: tier $TIER"
say "  $NOTE"
case "$TIER" in
  C)
    say ""
    say "  This host has no service manager the installer can use, so the probe"
    say "  runs unsupervised. To keep it running after a restart, do one of:"
    say "    - run it as a container with 'restart: always' / --restart always"
    say "    - give it a supervisor (supervisord, s6) in the image"
    say "    - re-run this installer as root on a host with systemd"
    ;;
  D)
    say ""
    say "  Start it by hand to see the error:"
    say "    $RUN"
    ;;
esac
say ""
if [ "$REGISTER_COMMAND" = 1 ]; then
  if [ "$MODE" = manual ]; then say "run: ${AGENT_SHORT_COMMAND} run"; else
    say "status: ${AGENT_SHORT_COMMAND} status"
    say "restart: ${AGENT_SHORT_COMMAND} restart"
    say "logs: ${AGENT_SHORT_COMMAND} logs -f"
  fi
else
  say "program: $DEST"
  say "configuration: $CFG"
fi
say "remove: sh install.sh --uninstall"
`;
}

/**
 * The Windows installer.
 *
 * Same shape as the POSIX one - probe, plan, fetch, install, report - against
 * what Windows offers: a scheduled task for boot persistence, and a service
 * only if the operator already has a service manager. Kept in PowerShell
 * because that is what is present on every supported version.
 * Windows 安装器沿用 POSIX 的探测、计划、下载、安装和报告流程，适配 Windows
 * 提供的机制：计划任务负责开机保活，仅在管理员已有服务管理器时使用服务。
 * 采用 PowerShell，因为所有受支持的系统版本均提供它。
 */
export function installPs1({ base }: InstallParams): string {
  return `\uFEFF# Uptime Polaris Agent installer for Windows.
# Uptime Polaris Agent Windows 安装器。
#
#   (irm ${base}/api/public/agent/download/install.ps1).TrimStart([char]0xFEFF) | iex
#
# With arguments - note the single dash:
# 带参数时注意使用单个连字符：
#   & ([scriptblock]::Create((irm ${base}/api/public/agent/download/install.ps1).TrimStart([char]0xFEFF))) -Endpoint ${base} -Token <TOKEN>
#
# Remove it again with -Uninstall (single dash too; PowerShell does not take
# the POSIX double-dash form).
# 使用 -Uninstall 卸载（同样是单个连字符；PowerShell 不使用 POSIX 的双连字符形式）。
#
# Needs an elevated shell: installing to Program Files and registering a
# scheduled task both require it.
# 需要以管理员身份运行 shell：安装到 Program Files 和注册计划任务都需要提升权限。

param(
  [string]$Endpoint = ${powershellQuote(base)},
  [string]$Token = "",
  [int]$SampleInterval = 0,
  [int]$ReportInterval = 0,
  [string]$Platform = '',
  [ValidateSet('system','user','manual')][string]$Mode = 'system',
  [string]$IncludeNics = '',
  [string]$ExcludeNics = '',
  [string]$IncludeMounts = '',
  [string]$ExcludeMounts = '',
  [string]$InstallDir = '',
  [string]$ServiceName = 'polaris-agent',
  [switch]$AutoUpdate,
  [switch]$DisableAutoUpdate,
  [switch]$NoRegisterCommand,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# A credential may arrive in the environment instead of the command line. The
# process command line is readable by any user (Get-CimInstance Win32_Process,
# Task Manager's command-line column); the environment block is not. Only fill
# a parameter that was left empty, so an explicit -Token always wins.
# 凭据可以通过环境而非命令行传入。任何用户都可读取进程命令行
# （Get-CimInstance Win32_Process 或任务管理器的命令行列），但不能读取环境块。
# 只填充未提供的参数，显式指定的 -Token 始终优先。
#
# process environment variable, and reusing the name would imply a link that
# does not exist.
# 进程环境变量；复用名称会暗示一个实际上不存在的关联。
if (-not $Token -and $env:POLARIS_AGENT_TOKEN) { $Token = $env:POLARIS_AGENT_TOKEN }

function Say($m)  { Write-Host $m }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Die($m)  { Write-Host $m -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$agentName = 'polaris-agent'

$destDir = if ($InstallDir) { $InstallDir } elseif ($Mode -eq 'system') { Join-Path $env:ProgramFiles $agentName } else { Join-Path $env:LOCALAPPDATA $agentName }
$dest = Join-Path $destDir ($agentName + '.exe')
$cfgDir = if ($Mode -eq 'system') { Join-Path $env:ProgramData $agentName } else { Join-Path $env:LOCALAPPDATA $agentName }
$cfg = Join-Path $cfgDir 'config.json'
$metadata = Join-Path $cfgDir 'install.json'
$logPath = Join-Path $cfgDir 'agent.log'
$marker = Join-Path $cfgDir ('.' + $agentName + '-managed')
if ($ServiceName -notmatch '^[A-Za-z0-9_.@-]+$') { Die 'invalid task name' }
$taskName = $ServiceName

if ($Uninstall) {
  # Reports what was actually there. The first version printed "removed" for
  # both paths unconditionally, so running it on a machine that never had the
  # probe claimed to have cleaned something up.
  # 报告实际存在的路径。最初的版本无条件对两个路径都输出“已删除”，
  # 导致从未安装过 Agent 的机器也显示已清理。
  $found = @()
  $owned = (Test-Path $marker) -and ((Get-Content $marker -Raw) -eq "$taskName|$dest")
  if ($owned) { $found += $dest,$cfg }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and $task.Actions.Execute -eq $dest) { $found += "task $taskName" }

  if ($found.Count -eq 0) {
    Say "nothing to remove - the probe is not installed on this machine"
    exit 0
  }

  if ($owned -and (Test-Path -LiteralPath $metadata) -and (Test-Path -LiteralPath $dest)) {
    & $dest command unregister --config $cfg
    if ($LASTEXITCODE -ne 0) { Die "cannot remove the registered terminal command" }
  }
  Say "removing:"
  foreach ($f in $found) { Say "  $f" }
  if ($task -and $task.Actions.Execute -eq $dest) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  if ($owned) {
    Remove-Item -LiteralPath $dest,$cfg,$marker,$metadata -Force -ErrorAction SilentlyContinue
    Remove-Item $destDir,$cfgDir -Force -ErrorAction SilentlyContinue
  }
  Say ""
  Say "done"
  exit 0
}

Say "Uptime Polaris Agent installer"
Say "  host        : windows/$env:PROCESSOR_ARCHITECTURE"
Say "  elevated    : $(if ($isAdmin) { 'yes' } else { 'no' })"
Say ""

if (-not $isAdmin -and $Mode -eq 'system') {
  Die "needs an elevated PowerShell: installing to Program Files and registering
a scheduled task both require administrator rights.

Open PowerShell as Administrator and run the same command again."
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($Mode -ne 'manual' -and $existingTask -and $existingTask.Actions.Execute -ne $dest) { Die "refusing to overwrite unrelated scheduled task $taskName" }

if (-not $Endpoint) { $Endpoint = ${powershellQuote(base)} }
if (-not $Token) { $Token = Read-Host "Agent token" }
if (-not $Token) { Die "an Agent token is required" }
$effectiveSample = if ($SampleInterval -gt 0) { $SampleInterval } else { 5 }
$effectiveReport = if ($ReportInterval -gt 0) { $ReportInterval } else { 60 }
if ($effectiveSample -lt 1 -or $effectiveReport -lt $effectiveSample -or $effectiveReport -gt 1800) { Die 'require 1 <= sample <= report <= 1800' }

# Detect the architecture. PROCESSOR_ARCHITECTURE reports the *process* arch
# under WOW64, so a 32-bit shell on 64-bit Windows would lie; the env var
# below is the reliable one.
# 检测架构。WOW64 下 PROCESSOR_ARCHITECTURE 报告的是进程架构，
# 因此 64 位 Windows 上的 32 位 shell 会给出错误结果；使用下方环境变量更可靠。
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($arch) {
  'AMD64' { $archKey = 'x86_64' }
  'ARM64' { Die "unsupported platform windows/arm64; supported: linux/x86_64, linux/aarch64, windows/x86_64, darwin/x86_64, darwin/aarch64" }
  default { Die "unsupported architecture: $arch" }
}
$detectedPlatform = "windows-$archKey"
if ($Platform -and $Platform -ne $detectedPlatform) { Die "selected build $Platform does not match this host ($detectedPlatform)" }

$url = "$Endpoint/api/public/agent/download/polaris-agent-windows-$archKey.exe"
Say "  download    : $url"
Say ""
Say "-> downloading"

New-Item -ItemType Directory -Path $destDir -Force | Out-Null
New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
if ((Test-Path $dest) -or (Test-Path $cfg)) {
  if (-not (Test-Path $marker) -or (Get-Content $marker -Raw) -ne "$taskName|$dest") {
    # Names the paths it found and the command that clears them. The bare
    # "ownership marker" sentence sent the operator looking for a file the
    # installer never told them about; the leftover binary and config are what
    # actually block the install.
    # 列出发现的路径以及清理命令。只说“所有权标记”会让管理员寻找一个从未告知的文件；
    # 实际阻止安装的是残留的二进制文件和配置。
    $found = @()
    if (Test-Path $dest) { $found += $dest }
    if (Test-Path $cfg)  { $found += $cfg }
    Die "refusing to overwrite files this installer does not own
  found  : $($found -join ' ')
  marker : $marker (absent or records another install)
  These are leftover files from an earlier install whose marker was removed. Delete them and re-run:
    Remove-Item -Force $($found -join ', ')"
  }
}

$stage = Join-Path $destDir ('.download-' + [Guid]::NewGuid() + '.exe')
try {
  Invoke-WebRequest -Uri $url -OutFile $stage -UseBasicParsing
} catch {
  Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
  Die "download failed: $($_.Exception.Message)

The Agent GitHub repository needs a published stable release with an asset for windows/$archKey.
Also check GitHub network access and API rate limits."
}

# A PE binary starts with 'MZ'. The download route once answered a missing
# binary with the site's HTML, and a web page saved as .exe fails obscurely.
# PE 二进制文件以 'MZ' 开头。下载路由曾在文件缺失时返回网站 HTML，
# 把网页保存为 .exe 会导致难以理解的失败。
$magic = [System.IO.File]::ReadAllBytes($stage)[0..1]
if ($magic[0] -ne 0x4D -or $magic[1] -ne 0x5A) {
  Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
  Die "the downloaded file is not a Windows executable. Report this."
}

# 'MZ' only says the file looks like a Windows program. Compare the release
# manifest's SHA-256 as well: a replaced binary keeps its first two bytes.
# 'MZ' 只能说明文件看起来像 Windows 程序；被替换的二进制文件也可能保留这两个字节，
# 因此还要比较发布清单中的 SHA-256。
#
$expectedSha = ''
foreach ($manifestUrl in @("$Endpoint/api/public/agent/manifest")) {
  try {
    $manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing -TimeoutSec 15
  } catch { continue }
  $entry = @($manifest.platforms) | Where-Object { $_.key -eq "windows-$archKey" } | Select-Object -First 1
  if ($entry -and $entry.sha256 -match '^[a-fA-F0-9]{64}$') { $expectedSha = $entry.sha256; break }
}

if (-not $expectedSha) {
  Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
  Die "release manifest has no valid SHA-256 for windows-$archKey"
} else {
  $actualSha = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash
  if ($actualSha -ne $expectedSha) {
    Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
    Die "sha256 mismatch for windows-$archKey
  expected: $expectedSha
  actual:   $actualSha
The downloaded file is not the build this deployment's manifest describes.
That is a replaced or corrupted binary; refusing to install it."
  }
  Say "  verified    : sha256 $actualSha"
}

# The token goes in a config file rather than the task's arguments: a task
# argument is readable by any user through Get-ScheduledTask / schtasks, and
# it also shows up in the process command line.
# 令牌写入配置文件而不是任务参数：任何用户都可通过 Get-ScheduledTask / schtasks
# 读取任务参数，而且参数还会出现在进程命令行中。
$cfgValues = @{
  endpoint = $Endpoint
}
$cfgValues.token = $Token
if ($AutoUpdate -and $DisableAutoUpdate) { throw 'Choose AutoUpdate or DisableAutoUpdate, not both' }
if ($AutoUpdate) { $cfgValues.auto_update = $true }
if ($DisableAutoUpdate) { $cfgValues.auto_update = $false }
if ($SampleInterval -gt 0 -or $ReportInterval -gt 0) {
  if ($SampleInterval -gt 0) { $cfgValues.sample_interval = $SampleInterval }
  if ($ReportInterval -gt 0) { $cfgValues.report_interval = $ReportInterval }
} elseif (-not (Test-Path $cfg)) {
  $cfgValues.sample_interval = $effectiveSample
  $cfgValues.report_interval = $effectiveReport
}
foreach ($name in @('IncludeNics','ExcludeNics','IncludeMounts','ExcludeMounts')) {
  $value = (Get-Variable $name -ValueOnly)
  if ($value) {
    $key = [regex]::Replace($name, '[A-Z]', { param($m) '_' + $m.Value.ToLower() }).TrimStart('_').ToLower()
    $cfgValues[$key] = @($value.Split(',') | Where-Object { $_ })
  }
}
# Scheduled tasks use an explicit restart handoff.
$cfgValues.service_tier = if ($Mode -eq 'manual') { 'C' } else { 'A' }
$savedValues = @{}
if (Test-Path $cfg) {
  try {
    $saved = Get-Content -Path $cfg -Raw | ConvertFrom-Json
    $allowed = @('endpoint','token','sample_interval','report_interval','include_nics','exclude_nics','include_mounts','exclude_mounts','insecure','auto_update','log_file','runtime_revision','service_tier')
    if ($saved -isnot [PSCustomObject]) { throw 'config must be an object' }
    foreach ($property in $saved.PSObject.Properties) {
      if ($allowed -cnotcontains $property.Name) { throw 'configuration contains unsupported fields' }
      $savedValues[$property.Name] = $property.Value
    }
  } catch {
    Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
    Die 'existing config is invalid; refusing to overwrite it'
  }
}
foreach ($key in $cfgValues.Keys) { $savedValues[$key] = $cfgValues[$key] }
$savedSample = if ($savedValues.ContainsKey('sample_interval')) { $savedValues.sample_interval } else { 5 }
$savedReport = if ($savedValues.ContainsKey('report_interval')) { $savedValues.report_interval } else { 60 }
if ($savedSample -isnot [int] -and $savedSample -isnot [long] -or $savedReport -isnot [int] -and $savedReport -isnot [long] -or $savedSample -lt 1 -or $savedReport -lt $savedSample -or $savedReport -gt 1800) {
  Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
  Die 'existing config has invalid sample/report intervals'
}
$cfgJson = $savedValues | ConvertTo-Json
try { Move-Item -LiteralPath $stage -Destination $dest -Force -ErrorAction Stop }
catch { Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue; Die 'cannot replace Agent binary; stop the running Agent and retry' }
Say "  installed   : $dest"

$cfgStage = Join-Path $cfgDir ('.config-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  $security = New-Object Security.AccessControl.FileSecurity
  $security.SetAccessRuleProtection($true, $false)
  $sids = if ($Mode -eq 'system') { @('S-1-5-18', 'S-1-5-32-544') } else { @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) }
  foreach ($sid in $sids) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    $security.AddAccessRule($rule)
  }
  $stream = New-Object IO.FileStream($cfgStage, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
  try {
    $actual = [IO.File]::GetAccessControl($cfgStage)
    if (-not $actual.AreAccessRulesProtected) { throw 'configuration ACL is inherited' }
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne $sids.Count -or @($rules | Where-Object { $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or $sids -notcontains $_.IdentityReference.Value }).Count) { throw 'configuration ACL is not private' }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($cfgJson)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  if (Test-Path -LiteralPath $cfg) {
    [IO.File]::SetAccessControl($cfg, $security)
    $backup = Join-Path $cfgDir ('.config-backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try { [IO.File]::Replace($cfgStage, $cfg, $backup) }
    finally { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
  }
  else { [IO.File]::Move($cfgStage, $cfg) }
} finally { Remove-Item -LiteralPath $cfgStage -Force -ErrorAction SilentlyContinue }
Set-Content -Path $marker -Value "$taskName|$dest" -NoNewline -Encoding ASCII
Say "  config      : $cfg (private ACL)"

$manager = if ($Mode -eq 'manual') { 'manual' } else { 'windows-task' }
$scope = if ($Mode -eq 'system') { 'system' } else { 'user' }
$recordArgs = @('record-installation', '--config', $cfg, '--manager', $manager, '--service-name', $ServiceName, '--scope', $scope, '--mode', $Mode, '--log-path', $logPath)
if ($InstallDir) { $recordArgs += @('--install-dir', $InstallDir) }
& $dest @recordArgs
if ($LASTEXITCODE -ne 0) { Die "cannot save installation information" }
if (-not $NoRegisterCommand) {
  & $dest command register --config $cfg --scope $scope
  if ($LASTEXITCODE -ne 0) { Die "cannot register the terminal command; use -NoRegisterCommand to skip registration" }
  $registered = (Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json).registration.directory
  if ($registered -and ($env:Path.Split(';') -notcontains $registered)) { $env:Path += ';' + $registered }
}
if ($Mode -eq 'manual') {
  if ($NoRegisterCommand) { Say "manual mode selected; run: & '$($dest.Replace("'", "''"))' run --config '$($cfg.Replace("'", "''"))'" }
  else { Say "manual mode selected; run: ${AGENT_SHORT_COMMAND} run" }
  exit 0
}
Say "-> registering scheduled task"
$action = New-ScheduledTaskAction -Execute $dest -Argument "run --config \`"$cfg\`" --log-file \`"$logPath\`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
if ($Mode -eq 'system') {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Start-Sleep -Seconds 3
$proc = Get-Process $agentName -ErrorAction SilentlyContinue
Say ""
if ($proc) {
  Say "process started (pid $($proc.Id)); awaiting first report from the server"
} else {
  Warn "! probe does not appear to be running"
}

Say ""
Say "persistence: tier A"
if ($Mode -eq 'system') { Say "  a SYSTEM scheduled task starts it at startup" }
else { Say "  a user scheduled task starts it when $env:USERNAME logs in" }
Say ""
$manage = if ($NoRegisterCommand) { "& '" + $dest.Replace("'", "''") + "' --config '" + $cfg.Replace("'", "''") + "'" } else { '${AGENT_SHORT_COMMAND}' }
Say "status:  $manage status"
Say "logs:    $manage logs -f"
Say "stop:    $manage stop"
Say "restart: $manage restart"
Say "remove:  the installer with -Uninstall"
`;
}
