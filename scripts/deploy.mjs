import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { wrangler } from './wrangler-cli.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

// wrangler.jsonc 不声明资源绑定，用户在控制台绑定；这里列出部署时要保留的绑定名和类型。
// wrangler.jsonc declares no resource bindings because users add them in the dashboard; these are the ones a deploy keeps.
const DASHBOARD_BINDINGS = { DB: 'd1', THEMES: 'r2_bucket', UPTIME: 'analytics_engine' };
const API = 'https://api.cloudflare.com/client/v4';

async function cloudflare(path, token) {
  const response = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * wrangler deploy 会用配置文件覆盖 Worker 的绑定，控制台添加的 D1/R2 会被删掉。部署前读出这些绑定；
 * 读不到时停止部署，不冒删除绑定的风险。
 * wrangler deploy replaces the Worker's bindings with the config file's, dropping D1/R2 added in the dashboard.
 * Read them before deploying, and stop rather than deploy without them when they cannot be read.
 */
async function dashboardBindings(worker, configuredAccount) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set; cannot read the Worker bindings that this deploy must keep.');
  let account = process.env.CLOUDFLARE_ACCOUNT_ID || configuredAccount;
  if (!account) {
    const accounts = await cloudflare('/accounts?per_page=50', token);
    const list = accounts.body?.success ? accounts.body.result : null;
    if (!Array.isArray(list) || list.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID in the Workers Builds variables so the deploy can read the Worker bindings.');
    account = list[0].id;
  }
  const settings = await cloudflare(`/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(worker)}/settings`, token);
  // 首次部署时 Worker 还不存在，没有需要保留的绑定。 / On the first deploy the Worker does not exist yet, so there is nothing to keep.
  if (settings.status === 404) return [];
  const bindings = settings.body?.success ? settings.body.result?.bindings : null;
  if (!Array.isArray(bindings)) throw new Error(`Could not read the bindings of Worker ${worker} (HTTP ${settings.status}); deployment stopped so they are not removed.`);
  return bindings.filter(binding => DASHBOARD_BINDINGS[binding.name] === binding.type);
}

function bindingConfig(bindings) {
  const config = {};
  for (const binding of bindings) {
    if (binding.type === 'd1') {
      if (typeof binding.id !== 'string' || !binding.id) throw new Error(`D1 binding ${binding.name} has no database ID.`);
      (config.d1_databases ??= []).push({ binding: binding.name, database_id: binding.id });
    } else if (binding.type === 'r2_bucket') {
      (config.r2_buckets ??= []).push({ binding: binding.name, bucket_name: binding.bucket_name, ...(binding.jurisdiction ? { jurisdiction: binding.jurisdiction } : {}) });
    } else {
      (config.analytics_engine_datasets ??= []).push({ binding: binding.name, dataset: binding.dataset });
    }
  }
  return config;
}

if (process.env.WORKERS_CI === '1') {
  if (args.some(arg => arg !== '--dry-run')) {
    throw new Error('Workers Builds deploy accepts only --dry-run; deployment configuration must come from wrangler.jsonc.');
  }
  const ts = createRequire(import.meta.url)('typescript');
  const path = resolve(root, 'wrangler.jsonc');
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error || typeof parsed.config?.name !== 'string') throw new Error('wrangler.jsonc must be valid and name the Worker.');
  // Workers Builds 用控制台上的 Worker 名称覆盖配置里的 name。 / Workers Builds overrides the config name with the dashboard Worker name.
  const worker = process.env.WRANGLER_CI_OVERRIDE_NAME || parsed.config.name;
  const kept = await dashboardBindings(worker, parsed.config.account_id);

  // 生成的配置放在仓库根目录，main 和 assets 的相对路径保持不变。
  // The generated config sits in the repository root so relative main and assets paths still resolve.
  const generated = kept.length ? resolve(root, '.wrangler-builds.jsonc') : null;
  if (generated) {
    console.log(`[deploy] keeping dashboard bindings: ${kept.map(binding => `${binding.name} (${binding.type})`).join(', ')}`);
    writeFileSync(generated, JSON.stringify({ ...parsed.config, ...bindingConfig(kept) }, null, 2) + '\n');
  }
  const deploy = spawnSync(...wrangler(['deploy', ...args, '--config', generated ?? path]), {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (generated) rmSync(generated, { force: true });
  if (deploy.error) throw deploy.error;
  process.exit(deploy.status ?? 1);
}

const preflight = spawnSync(process.execPath, ['scripts/deploy-preflight.mjs'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (preflight.error) throw preflight.error;
if (preflight.status !== 0) process.exit(preflight.status ?? 1);

const require = createRequire(import.meta.url);
const manifest = require('cf/package.json');
const cli = resolve(dirname(require.resolve('cf/package.json')), manifest.bin.cf);
const deployArgs = args.map((arg, index) => {
  for (const name of ['--secrets-file', '--persist-to']) {
    if (arg.startsWith(`${name}=`)) return `${name}=${resolve(process.cwd(), arg.slice(name.length + 1))}`;
    if (args[index - 1] === name) return resolve(process.cwd(), arg);
  }
  return arg;
});
const deploy = spawnSync(process.execPath, [cli, 'deploy', ...deployArgs], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (deploy.error) throw deploy.error;
process.exit(deploy.status ?? 1);
