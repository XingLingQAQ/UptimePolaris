import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { configOption, envOption, persistOption, wrangler } from '../wrangler-cli.mjs';
import { buildSeedStatements, DEMO_IDS, demoSkipReason } from './live-demo-data.mjs';

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const valueOf = prefix => args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
const quiet = has('--quiet');
const commonArgs = [];
for (const [name, selected] of [['--persist-to', persistOption(args)], ['--config', configOption(args)], ['--env', envOption(args)]]) {
  if (!selected) continue;
  if (selected.duplicate || !selected.value || selected.value.startsWith('-')) throw new Error(`Provide one value after ${name}`);
  commonArgs.push(`${name}=${selected.value}`);
}
if (args.some(arg => arg === '--remote' || arg.startsWith('--remote='))) throw new Error('Demo configuration is local-only; remote seeding is not supported');

function execute(statements) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'uptime-polaris-seed-'));
  const owner = randomUUID();
  writeFileSync(join(directory, '.owner'), owner);
  const file = join(directory, 'demo.sql');
  writeFileSync(file, statements.map(statement => statement.replace(/\s+/g, ' ').trim()).join('\n'), 'utf8');
  try {
    const output = execFileSync(...wrangler(['d1', 'execute', 'DB', '--local', ...commonArgs, `--file=${file}`, '--json']), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const start = output.search(/[\[{]/);
    if (start < 0) throw new Error('Wrangler did not return JSON');
    const parsed = JSON.parse(output.slice(start));
    return (Array.isArray(parsed) ? parsed : [parsed]).map(batch => { if (batch.error) throw new Error(String(batch.error)); return batch.results ?? []; });
  } finally {
    const target = realpathSync(directory);
    const child = relative(realpathSync(tmpdir()), target);
    if (!child.startsWith('uptime-polaris-seed-') || child.includes(sep) || readFileSync(join(target, '.owner'), 'utf8') !== owner) throw new Error('Refusing to remove an unowned seed directory');
    rmSync(target, { recursive: true, force: true });
  }
}

const quote = value => `'${value.replaceAll("'", "''")}'`;
const monitorIds = Object.values(DEMO_IDS.monitors).map(quote).join(',');
const groups = Object.values(DEMO_IDS.groups).map(quote).join(',');
const tags = Object.values(DEMO_IDS.tags).map(quote).join(',');
const channels = Object.values(DEMO_IDS.channels).map(quote).join(',');
const configurationQueries = [
  `SELECT * FROM agents WHERE id IN (${monitorIds}) ORDER BY id;`,
  `SELECT * FROM monitors WHERE id IN (${monitorIds}) ORDER BY id;`,
  `SELECT * FROM monitor_groups WHERE id IN (${groups}) ORDER BY id;`,
  `SELECT * FROM tags WHERE id IN (${tags}) ORDER BY id;`,
  `SELECT * FROM monitor_tags WHERE monitor_id IN (${monitorIds}) ORDER BY monitor_id,tag_id;`,
  `SELECT * FROM notifications WHERE id IN (${channels}) ORDER BY id;`,
  `SELECT * FROM notification_groups WHERE notification_id IN (${channels}) ORDER BY notification_id,group_id;`,
];
const digest = () => createHash('sha256').update(JSON.stringify(execute(configurationQueries))).digest('hex');

try {
  if (!has('--no-migrate')) execFileSync(...wrangler(['d1', 'migrations', 'apply', 'DB', '--local', ...commonArgs]), { stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
  const skip = demoSkipReason();
  if (skip) console.log(`[seed] Demo configuration skipped (${skip}); migrations are available.`);
  else {
    const at = Number(valueOf('--at=') ?? Math.floor(Date.now() / 1000));
    const { statements, summary } = buildSeedStatements(at);
    execute(statements);
    console.log(`[seed] ${summary.monitors} local monitor examples configured; no status or history readings generated.`);
    console.log('[seed] Normal scheduled checks, Push heartbeats, and the reporting simulator produce the observations.');
    if (!quiet) {
      const count = execute([`SELECT COUNT(*) AS n FROM machine_live WHERE agent_id IN (${monitorIds});`, `SELECT COUNT(*) AS n FROM events WHERE monitor_id IN (${monitorIds});`]);
      console.log(`[seed] Existing observations preserved after migration: ${count[0]?.[0]?.n ?? 0} Agent rows, ${count[1]?.[0]?.n ?? 0} events.`);
    }
    if (has('--verify')) {
      const before = digest();
      execute(buildSeedStatements(at).statements);
      if (digest() !== before) throw new Error('Seeding changed example configuration on the second run');
      console.log('[seed] Configuration is idempotent; telemetry is managed by normal runtime requests.');
    }
  }
} catch (error) {
  console.error(`[seed] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
