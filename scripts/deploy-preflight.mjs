import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function configSections(config) {
  const sections = [{ name: '', values: new Map() }];
  let current = sections[0];
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (header) {
      current = { name: header[1].trim(), values: new Map() };
      sections.push(current);
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const quoted = assignment[2].match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    let value = null;
    if (quoted) {
      try {
        value = quoted[1].startsWith('"') ? JSON.parse(quoted[1]) : quoted[1].slice(1, -1);
      } catch { }
    }
    current.values.set(assignment[1], value);
  }
  return sections;
}

export function validateConfigBindings(config) {
  const sections = configSections(config);
  const first = (name) => sections.find((section) => section.name === name)?.values ?? new Map();
  const all = (name) => sections.filter((section) => section.name === name).map((section) => section.values);
  const errors = [];
  const vars = first('vars');
  const backend = vars.has('DATABASE_TYPE') ? vars.get('DATABASE_TYPE') : 'd1';
  const root = first('');
  const assets = first('assets');
  if (!root.get('name')) errors.push('backends/worker/wrangler.toml must provide a Worker name');
  if (!['src/index.ts'].includes(root.get('main'))) errors.push('backends/worker/wrangler.toml must point at backends/worker/src/index.ts');
  if (assets.get('binding') !== 'ASSETS' || !['../../public'].includes(assets.get('directory'))) {
    errors.push('backends/worker/wrangler.toml must bind the built public/ assets as ASSETS');
  }
  if (!['d1', 'postgres'].includes(backend)) errors.push(`unsupported DATABASE_TYPE: ${String(backend)}`);

  const d1 = all('d1_databases');
  if (backend !== 'postgres' && !d1.some((entry) => entry.get('binding') === 'DB')) {
    errors.push('D1 backend requires a d1_databases binding named DB');
  }
  for (const entry of d1) {
    if (!entry.get('binding') || !entry.get('database_name') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.get('database_id') ?? '')) {
      errors.push('each declared D1 database requires binding, database_name and a valid database_id');
    }
  }
  for (const [section, resource] of [['r2_buckets', 'bucket_name'], ['analytics_engine_datasets', 'dataset']]) {
    for (const entry of all(section)) {
      if (!entry.get('binding') || !entry.get(resource)) errors.push(`each declared ${section} requires binding and ${resource}`);
    }
  }
  const bindings = new Set(['ASSETS']);
  for (const name of ['d1_databases', 'r2_buckets', 'analytics_engine_datasets']) {
    for (const entry of all(name)) {
      const binding = entry.get('binding');
      if (binding && bindings.has(binding)) errors.push(`duplicate binding: ${binding}`);
      if (binding) bindings.add(binding);
    }
  }
  return { backend, errors, themes: bindings.has('THEMES'), analytics: bindings.has('UPTIME') };
}

function runPreflight() {
  const root = resolve(import.meta.dirname, '..');
  const config = readFileSync(resolve(root, 'backends/worker/wrangler.toml'), 'utf8');
  const inventory = validateConfigBindings(config);
  const errors = [...inventory.errors];
  const d1Files = readdirSync(resolve(root, 'database/schema/d1')).filter((name) => name.endsWith('.sql')).sort();
  const pgFiles = readdirSync(resolve(root, 'database/schema/postgres')).filter((name) => name.endsWith('.postgres.sql')).sort();
  if (d1Files.length === 0 || pgFiles.length === 0) errors.push('both D1 and Postgres migration sets must be present');
  for (const file of pgFiles) {
    if (readFileSync(resolve(root, 'database/schema/postgres', file), 'utf8').includes('?')) errors.push(`${file} contains a raw question-mark placeholder`);
  }
  const expected = [...readFileSync(resolve(root, 'backends/worker/src/lib/db/migrate.ts'), 'utf8').matchAll(/'(\d{4}_[^']+\.postgres\.sql)'/g)].map((match) => match[1]);
  if (JSON.stringify(expected) !== JSON.stringify(pgFiles)) errors.push('runtime Postgres migration probe and database/schema/postgres inventory differ');
  if (errors.length) {
    for (const error of errors) console.error(`[preflight] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[preflight] backend=${inventory.backend}, themes=${inventory.themes ? 'R2' : 'builtin'}, AE=${inventory.analytics ? 'declared' : 'disabled'}`);
  if (process.argv.includes('--validate-only')) {
    console.log(`[preflight] config and ${d1Files.length} D1 / ${pgFiles.length} Postgres migrations validated`);
    return;
  }
  for (const args of [['run', 'typecheck'], ['run', 'build']]) {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: root, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32',
    });
  }
  if (!statSync(resolve(root, 'public/index.html'), { throwIfNoEntry: false })?.isFile()) throw new Error('UI build did not produce public/index.html');
  console.log('[preflight] local build and binding/migration checks passed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runPreflight();
