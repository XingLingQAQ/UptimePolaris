import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { wrangler } from './wrangler-cli.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

if (process.env.WORKERS_CI === '1') {
  if (args.some(arg => arg !== '--dry-run')) {
    throw new Error('Workers Builds deploy accepts only --dry-run; deployment configuration must come from wrangler.jsonc.');
  }
  const ts = createRequire(import.meta.url)('typescript');
  const path = resolve(root, 'wrangler.jsonc');
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  const databases = parsed.config?.d1_databases;
  const db = Array.isArray(databases) && databases.length === 1 && databases[0]?.binding === 'DB' ? databases[0] : null;
  if (parsed.error || !db || typeof db.database_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id) || ['00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000000'].includes(db.database_id.toLowerCase())) {
    throw new Error('Workers Builds requires a provisioned DB database_id in wrangler.jsonc before deployment.');
  }
  const deploy = spawnSync(...wrangler(['deploy', ...args, '--config', path]), {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
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
