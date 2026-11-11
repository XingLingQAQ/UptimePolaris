// 在隔离夹具中验证按钮部署配置与命令。
// Check button-deployment configuration and commands in isolated fixtures.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configOption, wrangler } from '../scripts/wrangler-cli.mjs';

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
const toml = readFileSync(join(root, 'backends/worker/wrangler.toml'), 'utf8');
const tomlArray = key => JSON.parse(toml.match(new RegExp(`^${key}\\s*=\\s*(\\[[^\\n]+\\])`, 'm'))[1]);
assert.equal(config.assets.run_worker_first, true);
assert.match(toml, /^run_worker_first\s*=\s*true\s*$/m);
assert.match(readFileSync(join(root, 'backends/worker/cloudflare.config.ts'), 'utf8'), /runWorkerFirst:\s*true/);
assert.deepEqual(config.triggers.crons, tomlArray('crons'));
assert.deepEqual(config.compatibility_flags, tomlArray('compatibility_flags'));
assert.equal(config.name, 'uptime-polaris');
assert.equal(config.main, 'backends/worker/src/index.ts');
assert.equal(config.compatibility_date, '2025-01-01');
assert.deepEqual(config.vars, { PBKDF2_ITERATIONS: '3000' });
assert.equal(config.keep_vars, true);
assert.equal(config.assets.binding, 'ASSETS');
assert.equal(config.assets.directory, './public');
assert.equal(config.assets.not_found_handling, 'single-page-application');
assert.equal(config.assets.html_handling, 'auto-trailing-slash');
// Fork 和按钮部署由用户在控制台绑定资源，配置里不声明，部署时也不创建。
// Fork and button deployments bind resources in the dashboard; the config declares none and deploys create none.
assert.equal(config.d1_databases, undefined);
assert.equal(config.r2_buckets, undefined);
assert.equal(config.analytics_engine_datasets, undefined);
assert.equal(readFileSync(join(root, '.dev.vars.example'), 'utf8').trim(), 'ADMIN_TOKEN=');

for (const args of [['--config', 'custom.toml'], ['--config=custom.toml'], ['-c', 'custom.toml'], ['-c=custom.toml'], ['-ccustom.toml']]) {
  assert.equal(configOption(args).value, 'custom.toml');
  assert.deepEqual(wrangler(['dev', ...args])[1].slice(1), ['dev', ...args]);
}
assert.equal(configOption(['--', '-c', 'ignored']), null);
assert.deepEqual(wrangler(['dev'])[1].slice(-2), ['--config', join(root, 'backends/worker/wrangler.toml')]);
const localDefaults = [...(existsSync(join(root, '.dev.vars')) ? ['--env-file', join(root, '.dev.vars')] : []), '--persist-to', join(root, '.wrangler/state'), '--config', join(root, 'backends/worker/wrangler.toml')];
assert.deepEqual(wrangler(['dev', '--', '--config=ignored'])[1].slice(1), ['dev', ...localDefaults, '--', '--config=ignored']);

const tempRoot = realpathSync(tmpdir());
const temp = mkdtempSync(join(tempRoot, 'uptime-button-test-'));
const owner = randomUUID();
const log = join(temp, 'calls.jsonl');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const reset = () => writeFileSync(log, '');
const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete baseEnv[key];
// Run copied deployment scripts against logging npm and Cloudflare CLI stubs.
// 在临时副本中运行部署脚本，npm 和 Cloudflare CLI 由调用记录桩代替。
const run = (script, args = [], extra = {}, cwd = temp) => spawnSync(process.execPath, [join(temp, 'scripts', script), ...args], {
  cwd, encoding: 'utf8', env: { ...baseEnv, WORKERS_CI: '', npm_execpath: join(temp, 'fake-npm.cjs'), FIXTURE_LOG: log, ...extra },
});

try {
  write(join(temp, '.owner'), owner);
  mkdirSync(join(temp, 'backends/worker'), { recursive: true });
  for (const name of ['build.mjs', 'deploy.mjs', 'wrangler-cli.mjs', 'dev/dev-start.mjs']) {
    const target = join(temp, 'scripts', name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, 'scripts', name), target);
  }
  write(join(temp, 'wrangler.jsonc'), JSON.stringify(config));
  // PREFLIGHT_EXIT and FAKE_EXIT inject preflight and CLI failures to check early exit.
  // PREFLIGHT_EXIT 与 FAKE_EXIT 分别注入前置检查、CLI 失败，验证后续步骤及时停止。
  write(join(temp, 'scripts/deploy-preflight.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(['preflight'])+'\\n'); process.exit(Number(process.env.PREFLIGHT_EXIT || 0));");
  write(join(temp, 'scripts/dev/seed-dev.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(['seed', ...process.argv.slice(2)])+'\\n');");
  write(join(temp, 'scripts/dev/dev-runtime.mjs'), 'export async function startDevRuntime() { return { close: async () => {} }; }');
  write(join(temp, 'scripts/dev/live-demo-data.mjs'), 'export function demoSkipReason() { return true; } export const DEMO_IDS = { monitors: {}, groups: {}, tags: {}, channels: {} }; export function buildSeedStatements() { throw new Error("unexpected seed"); }');
  // FAKE_CHECK_ENV records npm environment handling on --prefix calls.
  // FAKE_CHECK_ENV 在 --prefix 调用时记录 npm 环境变量的清理与保留情况。
  const fake = "require('node:fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify([process.env.FAKE_KIND || 'npm', ...process.argv.slice(2)])+'\\n'); if(process.env.FAKE_CHECK_ENV && process.argv[2]==='--prefix') require('node:fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(['env',Object.keys(process.env).some(k=>k.toLowerCase()==='npm_config_allow_scripts'),process.env.npm_config_fund])+'\\n'); const configAt = process.argv.indexOf('--config'); if(process.env.FAKE_READ_CONFIG && configAt > 0) require('node:fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(['config', JSON.parse(require('node:fs').readFileSync(process.argv[configAt + 1], 'utf8'))])+'\\n'); process.exit(Number(process.env.FAKE_EXIT || 0));";
  write(join(temp, 'fake-npm.cjs'), fake);
  for (const name of ['wrangler', 'cf']) {
    write(join(temp, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin: { [name]: 'cli.cjs' } }));
    write(join(temp, 'node_modules', name, 'cli.cjs'), `process.env.FAKE_KIND=${JSON.stringify(name)}; ${fake}`);
  }
  const typescript = createRequire(import.meta.url).resolve('typescript');
  write(join(temp, 'node_modules/typescript/index.cjs'), `module.exports=require(${JSON.stringify(typescript)});`);
  write(join(temp, 'node_modules/typescript/package.json'), '{"main":"index.cjs"}');

  reset();
  assert.equal(run('build.mjs').status, 0);
  assert.deepEqual(calls(), [['npm', 'run', 'schema:build'], ['npm', 'run', 'frontend:build']]);
  reset();
  assert.equal(run('build.mjs', ['--example'], { WORKERS_CI: '1' }).status, 0);
  assert.deepEqual(calls(), [['npm', '--prefix', 'frontend', 'ci'], ['npm', 'run', 'schema:build'], ['npm', 'run', 'frontend:build', '--example']]);
  reset();
  assert.equal(run('build.mjs', [], { WORKERS_CI: '1', NPM_CONFIG_ALLOW_SCRIPTS: 'fixture', npm_config_fund: 'false', FAKE_CHECK_ENV: '1' }).status, 0);
  assert.deepEqual(calls()[1], ['env', false, 'false']);
  reset();
  assert.equal(run('build.mjs', [], { WORKERS_CI: '1', FAKE_EXIT: '7' }).status, 7);
  assert.deepEqual(calls(), [['npm', '--prefix', 'frontend', 'ci']]);

  reset();
  assert.equal(run('deploy.mjs', ['--dry-run']).status, 0);
  assert.deepEqual(calls(), [['preflight'], ['cf', 'deploy', '--dry-run']]);
  reset();
  assert.equal(run('deploy.mjs', ['--dry-run', '--secrets-file', '.secrets/production.json']).status, 0);
  assert.deepEqual(calls(), [['preflight'], ['cf', 'deploy', '--dry-run', '--secrets-file', join(temp, '.secrets/production.json')]]);
  reset();
  assert.equal(run('deploy.mjs', [], { PREFLIGHT_EXIT: '8' }).status, 8);
  assert.deepEqual(calls(), [['preflight']]);
  // Workers Builds 下用调用记录桩代替 Cloudflare API，验证部署保留控制台里的绑定。
  // Under Workers Builds, a logging stub replaces the Cloudflare API to check that deploys keep dashboard bindings.
  write(join(temp, 'fake-fetch.mjs'), "import { appendFileSync } from 'node:fs'; const routes = JSON.parse(process.env.FAKE_API || '{}'); globalThis.fetch = async (input, init = {}) => { const url = new URL(String(input)); const key = url.pathname + url.search; appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(['fetch', key, init.headers?.authorization ?? null]) + '\\n'); const [status, body] = routes[key] ?? [500, { success: false }]; return new Response(JSON.stringify(body), { status }); };");
  const settingsPath = name => `/client/v4/accounts/fixture-account/workers/scripts/${name}/settings`;
  const accountsPath = '/client/v4/accounts?per_page=50';
  const builds = (args, api, extra = {}) => run('deploy.mjs', args, {
    WORKERS_CI: '1', NODE_OPTIONS: `--import=${pathToFileURL(join(temp, 'fake-fetch.mjs')).href}`,
    CLOUDFLARE_API_TOKEN: 'fixture-token', CLOUDFLARE_ACCOUNT_ID: 'fixture-account', WRANGLER_CI_OVERRIDE_NAME: '', FAKE_API: JSON.stringify(api), ...extra,
  });
  const generated = join(temp, '.wrangler-builds.jsonc');
  const dashboard = { success: true, result: { bindings: [
    { type: 'd1', name: 'DB', id: '11111111-1111-4111-8111-111111111111' },
    { type: 'r2_bucket', name: 'THEMES', bucket_name: 'fixture-themes' },
    { type: 'analytics_engine', name: 'UPTIME', dataset: 'fixture_heartbeats' },
    { type: 'kv_namespace', name: 'DB_CACHE', namespace_id: 'unrelated' },
    { type: 'd1', name: 'OTHER', id: '22222222-2222-4222-8222-222222222222' },
    { type: 'secret_text', name: 'ADMIN_TOKEN' },
  ] } };

  // 首次部署时 Worker 还不存在，直接使用 wrangler.jsonc。 / On the first deploy the Worker does not exist, so wrangler.jsonc is used as is.
  reset();
  assert.equal(builds(['--dry-run'], { [settingsPath('uptime-polaris')]: [404, { success: false, errors: [{ code: 10007 }] }] }).status, 0);
  assert.deepEqual(calls(), [['fetch', settingsPath('uptime-polaris'), 'Bearer fixture-token'], ['wrangler', 'deploy', '--dry-run', '--config', join(temp, 'wrangler.jsonc')]]);

  // 控制台绑定写入生成的配置，部署后删除；Worker 名称取控制台上的名称。
  // Dashboard bindings go into a generated config that is removed afterwards; the Worker name comes from the dashboard.
  reset();
  assert.equal(builds([], { [settingsPath('uptimepolaris')]: [200, dashboard] }, { WRANGLER_CI_OVERRIDE_NAME: 'uptimepolaris', FAKE_READ_CONFIG: '1' }).status, 0);
  assert.deepEqual(calls(), [
    ['fetch', settingsPath('uptimepolaris'), 'Bearer fixture-token'],
    ['wrangler', 'deploy', '--config', generated],
    ['config', {
      ...config,
      d1_databases: [{ binding: 'DB', database_id: '11111111-1111-4111-8111-111111111111' }],
      r2_buckets: [{ binding: 'THEMES', bucket_name: 'fixture-themes' }],
      analytics_engine_datasets: [{ binding: 'UPTIME', dataset: 'fixture_heartbeats' }],
    }],
  ]);
  assert.equal(existsSync(generated), false);

  // 没有账号 ID 时使用令牌下唯一的账号。 / Without an account ID, use the token's only account.
  reset();
  assert.equal(builds(['--dry-run'], { [accountsPath]: [200, { success: true, result: [{ id: 'fixture-account' }] }], [settingsPath('uptime-polaris')]: [404, { success: false }] }, { CLOUDFLARE_ACCOUNT_ID: '' }).status, 0);
  assert.deepEqual(calls().map(call => call.slice(0, 2)), [['fetch', accountsPath], ['fetch', settingsPath('uptime-polaris')], ['wrangler', 'deploy']]);

  // 读不到绑定时不部署，避免删掉控制台里的绑定。 / Never deploy without reading the bindings, so dashboard bindings are not removed.
  for (const [api, extra] of [
    [{ [settingsPath('uptime-polaris')]: [500, { success: false }] }, {}],
    [{ [settingsPath('uptime-polaris')]: [403, { success: false }] }, {}],
    [{ [settingsPath('uptime-polaris')]: [200, { success: true, result: { bindings: [{ type: 'd1', name: 'DB' }] } }] }, {}],
    [{}, { CLOUDFLARE_API_TOKEN: '' }],
    [{ [accountsPath]: [200, { success: true, result: [{ id: 'one' }, { id: 'two' }] }] }, { CLOUDFLARE_ACCOUNT_ID: '' }],
  ]) {
    reset();
    assert.notEqual(builds([], api, extra).status, 0);
    assert.equal(calls().some(call => call[0] === 'wrangler'), false);
    assert.equal(existsSync(generated), false);
  }
  for (const override of [['--config=other.toml'], ['-c', 'other.toml'], ['--env=production'], ['-e', 'production'], ['--name', 'other'], ['-n', 'other'], ['--var', 'DATABASE_TYPE:postgres'], ['--'], ['--unknown']]) {
    reset();
    assert.equal(builds(override, {}).status, 1);
    assert.deepEqual(calls(), []);
  }
  reset();
  assert.equal(builds([], { [settingsPath('uptime-polaris')]: [200, dashboard] }, { FAKE_EXIT: '9' }).status, 9);
  assert.equal(calls()[1][0], 'wrangler');
  assert.equal(existsSync(generated), false);

  for (const args of [['--config', 'custom.toml'], ['--config=custom.toml'], ['-c', 'custom.toml'], ['-c=custom.toml'], ['-ccustom.toml']]) {
    reset();
    assert.equal(run('dev/dev-start.mjs', [...args, '--persist-to=fixture'], {}, temp).status, 0);
    assert.deepEqual(calls().find(call => call[0] === 'seed'), ['seed', '--quiet', '--persist-to=fixture', '--config=custom.toml']);
    assert.deepEqual(calls().find(call => call[0] === 'wrangler').slice(1, 2 + args.length), ['dev', ...args]);
  }
  for (const args of [['--env', 'staging'], ['--env=staging'], ['-e', 'staging'], ['-e=staging'], ['-estaging']]) {
    reset();
    assert.equal(run('dev/dev-start.mjs', args).status, 0);
    assert.deepEqual(calls().find(call => call[0] === 'seed'), ['seed', '--quiet', '--env=staging']);
  }
  reset();
  assert.equal(run('dev/dev-start.mjs', [], {}, temp).status, 0);
  assert.deepEqual(calls().find(call => call[0] === 'seed'), ['seed', '--quiet']);
  assert.deepEqual(calls().find(call => call[0] === 'wrangler').slice(-2), ['--config', join(temp, 'backends/worker/wrangler.toml')]);
  for (const args of [['-c'], ['--config='], ['--persist-to'], ['--persist-to='], ['--env'], ['-e='], ['-c', 'one', '--config=two'], ['-e', 'one', '--env=two']]) {
    reset();
    assert.notEqual(run('dev/dev-start.mjs', args, {}, temp).status, 0);
    assert.deepEqual(calls(), []);
  }
  reset();
  assert.equal(run('dev/dev-start.mjs', ['--', '--config=ignored']).status, 0);
  assert.deepEqual(calls().find(call => call[0] === 'seed'), ['seed', '--quiet']);
  const server = calls().find(call => call[0] === 'wrangler');
  assert(server.indexOf('--config') < server.indexOf('--'));

  copyFileSync(join(root, 'scripts/dev/seed-dev.mjs'), join(temp, 'scripts/dev/seed-dev.mjs'));
  for (const args of [['--config', 'custom.toml'], ['--config=custom.toml'], ['-c', 'custom.toml'], ['-c=custom.toml'], ['-ccustom.toml']]) {
    reset();
    assert.equal(run('dev/seed-dev.mjs', [...args, '-e', 'staging', '--persist-to', 'fixture']).status, 0);
    assert.deepEqual(calls()[0].slice(1), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to=fixture', '--config=custom.toml', '--env=staging']);
  }
  for (const args of [['-c'], ['--config='], ['--persist-to'], ['-e='], ['-c', 'one', '--config=two'], ['-e', 'one', '--env=two']]) {
    reset();
    assert.notEqual(run('dev/seed-dev.mjs', args).status, 0);
    assert.deepEqual(calls(), []);
  }
  const realNpm = process.env.npm_execpath;
  const npmVersion = realNpm ? JSON.parse(readFileSync(resolve(dirname(realNpm), '../package.json'), 'utf8')).version : '';
  // npm 12+: use real npm with cached local packages to test install-script policy.
  // npm 12+ 使用真实 npm 与已缓存的本地包，验证安装脚本许可策略。
  if (Number(npmVersion.split('.')[0]) >= 12) {
  const lifecycle = join(temp, 'lifecycle');
  const frontend = join(lifecycle, 'frontend');
  const npmrc = join(lifecycle, 'user.npmrc');
  const markers = join(lifecycle, 'markers');
  const npmEnv = { ...process.env, WORKERS_CI: '1', npm_config_userconfig: npmrc, npm_config_cache: join(lifecycle, 'cache'), npm_config_offline: 'true', npm_config_logs_max: '0', npm_config_fund: 'false', FIXTURE_MARKERS: markers };
  for (const key of Object.keys(npmEnv)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete npmEnv[key];
  write(npmrc, 'allow-scripts=fixture-approved\n');
  write(join(lifecycle, 'scripts/build.mjs'), readFileSync(join(root, 'scripts/build.mjs'), 'utf8'));
  write(join(lifecycle, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node scripts/build.mjs', 'schema:build': 'node -v', 'frontend:build': 'npm --prefix frontend run build' } }));
  mkdirSync(markers, { recursive: true });
  for (const [name, marker] of [['fixture-approved', 'approved'], ['fixture-blocked', 'blocked']]) {
    const directory = join(lifecycle, name);
    write(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { install: 'node install.cjs' } }));
    write(join(directory, 'install.cjs'), `require('node:fs').writeFileSync(require('node:path').join(process.env.FIXTURE_MARKERS, ${JSON.stringify(marker)}), process.env.npm_config_fund || '');`);
    const packed = spawnSync(process.execPath, [realNpm, 'pack', '--offline', '--pack-destination', lifecycle], { cwd: directory, env: npmEnv, encoding: 'utf8', windowsHide: true });
    assert.equal(packed.status, 0, packed.stderr);
    const cached = spawnSync(process.execPath, [realNpm, 'cache', 'add', join(lifecycle, `${name}-1.0.0.tgz`), '--offline'], { cwd: directory, env: npmEnv, encoding: 'utf8', windowsHide: true });
    assert.equal(cached.status, 0, cached.stderr);
  }
  const fixturePackage = { name: 'fixture-frontend', version: '1.0.0', private: true, scripts: { build: 'node -v' }, dependencies: { 'fixture-approved': 'file:../fixture-approved-1.0.0.tgz', 'fixture-blocked': 'file:../fixture-blocked-1.0.0.tgz' }, allowScripts: { 'fixture-approved@1.0.0': true, 'fixture-blocked@1.0.0': false } };
  write(join(frontend, 'package.json'), JSON.stringify(fixturePackage));
  const lock = spawnSync(process.execPath, [realNpm, '--prefix', frontend, 'install', '--package-lock-only', '--offline'], { cwd: lifecycle, env: npmEnv, encoding: 'utf8', windowsHide: true });
  assert.equal(lock.status, 0, lock.stderr);
  const fixtureLock = JSON.parse(readFileSync(join(frontend, 'package-lock.json'), 'utf8'));
  assert.equal(fixtureLock.packages['node_modules/fixture-approved'].hasInstallScript, true);
  for (const name of ['fixture-approved', 'fixture-blocked']) {
    fixturePackage.dependencies[name] = '1.0.0';
    fixtureLock.packages[''].dependencies[name] = '1.0.0';
    fixtureLock.packages[`node_modules/${name}`].resolved = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`;
  }
  write(join(frontend, 'package.json'), JSON.stringify(fixturePackage));
  write(join(frontend, 'package-lock.json'), JSON.stringify(fixtureLock));
  const build = spawnSync(process.execPath, [realNpm, 'run', 'build'], { cwd: lifecycle, env: npmEnv, encoding: 'utf8', windowsHide: true });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(existsSync(join(markers, 'approved')), true, build.stderr);
  assert.equal(readFileSync(join(markers, 'approved'), 'utf8'), 'false');
  assert.equal(existsSync(join(markers, 'blocked')), false);
  } else console.log('SKIP npm 12 install policy fixture');
  console.log('PASS isolated Cloudflare build, deploy, configuration and local seed fixtures');
} finally {
  // Check ownership and directory links before cleanup; Windows also checks reparse points.
  // 递归清理前检查归属与目录链接；Windows 侧另行检查重解析点。
  try {
  const physical = realpathSync(temp);
  if (relative(tempRoot, dirname(physical)) !== '' || !basename(physical).startsWith('uptime-button-test-') || relative(temp, physical) !== '') throw new Error('Refusing to remove an unowned fixture');
  const pending = [temp];
  while (pending.length) {
    const path = pending.pop();
    const info = lstatSync(path);
    const child = relative(temp, path);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || relative(path, realpathSync(path)) !== '') throw new Error('Refusing to remove a fixture containing a link or unexpected path');
    if (info.isDirectory()) pending.push(...readdirSync(path).map(name => join(path, name)));
  }
  if (readFileSync(join(temp, '.owner'), 'utf8') !== owner) throw new Error('Refusing to remove an unowned fixture');
  if (process.platform === 'win32') {
    const cleanup = `
$ErrorActionPreference = 'Stop'
$base = (Get-Item -Force -LiteralPath $env:FIXTURE_TEMP_ROOT).FullName
$fixture = (Get-Item -Force -LiteralPath $env:FIXTURE_DIRECTORY).FullName
if (-not [IO.Path]::IsPathRooted($base) -or -not [IO.Path]::IsPathRooted($fixture)) { throw 'Fixture paths must be absolute' }
$ancestor = $base
while ($ancestor) {
  $item = Get-Item -Force -LiteralPath $ancestor
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fixture ancestor is a reparse point' }
  $ancestor = [IO.Path]::GetDirectoryName($item.FullName)
}
if (-not [string]::Equals([IO.Path]::GetDirectoryName($fixture), $base, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($fixture).StartsWith('uptime-button-test-')) { throw 'Invalid fixture directory' }
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($fixture)
while ($pending.Count -gt 0) {
  $path = $pending.Pop()
  $item = Get-Item -Force -LiteralPath $path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fixture contains a reparse point' }
  $actual = $item.FullName
  if (-not [string]::Equals($actual, $fixture, [StringComparison]::OrdinalIgnoreCase) -and -not $actual.StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture path escapes its directory' }
  if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -Force -LiteralPath $path) { $pending.Push($child.FullName) } }
}
if ([IO.File]::ReadAllText((Join-Path $fixture '.owner')) -cne $env:FIXTURE_OWNER) { throw 'Invalid fixture owner' }
Remove-Item -LiteralPath $fixture -Recurse -Force
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], {
      env: { ...process.env, FIXTURE_TEMP_ROOT: tempRoot, FIXTURE_DIRECTORY: temp, FIXTURE_OWNER: owner },
      encoding: 'utf8', windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`Refusing to remove fixture: ${result.error?.message ?? result.stderr}`);
  } else rmSync(temp, { recursive: true, force: true });
  console.log('PASS owned fixture cleanup');
  } catch (error) {
    console.error(`Retained fixture: ${temp}; owner: ${owner}`);
    throw error;
  }
}
