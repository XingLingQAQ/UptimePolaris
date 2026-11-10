# Uptime Polaris Agent installer for Windows.
# Uptime Polaris Agent Windows 安装器。
#
#   (irm POLARIS_ORIGIN_PLACEHOLDER/api/public/agent/download/install.ps1).TrimStart([char]0xFEFF) | iex
#
# With arguments - note the single dash:
# 带参数时注意使用单个连字符：
#   & ([scriptblock]::Create((irm POLARIS_ORIGIN_PLACEHOLDER/api/public/agent/download/install.ps1).TrimStart([char]0xFEFF))) -Endpoint POLARIS_ORIGIN_PLACEHOLDER -Token <TOKEN>
#
# Remove it again with -Uninstall (single dash too; PowerShell does not take
# the POSIX double-dash form).
# 使用 -Uninstall 卸载（同样是单个连字符；PowerShell 不使用 POSIX 的双连字符形式）。
#
# Needs an elevated shell: installing to Program Files and registering a
# scheduled task both require it.
# 需要以管理员身份运行 shell：安装到 Program Files 和注册计划任务都需要提升权限。

param(
  [string]$Endpoint = 'POLARIS_ORIGIN_PLACEHOLDER',
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

if (-not $Endpoint) { $Endpoint = 'POLARIS_ORIGIN_PLACEHOLDER' }
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
  else { Say "manual mode selected; run: pa run" }
  exit 0
}
Say "-> registering scheduled task"
$action = New-ScheduledTaskAction -Execute $dest -Argument "run --config `"$cfg`" --log-file `"$logPath`""
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
$manage = if ($NoRegisterCommand) { "& '" + $dest.Replace("'", "''") + "' --config '" + $cfg.Replace("'", "''") + "'" } else { 'pa' }
Say "status:  $manage status"
Say "logs:    $manage logs -f"
Say "stop:    $manage stop"
Say "restart: $manage restart"
Say "remove:  the installer with -Uninstall"
