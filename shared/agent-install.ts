export type InstallMode = 'system' | 'user' | 'manual' | 'docker';
export type InstallPlatform = 'linux' | 'darwin' | 'windows';

/** 安装命令生成所需的目标平台、凭据及运行选项。 / Target platform, credentials, and runtime options for the install command. */
export interface InstallCommandOptions {
  operation?: 'install' | 'reinstall';
  detectPlatform?: boolean;
  registerCommand?: boolean;
  platformKey: string;
  endpoint: string;
  token: string;
  mode: InstallMode;
  sampleInterval: number;
  reportInterval: number;
  includeNics?: string;
  excludeNics?: string;
  includeMounts?: string;
  excludeMounts?: string;
  installDir?: string;
  serviceName?: string;
  autoUpdate?: boolean;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function installModesForPlatform(platform: InstallPlatform): InstallMode[] {
  if (platform === 'linux') return ['system', 'user', 'manual', 'docker'];
  return ['system', 'user', 'manual'];
}

export function agentBinaryUrl(downloadBase: string, platformKey: string): string {
  const extension = platformKey.startsWith('windows-') ? '.exe' : '';
  return `${downloadBase}/polaris-agent-${platformKey}${extension}`;
}

export function agentInstallScriptUrl(origin: string, platform: InstallPlatform | 'posix'): string {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('installation requires an HTTP(S) site URL without credentials');
  const file = platform === 'windows' ? 'install.ps1' : 'install.sh';
  return new URL(`/${file}`, url.origin).href;
}

function powershellInstallerBody(scriptUrl: string, credential: string, args: string): string {
  return `$previous = $env:POLARIS_AGENT_TOKEN; $installer = Join-Path ([IO.Path]::GetTempPath()) ('polaris-agent-' + [Guid]::NewGuid() + '.ps1'); try { [IO.File]::WriteAllText($installer, (Invoke-RestMethod -Uri ${powershellQuote(scriptUrl)} -ErrorAction Stop).TrimStart([char]0xFEFF), [Text.UTF8Encoding]::new($true)); $env:POLARIS_AGENT_TOKEN=${credential}; & $installer ${args}; if ($LASTEXITCODE -ne 0) { throw 'Agent installation failed' } } finally { $env:POLARIS_AGENT_TOKEN=$previous; Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }`;
}

export function powershellInstallBootstrap(origin: string): string {
  const scriptUrl = new URL('/api/public/agent/download/install.ps1', origin).href;
  return `param([string]$Token)\nif (-not $Token) { throw 'Agent token is required' }\n${powershellInstallerBody(scriptUrl, '$Token', '@args')}\n`;
}

/** 检查平台与安装模式后生成命令，失败时返回错误文本。 / Validate the platform and install mode, then generate a command or return an error. */
export function safeInstallCommand(
  options: InstallCommandOptions,
  platform: InstallPlatform,
): { command: string | null; error: string | null } {
  try {
    const modes = installModesForPlatform(platform);
    if (!modes.includes(options.mode)) throw new Error(`mode ${options.mode} is unavailable for ${platform}`);
    if (!options.platformKey.startsWith(`${platform}-`)) throw new Error(`build ${options.platformKey} does not match ${platform}`);
    if (platform !== 'windows' && options.installDir &&
        (!options.installDir.startsWith('/') || !/^\/[A-Za-z0-9._/ -]+$/.test(options.installDir))) {
      throw new Error('POSIX install path must be absolute and contain only letters, digits, spaces, ".", "_", "-", or "/"');
    }
    if (options.autoUpdate && options.mode === 'docker') throw new Error('Docker updates require rebuilding and replacing the image');
    if (platform === 'linux' && options.mode === 'system' && options.installDir &&
        /^\/(home|root|run\/user)(\/|$)/.test(options.installDir)) {
      throw new Error('systemd ProtectHome=true hides this install path');
    }
    return { command: buildInstallCommand(options, platform === 'windows' ? 'windows' : 'posix'), error: null };
  } catch (error) {
    return { command: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 按目标 shell 引用参数并生成安装或重装命令。 / Quote arguments for the target shell and generate an install or reinstall command. */
export function buildInstallCommand(options: InstallCommandOptions, platform: 'posix' | 'windows'): string {
  if (!options.endpoint || !options.token || !options.platformKey) throw new Error('platform, endpoint, and an Agent token are required');
  if (!/^[A-Za-z0-9_.@-]+$/.test(options.serviceName ?? 'polaris-agent')) throw new Error('invalid service name');
  if (!Number.isInteger(options.sampleInterval) || options.sampleInterval < 1 ||
      !Number.isInteger(options.reportInterval) || options.reportInterval > 1800 ||
      options.sampleInterval > options.reportInterval) throw new Error('invalid sample/report interval');

  const reinstall = options.operation === 'reinstall';
  const scriptUrl = agentInstallScriptUrl(options.endpoint, platform);
  const origin = new URL(scriptUrl).origin;
  const values: Array<[string, string]> = [
    ['endpoint', reinstall ? origin : ''],
    ['platform', options.detectPlatform ? '' : options.platformKey],
    ['mode', options.mode],
    ['sample-interval', reinstall || options.sampleInterval !== 5 ? String(options.sampleInterval) : ''],
    ['report-interval', reinstall || options.reportInterval !== 60 ? String(options.reportInterval) : ''],
    ['include-nics', options.includeNics ?? ''], ['exclude-nics', options.excludeNics ?? ''],
    ['include-mounts', options.includeMounts ?? ''], ['exclude-mounts', options.excludeMounts ?? ''],
    ['install-dir', options.installDir ?? ''],
    ['service-name', options.serviceName && options.serviceName !== 'polaris-agent' ? options.serviceName : ''],
  ];
  const pairs = values.filter(([, value]) => value !== '');
  const update = options.autoUpdate === true ? true : reinstall && options.autoUpdate === false ? false : undefined;
  const envName = 'POLARIS_AGENT_TOKEN';
  const credential = options.token;
  if (platform === 'posix') {
    const args = pairs.map(([key, value]) => `--${key} ${shellQuote(value)}`).join(' ');
    const flags = (update === true ? ' --auto-update' : update === false ? ' --disable-auto-update' : '') +
      (options.registerCommand === false ? ' --no-register-command' : '');
    return `(installer=$(curl -fsSL ${shellQuote(scriptUrl)}) && ${envName}=${shellQuote(credential)} sh -c "$installer" -- ${args}${flags})`;
  }
  const args = pairs.map(([key, value]) => `-${key.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())} ${powershellQuote(value)}`).join(' ');
  const flags = (update === true ? ' -AutoUpdate' : update === false ? ' -DisableAutoUpdate' : '') +
    (options.registerCommand === false ? ' -NoRegisterCommand' : '');
  return `& ([scriptblock]::Create((irm ${powershellQuote(scriptUrl)} -ErrorAction Stop))) ${powershellQuote(credential)} ${args}${flags}`;
}

export interface AgentBuild { key: string; version: string; }

export function groupAgentBuilds(builds: AgentBuild[]) {
  return (['linux', 'windows', 'darwin'] as const).flatMap((os) => {
    const matches = builds.filter((build) => build.key.startsWith(`${os}-`));
    if (matches.length === 0) return [];
    const name = { linux: 'Linux', windows: 'Windows', darwin: 'macOS' }[os];
    return [{
      os,
      key: os,
      downloadKey: matches[0].key,
      label: `${name} · ${matches.map((build) => build.key.slice(os.length + 1)).join(' / ')}`,
      version: matches[0].version,
      builds: matches,
    }];
  });
}
