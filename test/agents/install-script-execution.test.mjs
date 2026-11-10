// 在隔离目录执行安装脚本，验证替换、归属与校验失败。
// Run installers in isolated directories to check replacement, ownership, and verification failures.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: "export { installSh, installPs1 } from './backends/worker/src/lib/agent/install-script.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { installSh, installPs1 } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const tempParent = realpathSync.native(tmpdir());
const temp = realpathSync.native(mkdtempSync(join(tempParent, 'polaris-installer-execution-')));
const tempRelative = relative(tempParent, temp);
assert.ok(tempRelative && !isAbsolute(tempRelative) && tempRelative !== '..' && !tempRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));

function run(program, args, options = {}) {
  return spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options });
}

function requireSuccess(result) {
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Model only Compose's $VAR, ${VAR} and $$ interpolation to check literal path escaping.
// 仅模拟 Compose 的 $VAR、${VAR} 和 $$ 替换，用于检查路径字面量转义。
function composeInterpolate(value, variables) {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    if (match === '$$') return '$';
    return variables[braced ?? plain] ?? '';
  });
}

function assertFixtureDirectory(directory) {
  const resolved = realpathSync.native(directory);
  const location = relative(temp, resolved);
  assert.ok(location && !isAbsolute(location) && location !== '..' && !location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  return resolved;
}

// Redirect profile and temporary paths into the fixture to isolate installer config writes.
// 把用户目录和临时目录指向夹具内，隔离安装器的配置写入。
function windowsFixtureEnvironment(home, local, temporary) {
  const roaming = join(home, 'roaming');
  mkdirSync(roaming, { recursive: true });
  return {
    ...process.env,
    HOME: assertFixtureDirectory(home),
    USERPROFILE: assertFixtureDirectory(home),
    LOCALAPPDATA: assertFixtureDirectory(local),
    APPDATA: assertFixtureDirectory(roaming),
    TEMP: assertFixtureDirectory(temporary),
    TMP: assertFixtureDirectory(temporary),
  };
}

// Source the generated script through a wrapper with local downloads and logging service stubs.
// 用包装器执行生成的脚本，下载读取本地文件，服务命令只记录调用。
async function posixInstallFixture() {
  const root = join(temp, 'posix');
  mkdirSync(root);
  const nativeRoot = realpathSync.native(root);
  const drive = nativeRoot.match(/^([A-Za-z]):[\\/](.*)$/);
  const shellRoot = process.platform === 'win32'
    ? `/${drive?.[1].toLowerCase()}/${drive?.[2].replaceAll('\\', '/')}`
    : nativeRoot;
  if (process.platform === 'win32') assert.ok(drive, `expected a local drive path: ${nativeRoot}`);
  assert.match(shellRoot, /^\//);
  if (process.platform === 'win32') {
    const nativePwd = run('sh', ['-c', 'cd "$FIXTURE_ROOT" && pwd -W'], { cwd: root, env: { ...process.env, TEMP: root, TMP: root, FIXTURE_ROOT: shellRoot } });
    requireSuccess(nativePwd);
    assert.equal(realpathSync.native(nativePwd.stdout.trim()).toLowerCase(), nativeRoot.toLowerCase());
  } else {
    assert.equal(realpathSync.native(shellRoot), nativeRoot);
  }

  const installer = join(root, 'install.sh');
  const wrapper = join(root, 'wrapper.sh');
  const binary = join(root, 'fixture-agent');
  const manifest = join(root, 'manifest.json');
  const agent = Buffer.from('MZ=1\nprintf "%s\\n" "$*" >> "$FIXTURE_AGENT_LOG"\nexit 0\n');
  const generated = installSh({ base: 'https://host.test' });
  writeFileSync(installer, generated);
  writeFileSync(binary, agent);
  // FIXTURE_FAIL_BACKUP / FIXTURE_FAIL_BINARY_MOVE inject backup and binary-move failures.
  // FIXTURE_CHECK_RECOVERY / FIXTURE_CHECK_ABSENT verify recovery before download; FIXTURE_FORBID_FETCH blocks downloads.
  // FIXTURE_PAUSE_AFTER_CONFIG pauses after config replacement.
  // 这些 FIXTURE_* 变量分别注入备份、替换、恢复检查、下载和配置替换后的暂停。
  writeFileSync(wrapper, `
${process.platform === 'win32' ? 'python3() { command python "$@"; }' : ''}
curl() {
  [ "\${FIXTURE_FORBID_FETCH:-0}" != 1 ] || return 94
  if [ "\${FIXTURE_CHECK_ABSENT:-0}" = 1 ]; then
    [ ! -e "$FIXTURE_INSTALL/config/config.json" ] && [ ! -e "$FIXTURE_INSTALL/bin/polaris-agent" ] || return 95
  fi
  if [ "\${FIXTURE_CHECK_RECOVERY:-0}" = 1 ]; then
    cmp "$FIXTURE_OLD_CONFIG" "$FIXTURE_INSTALL/config/config.json" || return 91
    cmp "$FIXTURE_OLD_BINARY" "$FIXTURE_INSTALL/bin/polaris-agent" || return 92
    [ ! -e "$FIXTURE_INSTALL/config/.polaris-agent-transaction" ] || return 93
  fi
  [ "$#" -eq 4 ] && [ "$1" = -fsSL ] && [ "$3" = -o ] || return 2
  case "$2" in
    https://host.test/api/public/agent/download/polaris-agent-linux-x86_64) cp "$FIXTURE_BINARY" "$4" ;;
    https://host.test/api/public/agent/manifest) cp "$FIXTURE_MANIFEST" "$4" ;;
    *) return 2 ;;
  esac
}
uname() { case "$1" in -s) printf 'Linux\\n' ;; -m) printf 'x86_64\\n' ;; *) return 2 ;; esac; }
id() { case "$1" in -u) printf '1001\\n' ;; -un) printf 'fixture\\n' ;; *) return 2 ;; esac; }
mktemp() { if [ "$#" -eq 0 ]; then command mktemp "$FIXTURE_TMP/download.XXXXXX"; else command mktemp "$@"; fi; }
cp() {
  case "$*" in
    *'/config.json '*'/config/.polaris-agent-transaction/config')
      if [ "\${FIXTURE_FAIL_BACKUP:-0}" = 1 ]; then return 1; fi ;;
  esac
  command cp "$@"
}
mv() {
  case "$*" in
    *'.polaris-agent.'*' /'*'/bin/polaris-agent')
      if [ "\${FIXTURE_FAIL_BINARY_MOVE:-0}" = 1 ]; then return 1; fi ;;
  esac
  command mv "$@" || return $?
  case "$*" in
    *'.config-merged.'*'/config/config.json')
      if [ "\${FIXTURE_PAUSE_AFTER_CONFIG:-0}" = 1 ]; then
        : > "$FIXTURE_READY"
        while [ ! -f "$FIXTURE_RELEASE" ]; do command sleep 0.1; done
      fi ;;
  esac
}
systemctl() { printf 'systemctl %s\\n' "$*" >> "$FIXTURE_SERVICE_LOG"; return 1; }
rc-update() { printf 'unexpected rc-update\\n' >> "$FIXTURE_SERVICE_LOG"; return 1; }
rc-service() { printf 'unexpected rc-service\\n' >> "$FIXTURE_SERVICE_LOG"; return 1; }
supervisorctl() { printf 'unexpected supervisorctl\\n' >> "$FIXTURE_SERVICE_LOG"; return 1; }
crontab() { printf 'unexpected crontab\\n' >> "$FIXTURE_SERVICE_LOG"; return 1; }
launchctl() { printf 'unexpected launchctl\\n' >> "$FIXTURE_SERVICE_LOG"; return 1; }
nohup() { printf 'unexpected nohup\\n' >> "$FIXTURE_SERVICE_LOG"; return 1; }
docker() { printf 'docker %s\\n' "$*" >> "$FIXTURE_SERVICE_LOG"; }
pgrep() { return 1; }
sleep() { :; }
for name in curl systemctl rc-update rc-service supervisorctl crontab launchctl nohup docker; do
  [ "$(command -v "$name")" = "$name" ] || exit 90
done
set -- --endpoint https://host.test --token fixture-token --platform linux-x86_64 --mode docker --service-name fixture-agent --no-register-command
if [ -n "\${FIXTURE_INSTALL:-}" ]; then set -- "$@" --install-dir "$FIXTURE_INSTALL"; fi
if [ "\${FIXTURE_UNINSTALL:-0}" = 1 ]; then set -- "$@" --uninstall; fi
. "$FIXTURE_INSTALLER"
`);

  const quotedDir = join(root, "directory with 'quote'");
  mkdirSync(quotedDir);
  const dockerCommand = generated.split('\n').find(line => line.trimStart().startsWith('docker_command='));
  const quotedDockerDir = generated.split('\n').find(line => line.trimStart().startsWith('quoted_docker_dir='));
  assert.ok(dockerCommand);
  assert.ok(quotedDockerDir);
  const quoteScript = join(root, 'quote.sh');
  writeFileSync(quoteScript, `docker() { [ "$*" = 'compose up -d --build' ]; }\nDOCKER_DIR="$FIXTURE_QUOTED_DIR"\n${quotedDockerDir}\n${dockerCommand}\neval "$docker_command"\n`);
  const quoteResult = run('sh', [quoteScript], { env: { ...process.env, FIXTURE_QUOTED_DIR: `${shellRoot}/directory with 'quote'` } });
  requireSuccess(quoteResult);

  const sourceLine = generated.split('\n').find(line => line.trimStart().startsWith('cfg_source='));
  assert.ok(sourceLine);
  const yamlPath = 'fixture "quoted" \\ path $FIXTURE_INJECT';
  const yamlScript = join(root, 'yaml-escape.sh');
  writeFileSync(yamlScript, `CFG_DIR="$FIXTURE_YAML_PATH"\n${sourceLine}\nprintf '%s' "$cfg_source"\n`);
  const escaped = run('sh', [yamlScript], { env: { ...process.env, FIXTURE_YAML_PATH: yamlPath } });
  requireSuccess(escaped);
  assert.equal(escaped.stdout, 'fixture \\"quoted\\" \\\\ path $$FIXTURE_INJECT');

  // recovery-* seeds interrupted transactions; the download stub checks restoration before serving files.
  // recovery-* 预置未完成事务，下载桩先检查旧配置和二进制已恢复。
  for (const name of ['bad-hash', 'success', 'binary-move-failure', 'backup-failure', 'recovery-bad-hash', 'recovery-success', 'recovery-after-both']) {
    const validHash = !name.includes('bad-hash');
    const recovery = name.startsWith('recovery-');
    const fixture = join(root, name);
    const install = join(fixture, 'install');
    const binDir = join(install, 'bin');
    const cfgDir = join(install, 'config');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    const oldBinary = Buffer.from('previous binary');
    const oldConfig = JSON.stringify({ endpoint: 'https://old.test', token: 'old-token', sample_interval: 5, report_interval: 60 });
    writeFileSync(join(binDir, 'polaris-agent'), oldBinary);
    writeFileSync(join(cfgDir, 'config.json'), oldConfig);
    writeFileSync(join(cfgDir, '.polaris-agent-managed'), `fixture-agent:${shellRoot}/${name}/install\n`);
    const expectedConfig = join(fixture, 'expected-config');
    const expectedBinary = join(fixture, 'expected-binary');
    if (recovery) {
      const transaction = join(cfgDir, '.polaris-agent-transaction');
      mkdirSync(transaction);
      writeFileSync(join(transaction, 'config'), oldConfig);
      writeFileSync(join(transaction, 'binary'), oldBinary);
      writeFileSync(join(transaction, 'active'), 'present:present\n');
      if (name === 'recovery-success') {
        const lock = join(binDir, '.polaris-agent-install.lock');
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), '2147483647\n');
      }
      writeFileSync(expectedConfig, oldConfig);
      writeFileSync(expectedBinary, oldBinary);
      writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ endpoint: 'https://new.test', token: 'new-token' }));
      if (name === 'recovery-after-both') writeFileSync(join(binDir, 'polaris-agent'), agent);
    }
    writeFileSync(manifest, JSON.stringify({ platforms: [{ key: 'linux-x86_64', sha256: validHash ? sha256(agent) : '0'.repeat(64) }] }));
    assertFixtureDirectory(fixture);
    assertFixtureDirectory(install);
    const env = { ...process.env, HOME: `${shellRoot}/${name}`, XDG_CONFIG_HOME: `${shellRoot}/${name}/xdg`, TEMP: fixture, TMP: fixture, TMPDIR: `${shellRoot}/${name}`, FIXTURE_TMP: `${shellRoot}/${name}`, FIXTURE_INSTALL: `${shellRoot}/${name}/install`, FIXTURE_BINARY: `${shellRoot}/fixture-agent`, FIXTURE_MANIFEST: `${shellRoot}/manifest.json`, FIXTURE_INSTALLER: `${shellRoot}/install.sh`, FIXTURE_AGENT_LOG: `${shellRoot}/${name}/agent.log`, FIXTURE_SERVICE_LOG: `${shellRoot}/${name}/services.log`, FIXTURE_FAIL_BINARY_MOVE: name === 'binary-move-failure' ? '1' : '0', FIXTURE_FAIL_BACKUP: name === 'backup-failure' ? '1' : '0', FIXTURE_CHECK_RECOVERY: recovery ? '1' : '0', FIXTURE_OLD_CONFIG: `${shellRoot}/${name}/expected-config`, FIXTURE_OLD_BINARY: `${shellRoot}/${name}/expected-binary` };
    const result = run('sh', [wrapper], { env });
    const serviceLogPath = join(fixture, 'services.log');
    const serviceLog = existsSync(serviceLogPath) ? readFileSync(serviceLogPath, 'utf8') : '';
    assert.doesNotMatch(serviceLog, /unexpected|systemctl (?!is-system-running)/);
    assert.equal(existsSync(join(cfgDir, '.polaris-agent-transaction')), false, 'completed transaction is removed');
    assert.equal(existsSync(join(binDir, '.polaris-agent-install.lock')), false, 'installer lock is removed');
    assert.equal(existsSync(join(binDir, '.polaris-agent-install.gate')), false, 'installer lock gate is removed');
    if (recovery) assert.match(result.stdout, /recovered previous installation/);
    if (!validHash) {
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /sha256 mismatch/);
      assert.deepEqual(readFileSync(join(binDir, 'polaris-agent')), oldBinary);
      assert.equal(readFileSync(join(cfgDir, 'config.json'), 'utf8'), oldConfig);
      assert.doesNotMatch(serviceLog, /docker /);
      assert.equal(existsSync(join(fixture, 'agent.log')), false);
      continue;
    }
    if (name === 'backup-failure') {
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /cannot back up config/);
      assert.deepEqual(readFileSync(join(binDir, 'polaris-agent')), oldBinary);
      assert.equal(readFileSync(join(cfgDir, 'config.json'), 'utf8'), oldConfig);
      assert.doesNotMatch(serviceLog, /docker /);
      continue;
    }
    if (name === 'binary-move-failure') {
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /previous configuration restored/);
      assert.deepEqual(readFileSync(join(binDir, 'polaris-agent')), oldBinary);
      assert.equal(readFileSync(join(cfgDir, 'config.json'), 'utf8'), oldConfig);
      assert.doesNotMatch(serviceLog, /docker /);
      continue;
    }
    assert.equal(readdirSync(fixture).some(name => name.startsWith('polaris-agent.')), false, 'private download directory removed');
    requireSuccess(result);
    assert.deepEqual(readFileSync(join(binDir, 'polaris-agent')), agent);
    assert.match(serviceLog, /^docker compose up -d --build$/m);
    const config = JSON.parse(readFileSync(join(cfgDir, 'config.json'), 'utf8'));
    assert.equal(config.service_tier, 'A');
    assert.equal(config.token, 'fixture-token');
    assert.match(readFileSync(join(fixture, 'agent.log'), 'utf8'), /record-installation .*--manager docker .*--mode docker/);
    const compose = readFileSync(join(cfgDir, 'docker-fixture-agent', 'compose.yaml'), 'utf8');
    assert.match(compose, /fixture-agent:/);
    assert.ok(compose.includes(`source: "${shellRoot}/${name}/install/config"`), compose);
    assert.match(result.stdout, /run: cd '.*docker-fixture-agent' && docker compose up -d --build/);
  }

  {
    // Pause after the first config replacement; a competing installer must refuse without rolling back its transaction.
    // 首次配置替换后暂停，竞争安装器须拒绝，不能回滚仍在执行的事务。
    const name = 'concurrent-install';
    const fixture = join(root, name);
    const install = join(fixture, 'install');
    const binDir = join(install, 'bin');
    const cfgDir = join(install, 'config');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    const oldBinary = Buffer.from('previous binary');
    const oldConfig = JSON.stringify({ endpoint: 'https://old.test', token: 'old-token', sample_interval: 5, report_interval: 60 });
    writeFileSync(join(binDir, 'polaris-agent'), oldBinary);
    writeFileSync(join(cfgDir, 'config.json'), oldConfig);
    writeFileSync(join(cfgDir, '.polaris-agent-managed'), `fixture-agent:${shellRoot}/${name}/install\n`);
    writeFileSync(manifest, JSON.stringify({ platforms: [{ key: 'linux-x86_64', sha256: sha256(agent) }] }));
    const env = { ...process.env, HOME: `${shellRoot}/${name}`, XDG_CONFIG_HOME: `${shellRoot}/${name}/xdg`, TEMP: fixture, TMP: fixture, TMPDIR: `${shellRoot}/${name}`, FIXTURE_TMP: `${shellRoot}/${name}`, FIXTURE_INSTALL: `${shellRoot}/${name}/install`, FIXTURE_BINARY: `${shellRoot}/fixture-agent`, FIXTURE_MANIFEST: `${shellRoot}/manifest.json`, FIXTURE_INSTALLER: `${shellRoot}/install.sh`, FIXTURE_AGENT_LOG: `${shellRoot}/${name}/agent.log`, FIXTURE_SERVICE_LOG: `${shellRoot}/${name}/services.log`, FIXTURE_PAUSE_AFTER_CONFIG: '1', FIXTURE_READY: `${shellRoot}/${name}/ready`, FIXTURE_RELEASE: `${shellRoot}/${name}/release` };
    const first = spawn('sh', [wrapper], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    first.stdout.on('data', chunk => { output += chunk.toString(); });
    first.stderr.on('data', chunk => { output += chunk.toString(); });
    let finished = false;
    const completion = new Promise((resolve, reject) => {
      first.on('error', reject);
      first.on('exit', code => { finished = true; resolve(code); });
    });
    try {
      const deadline = Date.now() + 90_000;
      while (!existsSync(join(fixture, 'ready')) && !finished && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(existsSync(join(fixture, 'ready')), `first installer did not reach transaction: ${output}`);
      assert.equal(existsSync(join(cfgDir, '.polaris-agent-transaction', 'active')), true);
      const updatedConfig = readFileSync(join(cfgDir, 'config.json'), 'utf8');
      const second = run('sh', [wrapper], { env: { ...env, FIXTURE_PAUSE_AFTER_CONFIG: '0' } });
      assert.notEqual(second.status, 0);
      assert.match(`${second.stdout}\n${second.stderr}`, /another installer is running/);
      assert.equal(readFileSync(join(cfgDir, 'config.json'), 'utf8'), updatedConfig);
      assert.deepEqual(readFileSync(join(binDir, 'polaris-agent')), oldBinary);
      assert.equal(existsSync(join(cfgDir, '.polaris-agent-transaction', 'active')), true);
      writeFileSync(join(fixture, 'release'), 'continue');
      assert.equal(await completion, 0, output);
      assert.deepEqual(readFileSync(join(binDir, 'polaris-agent')), agent);
      assert.equal(existsSync(join(binDir, '.polaris-agent-install.lock')), false);
      assert.equal(existsSync(join(cfgDir, '.polaris-agent-transaction')), false);
    } finally {
      if (!finished) {
        writeFileSync(join(fixture, 'release'), 'continue');
        await completion;
      }
    }
  }

  {
    const name = 'uninstall-with-transaction';
    const fixture = join(root, name);
    const install = join(fixture, 'install');
    const binDir = join(install, 'bin');
    const cfgDir = join(install, 'config');
    const transaction = join(cfgDir, '.polaris-agent-transaction');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(transaction, { recursive: true });
    const oldBinary = Buffer.from('previous binary');
    const oldConfig = JSON.stringify({ endpoint: 'https://old.test', token: 'old-token', sample_interval: 5, report_interval: 60 });
    const interruptedConfig = JSON.stringify({ endpoint: 'https://new.test', token: 'new-token' });
    writeFileSync(join(binDir, 'polaris-agent'), oldBinary);
    writeFileSync(join(cfgDir, 'config.json'), interruptedConfig);
    writeFileSync(join(cfgDir, '.polaris-agent-managed'), `fixture-agent:${shellRoot}/${name}/install\n`);
    writeFileSync(join(transaction, 'binary'), oldBinary);
    writeFileSync(join(transaction, 'config'), oldConfig);
    writeFileSync(join(transaction, 'active'), 'present:present\n');
    writeFileSync(manifest, JSON.stringify({ platforms: [{ key: 'linux-x86_64', sha256: sha256(agent) }] }));
    const env = { ...process.env, HOME: `${shellRoot}/${name}`, XDG_CONFIG_HOME: `${shellRoot}/${name}/xdg`, TEMP: fixture, TMP: fixture, TMPDIR: `${shellRoot}/${name}`, FIXTURE_TMP: `${shellRoot}/${name}`, FIXTURE_INSTALL: `${shellRoot}/${name}/install`, FIXTURE_BINARY: `${shellRoot}/fixture-agent`, FIXTURE_MANIFEST: `${shellRoot}/manifest.json`, FIXTURE_INSTALLER: `${shellRoot}/install.sh`, FIXTURE_AGENT_LOG: `${shellRoot}/${name}/agent.log`, FIXTURE_SERVICE_LOG: `${shellRoot}/${name}/services.log` };
    const refused = run('sh', [wrapper], { env: { ...env, FIXTURE_UNINSTALL: '1' } });
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /unfinished installation transaction/);
    assert.equal(readFileSync(join(cfgDir, 'config.json'), 'utf8'), interruptedConfig);
    assert.equal(readFileSync(join(transaction, 'config'), 'utf8'), oldConfig);
    assert.equal(existsSync(join(cfgDir, '.polaris-agent-managed')), true);
    const resumed = run('sh', [wrapper], { env });
    requireSuccess(resumed);
    assert.match(resumed.stdout, /recovered previous installation/);
    assert.equal(existsSync(transaction), false);
    const uninstalled = run('sh', [wrapper], { env: { ...env, FIXTURE_UNINSTALL: '1' } });
    requireSuccess(uninstalled);
    assert.equal(existsSync(join(binDir, 'polaris-agent')), false);
    assert.equal(existsSync(join(cfgDir, 'config.json')), false);
    assert.equal(existsSync(transaction), false);
  }

  for (const scenario of ['recovery-new-install', 'recovery-missing-backup']) {
    const fixture = join(root, scenario);
    const install = join(fixture, 'install');
    const binDir = join(install, 'bin');
    const cfgDir = join(install, 'config');
    const transaction = join(cfgDir, '.polaris-agent-transaction');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(transaction, { recursive: true });
    writeFileSync(join(cfgDir, '.polaris-agent-managed'), `fixture-agent:${shellRoot}/${scenario}/install\n`);
    writeFileSync(join(cfgDir, 'config.json'), '{"token":"partial"}');
    writeFileSync(join(binDir, 'polaris-agent'), 'partial binary');
    if (scenario === 'recovery-new-install') {
      writeFileSync(join(transaction, 'active'), 'absent:absent\n');
      writeFileSync(manifest, JSON.stringify({ platforms: [{ key: 'linux-x86_64', sha256: '0'.repeat(64) }] }));
    } else {
      writeFileSync(join(transaction, 'active'), 'present:present\n');
      writeFileSync(join(transaction, 'config'), '{"token":"old"}');
    }
    const env = { ...process.env, HOME: `${shellRoot}/${scenario}`, XDG_CONFIG_HOME: `${shellRoot}/${scenario}/xdg`, TEMP: fixture, TMP: fixture, TMPDIR: `${shellRoot}/${scenario}`, FIXTURE_TMP: `${shellRoot}/${scenario}`, FIXTURE_INSTALL: `${shellRoot}/${scenario}/install`, FIXTURE_BINARY: `${shellRoot}/fixture-agent`, FIXTURE_MANIFEST: `${shellRoot}/manifest.json`, FIXTURE_INSTALLER: `${shellRoot}/install.sh`, FIXTURE_AGENT_LOG: `${shellRoot}/${scenario}/agent.log`, FIXTURE_SERVICE_LOG: `${shellRoot}/${scenario}/services.log`, FIXTURE_CHECK_ABSENT: scenario === 'recovery-new-install' ? '1' : '0', FIXTURE_FORBID_FETCH: scenario === 'recovery-missing-backup' ? '1' : '0' };
    const first = run('sh', [wrapper], { env });
    assert.notEqual(first.status, 0);
    if (scenario === 'recovery-missing-backup') {
      assert.match(`${first.stdout}\n${first.stderr}`, /transaction binary backup is missing/);
      assert.equal(readFileSync(join(binDir, 'polaris-agent'), 'utf8'), 'partial binary');
      assert.equal(readFileSync(join(cfgDir, 'config.json'), 'utf8'), '{"token":"partial"}');
      assert.equal(existsSync(join(transaction, 'active')), true);
    } else {
      assert.match(`${first.stdout}\n${first.stderr}`, /sha256 mismatch/);
      assert.equal(existsSync(join(binDir, 'polaris-agent')), false);
      assert.equal(existsSync(join(cfgDir, 'config.json')), false);
      assert.equal(existsSync(transaction), false);
      writeFileSync(manifest, JSON.stringify({ platforms: [{ key: 'linux-x86_64', sha256: sha256(agent) }] }));
      const retry = run('sh', [wrapper], { env: { ...env, FIXTURE_CHECK_ABSENT: '0' } });
      requireSuccess(retry);
      assert.deepEqual(readFileSync(join(binDir, 'polaris-agent')), agent);
      assert.equal(JSON.parse(readFileSync(join(cfgDir, 'config.json'), 'utf8')).token, 'fixture-token');
    }
  }

  const complexName = process.platform === 'win32'
    ? "home $FIXTURE_INJECT 'quote' space"
    : "home $FIXTURE_INJECT 'quote' space \\ backslash";
  const complexHome = join(root, complexName);
  const complexHomePosix = `${shellRoot}/${complexName}`;
  mkdirSync(complexHome);
  assertFixtureDirectory(complexHome);
  writeFileSync(manifest, JSON.stringify({ platforms: [{ key: 'linux-x86_64', sha256: sha256(agent) }] }));
  const complexEnv = { ...process.env, HOME: complexHomePosix, XDG_CONFIG_HOME: `${complexHomePosix}/.config`, TEMP: complexHome, TMP: complexHome, TMPDIR: complexHomePosix, FIXTURE_TMP: complexHomePosix, FIXTURE_BINARY: `${shellRoot}/fixture-agent`, FIXTURE_MANIFEST: `${shellRoot}/manifest.json`, FIXTURE_INSTALLER: `${shellRoot}/install.sh`, FIXTURE_AGENT_LOG: `${shellRoot}/complex-agent.log`, FIXTURE_SERVICE_LOG: `${shellRoot}/complex-services.log`, FIXTURE_INJECT: 'incorrectly-expanded' };
  delete complexEnv.FIXTURE_INSTALL;
  const complex = run('sh', [wrapper], { env: complexEnv });
  requireSuccess(complex);
  const complexCompose = readFileSync(join(complexHome, '.config', 'polaris-agent', 'docker-fixture-agent', 'compose.yaml'), 'utf8');
  const source = complexCompose.match(/^\s*source: (".*")$/m)?.[1];
  assert.ok(source, complexCompose);
  const yamlValue = JSON.parse(source);
  assert.ok(yamlValue.includes('$$FIXTURE_INJECT'));
  assert.equal(composeInterpolate(yamlValue, complexEnv), `${complexHomePosix}/.config/polaris-agent`);
}

// Compile a logging PE stub; intercept downloads and tasks but keep real file replacement and ACL setup.
// 编译仅记录参数的 PE 桩，拦截下载和计划任务，文件替换与 ACL 设置实际执行。
function windowsInstallFixture() {
  if (process.platform !== 'win32') {
    console.log('SKIP generated Windows installer execution: requires Windows PowerShell and Windows identity');
    return;
  }
  const root = join(temp, 'windows');
  mkdirSync(root);
  const compiler = join(root, 'compile.ps1');
  const source = join(root, 'fixture.cs');
  const binary = join(root, 'fixture-agent.exe');
  const installer = join(root, 'install.ps1');
  const wrapper = join(root, 'wrapper.ps1');
  writeFileSync(source, `using System; using System.IO;
public static class FixtureAgent {
  public static int Main(string[] args) {
    File.AppendAllText(Environment.GetEnvironmentVariable("FIXTURE_AGENT_LOG"), string.Join(" ", args) + Environment.NewLine);
    return 0;
  }
}`);
  writeFileSync(compiler, "Add-Type -TypeDefinition (Get-Content -LiteralPath $args[0] -Raw) -OutputAssembly $args[1] -OutputType ConsoleApplication -ErrorAction Stop\n");
  const compile = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', compiler, source, binary], { env: windowsFixtureEnvironment(root, root, root) });
  requireSuccess(compile);
  const agent = readFileSync(binary);
  assert.deepEqual([...agent.subarray(0, 2)], [0x4d, 0x5a]);
  writeFileSync(installer, installPs1({ base: 'https://host.test' }), 'utf8');
  // FIXTURE_FAIL_ACL makes New-Object throw during ACL setup to test failure before config commit.
  // FIXTURE_FAIL_ACL 让 New-Object 在权限初始化时抛错，验证配置提交前的失败处理。
  writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing)
  if ($Uri -ne 'https://host.test/api/public/agent/download/polaris-agent-windows-x86_64.exe') { throw 'unexpected download URL' }
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutFile)) -ne [IO.Path]::GetFullPath($env:FIXTURE_INSTALL)) { throw 'download escaped fixture directory' }
  Copy-Item -LiteralPath $env:FIXTURE_BINARY -Destination $OutFile
}
function Invoke-RestMethod {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -ne 'https://host.test/api/public/agent/manifest') { throw 'unexpected manifest URL' }
  Get-Content -LiteralPath $env:FIXTURE_MANIFEST -Raw | ConvertFrom-Json
}
function Get-ScheduledTask { param($TaskName) if ($TaskName -ne 'fixture-agent') { throw 'unexpected task lookup' }; return $null }
function New-ScheduledTaskAction {
  param($Execute, $Argument)
  if ($Execute -ne (Join-Path $env:FIXTURE_INSTALL 'polaris-agent.exe')) { throw 'unexpected task executable' }
  Add-Content -LiteralPath $env:FIXTURE_SERVICE_LOG -Value "action $Execute $Argument"
  [pscustomobject]@{ Execute = $Execute; Argument = $Argument }
}
function New-ScheduledTaskTrigger {
  param([switch]$AtStartup, [switch]$AtLogOn, $User)
  Add-Content -LiteralPath $env:FIXTURE_SERVICE_LOG -Value "trigger startup=$AtStartup logon=$AtLogOn user=$User"
  [pscustomobject]@{ AtStartup = $AtStartup; AtLogOn = $AtLogOn }
}
function New-ScheduledTaskSettingsSet {
  param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $RestartCount, $RestartInterval, $ExecutionTimeLimit)
  [pscustomobject]@{ RestartCount = $RestartCount }
}
function New-ScheduledTaskPrincipal {
  param($UserId, $LogonType, $RunLevel)
  Add-Content -LiteralPath $env:FIXTURE_SERVICE_LOG -Value "principal $LogonType $RunLevel"
  [pscustomobject]@{ UserId = $UserId }
}
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  if ($TaskName -ne 'fixture-agent' -or $Action.Execute -ne (Join-Path $env:FIXTURE_INSTALL 'polaris-agent.exe')) { throw 'unexpected task registration' }
  Add-Content -LiteralPath $env:FIXTURE_SERVICE_LOG -Value "register $TaskName restart=$($Settings.RestartCount)"
}
function Start-ScheduledTask {
  param($TaskName)
  if ($TaskName -ne 'fixture-agent') { throw 'unexpected task start' }
  Add-Content -LiteralPath $env:FIXTURE_SERVICE_LOG -Value "start $TaskName"
}
function Unregister-ScheduledTask { throw 'unexpected task removal' }
function icacls {
  if ($args[0] -ne (Join-Path (Join-Path $env:LOCALAPPDATA 'polaris-agent') 'config.json')) { throw 'unexpected ACL path' }
  Add-Content -LiteralPath $env:FIXTURE_SERVICE_LOG -Value 'acl fixture'
}
function Start-Sleep { param($Seconds) }
if ($env:FIXTURE_FAIL_ACL -eq '1') { function New-Object { throw 'fixture ACL setup failed' } }
function Get-Process { param($Name) return $null }
foreach ($name in @('Invoke-WebRequest', 'Invoke-RestMethod', 'Get-ScheduledTask', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskSettingsSet', 'New-ScheduledTaskPrincipal', 'Register-ScheduledTask', 'Start-ScheduledTask', 'Unregister-ScheduledTask', 'icacls')) {
  if ((Get-Command $name).CommandType -ne 'Function') { throw "fixture command was not intercepted: $name" }
}
& $env:FIXTURE_INSTALLER -Endpoint 'https://host.test' -Token 'fixture-token' -Platform 'windows-x86_64' -Mode 'user' -InstallDir $env:FIXTURE_INSTALL -ServiceName 'fixture-agent' -NoRegisterCommand
exit $LASTEXITCODE
`);

  for (const scenario of ['bad-hash', 'success', 'acl-failure']) {
    const validHash = scenario !== 'bad-hash';
    const fixture = join(root, scenario);
    const install = join(fixture, 'install');
    const local = join(fixture, 'local');
    const cfgDir = join(local, 'polaris-agent');
    mkdirSync(install, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    const dest = join(install, 'polaris-agent.exe');
    const cfg = join(cfgDir, 'config.json');
    const oldBinary = Buffer.from('previous binary');
    const oldConfig = JSON.stringify({ endpoint: 'https://old.test', token: 'old-token', sample_interval: 5, report_interval: 60 });
    writeFileSync(dest, oldBinary);
    writeFileSync(cfg, oldConfig);
    writeFileSync(join(cfgDir, '.polaris-agent-managed'), `fixture-agent|${dest}`);
    const manifest = join(fixture, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ platforms: [{ key: 'windows-x86_64', sha256: validHash ? sha256(agent) : '0'.repeat(64) }] }));
    assertFixtureDirectory(install);
    const env = { ...windowsFixtureEnvironment(fixture, local, fixture), PROCESSOR_ARCHITECTURE: 'AMD64', FIXTURE_INSTALL: install, FIXTURE_BINARY: binary, FIXTURE_MANIFEST: manifest, FIXTURE_INSTALLER: installer, FIXTURE_AGENT_LOG: join(fixture, 'agent.log'), FIXTURE_SERVICE_LOG: join(fixture, 'services.log'), FIXTURE_FAIL_ACL: scenario === 'acl-failure' ? '1' : '0' };
    delete env.PROCESSOR_ARCHITEW6432;
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', wrapper], { env });
    const serviceLog = existsSync(env.FIXTURE_SERVICE_LOG) ? readFileSync(env.FIXTURE_SERVICE_LOG, 'utf8') : '';
    if (!validHash) {
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /sha256 mismatch/);
      assert.deepEqual(readFileSync(dest), oldBinary);
      assert.equal(readFileSync(cfg, 'utf8'), oldConfig);
      assert.equal(serviceLog, '');
      assert.equal(existsSync(env.FIXTURE_AGENT_LOG), false);
      assert.equal(readdirSync(install).filter(name => name.startsWith('.download-')).length, 0);
      continue;
    }
    if (scenario === 'acl-failure') {
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /fixture ACL setup failed/);
      assert.equal(readFileSync(cfg, 'utf8'), oldConfig);
      assert.equal(readdirSync(cfgDir).some(name => name.startsWith('.config-')), false);
      assert.doesNotMatch(serviceLog, /register|start/);
      continue;
    }
    requireSuccess(result);
    assert.deepEqual(readFileSync(dest), agent);
    assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).service_tier, 'A');
    const acl = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$acl=Get-Acl -LiteralPath $env:FIXTURE_CFG; if (-not $acl.AreAccessRulesProtected -or @($acl.Access | Where-Object IsInherited).Count -ne 0) { exit 1 }'], { env: { ...process.env, FIXTURE_CFG: cfg } });
    requireSuccess(acl);
    assert.match(readFileSync(env.FIXTURE_AGENT_LOG, 'utf8'), /record-installation .*--manager windows-task .*--mode user/);
    assert.match(serviceLog, /trigger startup=False logon=True/);
    assert.match(serviceLog, /principal Interactive Limited/);
    assert.match(serviceLog, /register fixture-agent restart=999/);
    assert.match(serviceLog, /start fixture-agent/);
  }
}

try {
  await posixInstallFixture();
  windowsInstallFixture();
} finally {
  assert.equal(realpathSync.native(temp), temp);
  rmSync(temp, { recursive: true, force: true });
}
console.log('PASS generated installers: verified replacement, isolated service selection and hash rejection');
